// Gemeinsame Hilfen für Browser-Tests: Server mit eigener Datenbank starten, Browser öffnen, Fehler sammeln.
// Optional – braucht Playwright (npm install --no-save playwright && npx playwright install chromium).
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const SHOTS = path.join(HERE, 'shots');
export const MEDIA = path.join(HERE, 'media');
fs.mkdirSync(SHOTS, { recursive: true });

export async function startServer(env = {}) {
  const { loadConfig } = await import(pathToFileURL(path.join(REPO, 'server', 'config.js')).href);
  const { createServer } = await import(pathToFileURL(path.join(REPO, 'server', 'index.js')).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-e2e-'));
  const config = loadConfig({
    PORT: '0', DATA_DIR: dir, FILE_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    PASSWORD_HASH_COST: '10', DEMO_ENABLED: 'true', AI_PROVIDER: 'aus', ...env,
  });
  const logs = [];
  const log = { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) };
  const app = createServer(config, { log });
  const addr = await app.start();
  const base = `http://localhost:${addr.port}`;
  return { app, base, dir, logs, config, async stop() { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export function watchPage(page, label = '') {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`${label} Seitenfehler: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`${label} Konsole: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    const f = req.failure()?.errorText || '';
    if (!/ERR_ABORTED/.test(f)) problems.push(`${label} Anfrage fehlgeschlagen: ${req.url()} ${f}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 500) problems.push(`${label} Serverfehler ${res.status()}: ${res.url()}`);
  });
  return problems;
}

export async function demoLogin(page, base) {
  await page.goto(`${base}/#/anmelden`);
  await page.click('[data-demo]');
  await page.waitForFunction(() => location.hash === '#/' && document.querySelector('.hello, h1'));
}

export async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}
