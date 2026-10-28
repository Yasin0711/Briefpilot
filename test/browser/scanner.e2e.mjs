// Browser-Test des Scanners: Import, Editor, Drehen, Sortieren, Live-Kamera (Testvideo), Speichern.
// Testbilder und Testvideo vorher erzeugen: python3 test/browser/make_media.py test/browser/media
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium, startServer, watchPage, demoLogin, shot, MEDIA } from './harness.mjs';

if (!fs.existsSync(path.join(MEDIA, 'kamera.y4m'))) {
  console.error('Testbilder fehlen. Bitte zuerst ausführen: python3 test/browser/make_media.py test/browser/media');
  process.exit(2);
}
const server = await startServer();
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(MEDIA, 'kamera.y4m')}`],
});
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push(`OK   ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err.message.split('\n')[0]}`);
    throw err;
  }
};
let problems = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, permissions: ['camera'] });
  const page = await context.newPage();
  problems = watchPage(page, 'mobil');
  await step('Demo-Anmeldung', () => demoLogin(page, server.base));
  await step('Scan-Seite öffnen', async () => {
    await page.goto(`${server.base}/#/scannen`);
    await page.waitForSelector('[data-live]');
    await shot(page, '01-scan-leer');
  });
  await step('Foto + Screenshot importieren (automatischer Zuschnitt)', async () => {
    await page.setInputFiles('[data-files]', [path.join(MEDIA, 'brief-foto.jpg'), path.join(MEDIA, 'screenshot.png')]);
    await page.waitForFunction(() => document.querySelectorAll('.page-item').length === 2 && !document.querySelector('.page-item.is-busy'), null, { timeout: 30000 });
    const subs = await page.$$eval('.page-item .row-sub', (els) => els.map((e) => e.textContent.trim()));
    console.log('  Seiten:', subs);
    assert.match(subs[0], /^Zugeschnitten · Verbessert/);
    assert.match(subs[1], /Original/);
    await shot(page, '02-zwei-seiten');
  });
  await step('Seite 1 im Editor zuschneiden und Filter wählen', async () => {
    await page.click('.page-item:nth-child(1) .page-tools [data-edit]');
    await page.waitForSelector('.scanner-editor [data-handle="0"]');
    await page.waitForTimeout(300);
    await shot(page, '03-editor-zuschnitt');
    const h = await page.$('[data-handle="0"]');
    const box = await h.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 + 6, { steps: 4 });
    await page.mouse.up();
    await page.click('[data-next]');
    await page.waitForFunction(() => document.querySelector('[data-preview]')?.src?.startsWith('blob:'), null, { timeout: 20000 });
    await page.click('[data-filter="sw"]');
    await page.waitForTimeout(800);
    await page.waitForFunction(() => document.querySelector('[data-spinner]')?.hidden, null, { timeout: 20000 });
    await shot(page, '04-editor-ergebnis-sw');
    await page.click('[data-save]');
    await page.waitForFunction(() => !document.querySelector('.scanner') && !document.querySelector('.page-item.is-busy'), null, { timeout: 30000 });
    const sub = await page.$eval('.page-item:nth-child(1) .row-sub', (e) => e.textContent.trim());
    assert.match(sub, /Schwarzweiß/);
  });
  await step('Seite 2 drehen und nach oben schieben', async () => {
    await page.click('.page-item:nth-child(2) [data-rotate]');
    await page.waitForFunction(() => !document.querySelector('.page-item.is-busy'), null, { timeout: 20000 });
    await page.click('.page-item:nth-child(2) [data-move][data-dir="-1"]');
    const first = await page.$eval('.page-item:nth-child(1) .row-sub', (e) => e.textContent.trim());
    assert.match(first, /Original/);
  });
  await step('Live-Kamera: automatische Aufnahme', async () => {
    await page.click('[data-live]');
    await page.waitForSelector('.scanner video');
    await page.waitForFunction(() => document.querySelector('.scanner video')?.readyState >= 2, null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    await shot(page, '05-kamera-live');
    try {
      await page.waitForFunction(() => Number(document.querySelector('.scanner [data-count]')?.textContent) >= 3, null, { timeout: 30000 });
    } catch (err) {
      console.log('  Hinweis bei Zeitüberschreitung:', await page.$eval('.scanner [data-hint]', (e) => e.textContent).catch(() => '?'),
        '| Zähler:', await page.$eval('.scanner [data-count]', (e) => e.textContent).catch(() => '?'),
        '| Video:', await page.$eval('.scanner video', (v) => `${v.videoWidth}x${v.videoHeight} rs=${v.readyState}`).catch(() => '?'));
      await shot(page, '05b-kamera-fehler');
      throw err;
    }
    const hint = await page.$eval('.scanner [data-hint]', (e) => e.textContent);
    console.log('  Hinweis nach Aufnahme:', hint);
    await shot(page, '06-kamera-aufgenommen');
    await page.click('.scanner-done');
    await page.waitForFunction(() => !document.querySelector('.scanner') && document.querySelectorAll('.page-item').length === 3);
    const subs = await page.$$eval('.page-item .row-sub', (els) => els.map((e) => e.textContent.trim()));
    console.log('  Seiten:', subs);
    assert.match(subs[2], /Zugeschnitten · Verbessert/);
    await shot(page, '07-drei-seiten');
  });
  await step('Zurück-Taste schließt nur die Kamera', async () => {
    await page.click('[data-live]');
    await page.waitForSelector('.scanner video');
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector('.scanner'));
    assert.equal(await page.evaluate(() => location.hash), '#/scannen');
    assert.equal(await page.$$eval('.page-item', (e) => e.length), 3);
  });
  await step('Originalfotos aufbewahren + speichern', async () => {
    await page.check('[data-keep]');
    await page.click('[data-submit]');
    await page.waitForFunction(() => /^#\/briefe\/[\w-]+$/.test(location.hash), null, { timeout: 30000 });
    const id = await page.evaluate(() => location.hash.split('/').pop());
    const detail = await page.evaluate(async (letterId) => (await fetch(`/api/letters/${letterId}`, { headers: { 'X-BriefPilot': '1' } })).json(), id);
    const files = detail.letter?.files || detail.files || [];
    const roles = files.map((f) => f.role);
    console.log('  Dateien:', roles.join(', '));
    assert.equal(roles.filter((r) => r === 'seite').length, 3);
    assert.equal(roles.filter((r) => r === "original").length, 3);
    await page.waitForTimeout(1500);
    await shot(page, '08-brief-detail');
  });
  await step('Dasselbe PDF zweimal: Rückfrage „schon gespeichert“', async () => {
    const pdf = await page.request.get(`${server.base}/api/demo/beispielbrief?nr=0`);
    const file = path.join(MEDIA, 'beispiel.pdf');
    (await import('node:fs')).writeFileSync(file, await pdf.body());
    for (const round of [1, 2]) {
      await page.goto(`${server.base}/#/scannen`);
      await page.setInputFiles('[data-files]', [file]);
      await page.waitForSelector('.page-item');
      await page.click('[data-submit]');
      await page.waitForFunction(() => /^#\/briefe\//.test(location.hash) || document.querySelector('dialog [data-act]'), null, { timeout: 30000 });
      const dialog = Boolean(await page.$('dialog [data-act]'));
      console.log(`  Runde ${round}: ${dialog ? 'Rückfrage' : 'gespeichert'}`);
      if (dialog) break;
    }
    await page.waitForSelector('dialog [data-act="speichern"]', { timeout: 20000 });
    await shot(page, '09-doppelt-rueckfrage');
    await page.click('dialog [data-act="abbrechen"]');
    await page.waitForSelector('.page-item .badge-review');
    const badges = await page.$$eval('.page-item .badge', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(badges, ['Schon gespeichert']);
    // Trotzdem speichern → neuer Brief
    await page.click('[data-submit]');
    await page.waitForSelector('dialog [data-act="speichern"]');
    await page.click('dialog [data-act="speichern"]');
    await page.waitForFunction(() => /^#\/briefe\//.test(location.hash), null, { timeout: 30000 });
  });
} finally {
  console.log(results.join('\n'));
  console.log(problems.length ? `Probleme:\n${problems.join('\n')}` : 'Keine Browser-Fehler.');
  const serverErrors = server.logs.filter((l) => l[0] === 'error');
  if (serverErrors.length) console.log('Server-Fehler:', serverErrors);
  await browser.close();
  await server.stop();
}
