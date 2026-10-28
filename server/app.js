// Zentrale Anfrageverarbeitung: Sicherheits-Header, Anmeldung, CSRF-Schutz, Routing, Fehler.
import {
  createRouter, HttpError, sendJson, serveStatic, parseCookies, clientIp,
} from './lib/http.js';
import { applySecurityHeaders, checkCsrf, loadSession, SESSION_COOKIE, RateLimiter } from './lib/security.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerLetterRoutes } from './routes/letters.js';
import { registerTaskRoutes } from './routes/tasks.js';

export function createApp(ctx) {
  const { db, config } = ctx;
  const log = ctx.log || console;
  ctx.limiter = ctx.limiter || new RateLimiter();
  const router = createRouter();
  registerAuthRoutes(router, ctx);
  registerAccountRoutes(router, ctx);
  registerLetterRoutes(router, ctx);
  registerTaskRoutes(router, ctx);

  return async function handle(req, res) {
    const started = Date.now();
    let routeLabel = 'static';
    applySecurityHeaders(res, config);
    res.on('finish', () => {
      // Datensparsames Protokoll: Methode, Routenmuster (ohne IDs/Suchbegriffe), Status, Dauer
      if (routeLabel !== 'static' || res.statusCode >= 400) {
        log.info(`${req.method} ${routeLabel} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Ungültige Adresse.' });
      return;
    }

    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Methode nicht erlaubt.');
        serveStatic(req, res, config.publicDir, url.pathname);
        return;
      }

      const match = router.match(req.method, url.pathname);
      if (!match) {
        routeLabel = 'api-unbekannt';
        throw new HttpError(404, 'Diese Funktion gibt es nicht.');
      }
      if (match.methodNotAllowed) throw new HttpError(405, 'Methode nicht erlaubt.');
      const { route, params } = match;
      routeLabel = route.pattern;

      checkCsrf(req, config);
      const cookies = parseCookies(req.headers.cookie);
      const session = loadSession(db, cookies[SESSION_COOKIE]);
      if (route.options.auth !== false && !session) throw new HttpError(401, 'Bitte melden Sie sich an.');

      const result = await route.handler(req, res, {
        params,
        query: url.searchParams,
        user: session || null,
        sessionId: session?.session_id || null,
        ip: clientIp(req, config.trustProxy),
      });
      if (res.writableEnded || res.headersSent) return;
      if (result === undefined) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      } else {
        sendJson(res, 200, result);
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        const headers = err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
        sendJson(res, err.status, { error: err.message, ...(err.extra?.field ? { field: err.extra.field } : {}), ...(err.extra?.data || {}) }, headers);
        return;
      }
      // Keine Inhalte protokollieren – nur Art des Fehlers
      log.error(`[Fehler] ${routeLabel}: ${err?.name || 'Error'}${config.isProduction ? '' : ` – ${err?.message}`}`);
      if (!config.isProduction && err?.stack) log.error(err.stack.split('\n').slice(0, 4).join('\n'));
      sendJson(res, 500, { error: 'Es ist ein interner Fehler aufgetreten. Bitte versuchen Sie es erneut.' });
    }
  };
}
