// Kleine HTTP-Hilfsfunktionen: Router, Anfragen lesen, Antworten senden, statische Dateien.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new HttpError(400, message, extra);
export const notFound = (message = 'Nicht gefunden.') => new HttpError(404, message);

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler, options = {}) => {
    const keys = [];
    const source = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    routes.push({ method, pattern, regex: new RegExp(`^${source}/?$`), keys, handler, options });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    match(method, pathname) {
      let pathMatched = false;
      for (const route of routes) {
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const effectiveMethod = method === 'HEAD' ? 'GET' : method;
        if (route.method !== effectiveMethod) {
          pathMatched = true;
          continue;
        }
        const params = {};
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(m[i + 1]);
        });
        return { route, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

/** Liest den Anfrage-Inhalt mit Größenbegrenzung. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      reject(new HttpError(413, `Die Datei ist zu groß (maximal ${Math.round(limit / 1024 / 1024)} MB).`));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, `Die Datei ist zu groß (maximal ${Math.round(limit / 1024 / 1024)} MB).`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

export async function readJson(req, limit = 256 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Die Anfrage muss im JSON-Format gesendet werden.');
  }
  const body = await readBody(req, limit);
  if (body.length === 0) return {};
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw badRequest('Die Anfrage konnte nicht gelesen werden.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Die Anfrage ist ungültig.');
  return value;
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Strict', path: cookiePath = '/' } = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; SameSite=${sameSite}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (secure) cookie += '; Secure';
  if (maxAge !== undefined) cookie += `; Max-Age=${Math.floor(maxAge)}`;
  return cookie;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

/** Liefert Dateien aus dem Ordner public/. Unbekannte Pfade erhalten die App-Startseite. */
export function serveStatic(req, res, publicDir, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw badRequest('Ungültiger Pfad.');
  }
  if (rel.includes('\0')) throw badRequest('Ungültiger Pfad.');
  let filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) throw notFound();

  let stat = null;
  try {
    stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.statSync(filePath);
    }
  } catch {
    stat = null;
  }
  if (!stat) {
    // Einzelseiten-App: alles ohne Dateiendung bekommt index.html
    if (path.extname(rel)) throw notFound();
    filePath = path.join(publicDir, 'index.html');
    stat = fs.statSync(filePath);
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    ETag: etag,
    'Cache-Control': 'no-cache',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unbekannt';
}

/** Kurze, datensparsame Gerätebezeichnung aus dem User-Agent („iPhone · Safari“). */
export function deviceLabel(userAgent = '') {
  const ua = String(userAgent);
  let os = 'Unbekanntes Gerät';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? 'Android-Smartphone' : 'Android-Tablet';
  else if (/Windows/.test(ua)) os = 'Windows-Computer';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux-Computer';
  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return browser ? `${os} · ${browser}` : os;
}
