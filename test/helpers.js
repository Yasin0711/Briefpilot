// Testhilfen: startet einen Server mit eigener, leerer Datenbank.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createServer } from '../server/index.js';

export const quietLog = { info() {}, warn() {}, error() {} };

export async function startTestServer(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefpilot-test-'));
  const config = loadConfig({
    PORT: '0',
    DATA_DIR: dir,
    FILE_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    PASSWORD_HASH_COST: '10',
    DEMO_ENABLED: 'true',
    ...env,
  });
  const mails = [];
  const mailer = { configured: true, async send(msg) { mails.push(msg); return { delivered: true }; } };
  const app = createServer(config, { log: quietLog, mailer });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    app, config, base, mails, dir,
    async stop() {
      await app.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    client() {
      let cookie = '';
      async function call(method, urlPath, body, { headers = {}, raw } = {}) {
        const h = { 'x-briefpilot': '1', ...(cookie ? { cookie } : {}), ...headers };
        let payload;
        if (raw !== undefined) payload = raw;
        else if (body !== undefined) {
          h['content-type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        const res = await fetch(base + urlPath, { method, headers: h, body: payload });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
        const type = res.headers.get('content-type') || '';
        const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
        return { status: res.status, data, headers: res.headers };
      }
      return {
        call,
        get: (p) => call('GET', p),
        post: (p, b = {}) => call('POST', p, b),
        patch: (p, b) => call('PATCH', p, b),
        put: (p, b) => call('PUT', p, b),
        del: (p) => call('DELETE', p),
        upload: (buf, type) => call('POST', '/api/files', undefined, { raw: buf, headers: { 'content-type': type } }),
        get cookie() { return cookie; },
      };
    },
  };
}

export async function registerUser(server, email = `nutzer-${crypto.randomUUID().slice(0, 8)}@example.org`) {
  const c = server.client();
  const res = await c.post('/api/auth/register', { email, password: 'ein langes sicheres Passwort', acceptPrivacy: true, name: 'Test' });
  if (res.status !== 200) throw new Error(`Registrierung fehlgeschlagen: ${JSON.stringify(res.data)}`);
  return { c, email, user: res.data.user };
}
