// Startpunkt des Servers.
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig, featureStatus } from './config.js';
import { openDatabase } from './db.js';
import { createStorage } from './lib/storage.js';
import { createMailer } from './lib/mail.js';
import { createPushService } from './lib/push.js';
import { createAnalyzer } from './analysis/index.js';
import { createAiClient } from './analysis/client.js';
import { createApp } from './app.js';
import { deliverDueReminders } from './domain/reminders.js';
import { cleanupDemoAccounts } from './demo/seed.js';

export function createServer(config, { log = console, mailer: mailerOverride, push: pushOverride, fetchImpl } = {}) {
  fs.mkdirSync(config.filesDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(config.dbPath);
  const storage = createStorage({ dir: config.filesDir, keyBase64: config.fileEncryptionKey });
  const mailer = mailerOverride || createMailer(config);
  const push = pushOverride || createPushService(config);
  const ai = createAiClient(config, fetchImpl ? { fetchImpl } : {});
  const ctx = { db, config, storage, mailer, push, log, ai };
  ctx.analyzer = createAnalyzer(ctx);
  const handler = createApp(ctx);
  const server = http.createServer(handler);
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  let reminderTimer = null;
  let maintenanceTimer = null;
  let ticking = false;

  async function reminderTick() {
    if (ticking) return;
    ticking = true;
    try {
      await deliverDueReminders({ db, push, mailer, config, log });
    } catch (err) {
      log.error(`[Erinnerungen] Fehler: ${err.name}`);
    } finally {
      ticking = false;
    }
  }

  async function maintenance() {
    try {
      const now = new Date().toISOString();
      db.run('DELETE FROM sessions WHERE expires_at < ?', now);
      db.run('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL', now);
      // Hochgeladene Seiten, die nie zu einem Brief wurden, nach 24 Stunden löschen
      const orphanCutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
      for (const f of db.all('SELECT id, storage_key FROM files WHERE letter_id IS NULL AND created_at < ?', orphanCutoff)) {
        db.run('DELETE FROM files WHERE id = ?', f.id);
        await storage.remove(f.storage_key);
      }
      const removed = await cleanupDemoAccounts(ctx);
      if (removed) log.info(`[Wartung] ${removed} abgelaufene Demo-Konten gelöscht`);
      db.run('DELETE FROM security_events WHERE created_at < ?', new Date(Date.now() - 180 * 86400_000).toISOString());
    } catch (err) {
      log.error(`[Wartung] Fehler: ${err.name}`);
    }
  }

  return {
    ctx,
    server,
    async start() {
      await new Promise((resolve) => server.listen(config.port, config.host, resolve));
      const resumed = ctx.analyzer.resumePending();
      if (resumed) log.info(`[Auswertung] ${resumed} unterbrochene Auswertung(en) werden fortgesetzt`);
      reminderTimer = setInterval(reminderTick, config.reminderIntervalMs);
      maintenanceTimer = setInterval(maintenance, 3600_000);
      reminderTick();
      maintenance();
      return server.address();
    },
    async stop() {
      clearInterval(reminderTimer);
      clearInterval(maintenanceTimer);
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
    reminderTick,
    maintenance,
  };
}

async function main() {
  const config = loadConfig();
  const { errors, warnings } = validateConfig(config);
  if (errors.length) {
    console.error('\nBriefPilot kann nicht starten:\n');
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error('');
    process.exit(1);
  }
  const app = createServer(config);
  await app.start();
  const icon = { echt: '✓', simuliert: '~', aus: '✗', vorschau: '…' };
  console.log(`\nBriefPilot läuft: ${config.baseUrl}\n`);
  console.log('Was funktioniert echt – und was nicht:');
  for (const f of featureStatus(config)) console.log(`  ${icon[f.state] || '-'} ${f.label}: ${f.detail}`);
  if (warnings.length) {
    console.log('\nHinweise:');
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  console.log('\nZum Beenden: Strg + C\n');
  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Unerwarteter Fehler beim Start:', err.message);
    process.exit(1);
  });
}
