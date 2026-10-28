// Registrierung, Anmeldung, Abmeldung, Passwort zurücksetzen, Demo-Zugang.
import { HttpError, badRequest, readJson, serializeCookie, deviceLabel } from '../lib/http.js';
import {
  hashPassword, verifyPassword, passwordProblem, normalizeEmail, isValidEmail, createSession,
  SESSION_COOKIE, sha256, randomToken, newId, logSecurityEvent,
} from '../lib/security.js';
import { featureStatus } from '../config.js';
import { userSettings } from '../domain/reminders.js';
import { createDemoAccount, demoSamplePdf } from '../demo/seed.js';
import { todayIn } from '../../public/js/shared/dates.js';

export function serializeUser(user) {
  return {
    id: user.id,
    email: user.is_demo ? null : user.email,
    name: user.name,
    timezone: user.timezone,
    settings: userSettings(user),
    aiConsent: user.ai_consent,
    isDemo: Boolean(user.is_demo),
    createdAt: user.created_at,
  };
}

export function setSessionCookie(res, config, token, maxAge) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge, secure: config.secureCookies }));
}

export function clearSessionCookie(res, config) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: config.secureCookies }));
}

export function registerAuthRoutes(router, ctx) {
  const { db, config, limiter, mailer } = ctx;
  let dummyHash = null;
  const getDummyHash = async () => (dummyHash ||= await hashPassword('dummy-passwort-für-zeitausgleich', config.passwordHashCost));

  router.get('/api/status', () => ({
    features: featureStatus(config),
    demoEnabled: config.demo.enabled,
    ai: { enabled: config.ai.enabled, provider: config.ai.providerLabel, model: config.ai.enabled ? config.ai.model : null },
    push: { enabled: config.push.enabled, publicKey: config.push.enabled ? config.push.publicKey : null },
    mail: { enabled: config.smtp.enabled, simulated: !config.smtp.enabled && !config.isProduction },
    limits: {
      maxFileMb: Math.round(config.limits.maxFileBytes / 1024 / 1024),
      maxPages: config.limits.maxFilesPerLetter,
    },
    privacyContact: config.privacyContact || null,
    production: config.isProduction,
  }), { auth: false });

  router.post('/api/auth/register', async (req, res, { ip }) => {
    limiter.hit(`register:${ip}`, 10, 3600_000, 'Zu viele Registrierungen von diesem Gerät. Bitte später erneut versuchen.');
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const name = String(body.name || '').trim().slice(0, 80) || null;
    if (!isValidEmail(email)) throw badRequest('Bitte geben Sie eine gültige E-Mail-Adresse ein.', { field: 'email' });
    const problem = passwordProblem(body.password, email);
    if (problem) throw badRequest(problem, { field: 'password' });
    if (body.acceptPrivacy !== true) throw badRequest('Bitte bestätigen Sie, dass Sie die Datenschutzhinweise gelesen haben.', { field: 'acceptPrivacy' });
    if (db.get('SELECT id FROM users WHERE email = ?', email)) {
      throw new HttpError(409, 'Für diese E-Mail-Adresse gibt es bereits ein Konto. Bitte melden Sie sich an oder setzen Sie Ihr Passwort zurück.', { field: 'email' });
    }
    const now = new Date().toISOString();
    const id = newId();
    db.run(
      `INSERT INTO users (id, email, name, password_hash, privacy_accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, email, name, await hashPassword(body.password, config.passwordHashCost), now, now, now
    );
    logSecurityEvent(db, id, 'registriert');
    const session = createSession(db, id, deviceLabel(req.headers['user-agent']));
    setSessionCookie(res, config, session.token, session.maxAge);
    return { user: serializeUser(db.get('SELECT * FROM users WHERE id = ?', id)) };
  }, { auth: false });

  router.post('/api/auth/login', async (req, res, { ip }) => {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    limiter.hit(`login-ip:${ip}`, 30, 15 * 60_000);
    if (!limiter.check(`login-email:${email}`, 8)) {
      throw new HttpError(429, 'Zu viele fehlgeschlagene Anmeldeversuche für dieses Konto. Bitte warten Sie 15 Minuten oder setzen Sie Ihr Passwort zurück.');
    }
    const user = email ? db.get('SELECT * FROM users WHERE email = ? AND is_demo = 0', email) : null;
    const ok = user?.password_hash
      ? await verifyPassword(password, user.password_hash)
      : (await verifyPassword(password, await getDummyHash()), false);
    if (!ok) {
      limiter.hit(`login-email:${email}`, 1000, 15 * 60_000);
      if (user) logSecurityEvent(db, user.id, 'anmeldung_fehlgeschlagen');
      throw new HttpError(401, 'E-Mail-Adresse oder Passwort ist falsch.');
    }
    limiter.reset(`login-email:${email}`);
    logSecurityEvent(db, user.id, 'angemeldet');
    const session = createSession(db, user.id, deviceLabel(req.headers['user-agent']));
    setSessionCookie(res, config, session.token, session.maxAge);
    return { user: serializeUser(user) };
  }, { auth: false });

  router.post('/api/auth/logout', (req, res, { sessionId }) => {
    if (sessionId) db.run('DELETE FROM sessions WHERE id = ?', sessionId);
    clearSessionCookie(res, config);
    return { ok: true };
  }, { auth: false });

  router.post('/api/auth/forgot', async (req, res, { ip }) => {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    limiter.hit(`forgot-ip:${ip}`, 10, 3600_000);
    if (!isValidEmail(email)) throw badRequest('Bitte geben Sie eine gültige E-Mail-Adresse ein.', { field: 'email' });
    limiter.hit(`forgot-email:${email}`, 3, 3600_000, 'Für diese Adresse wurden bereits mehrere Links angefordert. Bitte warten Sie eine Stunde.');
    const user = db.get('SELECT * FROM users WHERE email = ? AND is_demo = 0', email);
    if (user) {
      const token = randomToken(32);
      const expires = new Date(Date.now() + 60 * 60_000).toISOString();
      db.run('DELETE FROM password_resets WHERE user_id = ?', user.id);
      db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), user.id, expires);
      const link = `${config.baseUrl}/#/passwort-neu?token=${token}`;
      await mailer.send({
        to: user.email,
        subject: 'BriefPilot: Passwort zurücksetzen',
        text: `Guten Tag,\n\nSie haben angefordert, Ihr BriefPilot-Passwort zurückzusetzen. Öffnen Sie dazu diesen Link (gültig für 60 Minuten):\n\n${link}\n\nWenn Sie das nicht waren, können Sie diese E-Mail ignorieren. Ihr Passwort bleibt dann unverändert.`,
        devNote: `[Entwicklungsmodus] Link zum Zurücksetzen: ${link}`,
      });
      logSecurityEvent(db, user.id, 'passwort_link_angefordert');
    }
    // Immer dieselbe Antwort, damit niemand herausfinden kann, ob ein Konto existiert
    return { ok: true, mail: config.smtp.enabled ? 'echt' : config.isProduction ? 'nicht_eingerichtet' : 'simuliert' };
  }, { auth: false });

  router.post('/api/auth/reset', async (req, res, { ip }) => {
    limiter.hit(`reset-ip:${ip}`, 20, 3600_000);
    const body = await readJson(req);
    const token = String(body.token || '');
    const row = token ? db.get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(token)) : null;
    if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
      throw badRequest('Dieser Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.');
    }
    const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
    const problem = passwordProblem(body.password, user?.email);
    if (problem) throw badRequest(problem, { field: 'password' });
    const hash = await hashPassword(body.password, config.passwordHashCost);
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, new Date().toISOString(), row.user_id);
      db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', new Date().toISOString(), row.token_hash);
      db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id); // überall abmelden
    });
    logSecurityEvent(db, row.user_id, 'passwort_zurueckgesetzt');
    return { ok: true };
  }, { auth: false });

  router.post('/api/auth/demo', async (req, res, { ip }) => {
    if (!config.demo.enabled) throw new HttpError(404, 'Der Demomodus ist ausgeschaltet.');
    limiter.hit(`demo:${ip}`, 15, 3600_000, 'Zu viele Demo-Zugänge von diesem Gerät. Bitte später erneut versuchen.');
    const user = await createDemoAccount(ctx);
    const session = createSession(db, user.id, deviceLabel(req.headers['user-agent']));
    setSessionCookie(res, config, session.token, Math.min(session.maxAge, config.demo.ttlHours * 3600));
    return { user: serializeUser(user) };
  }, { auth: false });

  // Erfundener Beispielbrief zum Ausprobieren des Hochladens
  router.get('/api/demo/beispielbrief', (req, res, { query }) => {
    if (!config.demo.enabled) throw new HttpError(404, 'Der Demomodus ist ausgeschaltet.');
    const { pdf, name } = demoSamplePdf(Number(query.get('nr') || 0), todayIn('Europe/Berlin'));
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  }, { auth: false });

  // Liefert den angemeldeten Nutzer oder null (kein Fehler, damit die Startseite ruhig bleibt)
  router.get('/api/me', (req, res, { user }) => ({ user: user ? serializeUser(user) : null }), { auth: false });
}
