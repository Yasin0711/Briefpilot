// Passwörter, Sitzungen, Begrenzung von Anfragen und Sicherheits-Header.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './http.js';
import { PASSWORD_MIN_LENGTH } from '../../public/js/shared/constants.js';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'bp_session';
export const SESSION_DAYS = 30;

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const newId = () => crypto.randomUUID();

// ---------- Passwörter (scrypt, Parameter im Hash gespeichert) ----------

export async function hashPassword(password, cost = 15) {
  const N = 2 ** cost;
  const r = 8;
  const p = cost >= 15 ? 3 : 1;
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, 64, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

const COMMON_PASSWORDS = new Set([
  'passwort123', 'password123', '1234567890', '12345678910', 'qwertz1234', 'qwerty1234', 'hallo12345',
  'passwort1234', 'password1234', 'abcdefghij', '0123456789', 'iloveyou12', 'sommer2026', 'winter2026',
]);

/** Gibt eine Fehlermeldung zurück oder null, wenn das Passwort in Ordnung ist. */
export function passwordProblem(password, email = '') {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Das Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen lang sein.`;
  }
  if (password.length > 200) return 'Das Passwort ist zu lang (höchstens 200 Zeichen).';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Dieses Passwort ist zu leicht zu erraten. Bitte wählen Sie ein anderes.';
  if (email && lower === String(email).toLowerCase()) return 'Das Passwort darf nicht Ihre E-Mail-Adresse sein.';
  if (/^(.)\1+$/.test(password)) return 'Das Passwort ist zu einfach.';
  return null;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(email);
}

// ---------- Sitzungen ----------

export function createSession(db, userId, device) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.run(
    'INSERT INTO sessions (id, user_id, device, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), userId, device, now.toISOString(), now.toISOString(), expires.toISOString()
  );
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function loadSession(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const id = sha256(token);
  const row = db.get(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    id
  );
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) < now) {
    db.run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  // Gleitende Verlängerung, höchstens alle 10 Minuten in die Datenbank schreiben
  if (now - Date.parse(row.last_seen_at) > 10 * 60 * 1000) {
    db.run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      new Date(now).toISOString(), new Date(now + SESSION_DAYS * 86400000).toISOString(), id
    );
  }
  return row;
}

// ---------- Anfragebegrenzung (gegen Passwort-Raten und Missbrauch) ----------

export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.cleanup(), 60_000);
    this.timer.unref();
  }

  /** Erhöht den Zähler; wirft 429, wenn das Limit erreicht ist. */
  hit(key, limit, windowMs, message = 'Zu viele Versuche. Bitte warten Sie einige Minuten.') {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.reset < now) {
      bucket = { count: 0, reset: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) {
      const retry = Math.ceil((bucket.reset - now) / 1000);
      throw new HttpError(429, message, { retryAfter: retry });
    }
  }

  check(key, limit) {
    const bucket = this.buckets.get(key);
    return !bucket || bucket.reset < Date.now() || bucket.count < limit;
  }

  reset(key) {
    this.buckets.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.reset < now) this.buckets.delete(key);
  }
}

// ---------- Sicherheits-Header ----------

export function applySecurityHeaders(res, config) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' blob: data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/**
 * Schutz gegen Cross-Site-Request-Forgery: Ändernde Anfragen müssen den
 * eigenen Header „X-BriefPilot“ tragen (fremde Seiten können ihn nicht setzen)
 * und – falls vorhanden – vom eigenen Ursprung kommen.
 */
export function checkCsrf(req, config) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-briefpilot'] !== '1') throw new HttpError(403, 'Anfrage abgelehnt (Sicherheitsprüfung).');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Anfrage abgelehnt (Herkunft ungültig).');
    }
    const allowed = new Set([req.headers.host, new URL(config.baseUrl).host]);
    if (!allowed.has(host)) throw new HttpError(403, 'Anfrage abgelehnt (fremde Herkunft).');
  }
}

export function logSecurityEvent(db, userId, event) {
  db.run('INSERT INTO security_events (user_id, event, created_at) VALUES (?, ?, ?)', userId, event, new Date().toISOString());
}
