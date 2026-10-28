// Gesamtablauf mit neuem Konto: registrieren → Haushalt und Akte anlegen → KI erlauben → Brief scannen
// (nachgebaute KI) → automatisch der Akte zugeordnet → Zahlung bestätigen → Seiten trennen und wieder
// anhängen → Daten exportieren → abmelden und wieder anmelden. Dazu Tastaturbedienung im „Zuordnen“.
// Testbilder vorher erzeugen: python3 test/browser/make_media.py test/browser/media
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { chromium, startServer, watchPage, shot, MEDIA } from './harness.mjs';
import { startMockGemini } from './mock-gemini.mjs';

if (!fs.existsSync(path.join(MEDIA, 'brief-foto.jpg'))) {
  console.error('Testbilder fehlen. Bitte zuerst ausführen: python3 test/browser/make_media.py test/browser/media');
  process.exit(2);
}

/** Eintrag aus einer ZIP-Datei lesen (ohne Pakete). */
function unzipEntry(zip, wanted) {
  let pos = 0;
  while (pos < zip.length - 4 && zip.readUInt32LE(pos) === 0x04034b50) {
    const method = zip.readUInt16LE(pos + 8);
    const size = zip.readUInt32LE(pos + 18);
    const nameLen = zip.readUInt16LE(pos + 26);
    const extraLen = zip.readUInt16LE(pos + 28);
    const name = zip.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const start = pos + 30 + nameLen + extraLen;
    const data = zip.subarray(start, start + size);
    if (name === wanted) return method === 8 ? zlib.inflateRawSync(data) : data;
    pos = start + size;
  }
  return null;
}

const gemini = await startMockGemini();
const server = await startServer({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIza-test-0123456789abcdef', GEMINI_BASE_URL: gemini.url, GEMINI_FALLBACK_MODEL: '' });
const browser = await chromium.launch();
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
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());
let problems = [];
let letterId = null;
try {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
  const page = await context.newPage();
  problems = watchPage(page, 'mobil');

  await step('Registrieren', async () => {
    await page.goto(`${server.base}/#/registrieren`);
    await page.fill('#name', 'Lena');
    await page.fill('#email', 'lena@example.org');
    await page.fill('#password', 'sehr-sicheres-passwort-42');
    await page.fill('#password2', 'sehr-sicheres-passwort-42');
    await page.click('label.check:has(input[name="acceptPrivacy"])');
    await page.click('form [type=submit]');
    await page.waitForSelector('.hello', { timeout: 15000 });
    assert.match(await text(page, '.hello h1'), /Lena/);
  });

  await step('Haushalt: Person und Hauptadresse', async () => {
    await page.goto(`${server.base}/#/einstellungen`);
    await page.click('[data-action="person-add"]');
    await page.fill('dialog #pe-name', 'Lena Beispiel');
    await page.selectOption('dialog #pe-rel', 'ich');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => document.body.textContent.includes('Lena Beispiel'));
    await page.click('[data-action="address-add"]');
    await page.fill('dialog #ad-label', 'Zuhause');
    await page.fill('dialog #ad-street', 'Lindenweg 12');
    await page.fill('dialog #ad-zip', '66123');
    await page.fill('dialog #ad-city', 'Saarbrücken');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => document.body.textContent.includes('Lindenweg 12, 66123 Saarbrücken'));
  });

  await step('Akte „Strom Zuhause“ mit Zählernummer anlegen', async () => {
    await page.goto(`${server.base}/#/akten`);
    await page.click('[data-new]');
    await page.selectOption('dialog #o-type', 'strom');
    await page.fill('dialog #o-name', 'Strom Zuhause');
    await page.fill('dialog #o-provider', 'Stadtwerke Musterstadt GmbH');
    await page.selectOption('dialog [data-kind]', 'zaehlernummer');
    await page.fill('dialog [data-value]', '1ESY 1160 5234 56');
    await page.click('dialog [type=submit]');
    await page.waitForSelector('[data-id-add]');
    assert.match(await text(page, 'h1'), /Strom Zuhause/);
    assert.match(await text(page, '.id-list'), /1ESY 1160 5234 56/);
  });

  await step('Scannen: KI erlauben, Foto importieren, speichern', async () => {
    await page.goto(`${server.base}/#/scannen`);
    await page.click('[data-consent="ja"]');
    await page.waitForFunction(() => !document.querySelector('[data-consent]'));
    await page.setInputFiles('[data-files]', [path.join(MEDIA, 'brief-foto.jpg')]);
    await page.waitForFunction(() => document.querySelectorAll('.page-item').length === 1 && !document.querySelector('.page-item.is-busy'), null, { timeout: 30000 });
    await page.click('[data-submit]');
    await page.waitForFunction(() => /^#\/briefe\/[\w-]+$/.test(location.hash), null, { timeout: 30000 });
    letterId = await page.evaluate(() => location.hash.split('/').pop());
  });

  await step('Auswertung (nachgebaute KI) und automatische Zuordnung zur Akte', async () => {
    await page.waitForSelector('.assign-panel .linked', { timeout: 20000 });
    assert.match(await text(page, '.assign-panel'), /Strom Zuhause/);
    assert.match(await text(page, '.assign-panel'), /Automatisch zugeordnet/);
    await page.click('.why summary');
    assert.match(await text(page, '.why .evidence'), /Zählernummer/);
    assert.match(await text(page, '.letter-head h1'), /Jahresabrechnung Strom 2025/);
    await shot(page, '30-journey-brief');
  });

  await step('Zahlung bestätigen → Erinnerungen geplant, Aufgabe offen', async () => {
    const card = page.locator('.task-card.is-review').first();
    await card.locator('label.check-strong').click();
    await card.locator('button[data-mode="date"]').click();
    await page.waitForSelector('.task-card:not(.is-review) [data-action="done"]', { timeout: 10000 });
    await page.goto(`${server.base}/#/aufgaben?status=offen`);
    await page.waitForFunction(() => document.body.textContent.includes('86,40 € an die Stadtwerke überweisen'));
    // Kalenderdatei
    const [ics] = await Promise.all([page.waitForEvent('download'), page.click('[data-ics]')]);
    assert.match(fs.readFileSync(await ics.path(), 'utf8'), /BEGIN:VCALENDAR[\s\S]*SUMMARY:Zahlung: 86\\,40/); // Komma ist in Kalenderdateien maskiert
    // Erledigt und wieder öffnen
    await page.click('[data-done]');
    await page.click('[data-status="erledigt"]');
    await page.waitForSelector('[data-reopen]');
    await page.click('[data-reopen]');
    await page.click('[data-status="offen"]');
    await page.waitForSelector('[data-done]');
  });

  await step('Zweiseitiger Brief: Seite abtrennen und wieder anhängen', async () => {
    await page.goto(`${server.base}/#/scannen`);
    await page.setInputFiles('[data-files]', [path.join(MEDIA, 'brief-foto-2.jpg'), path.join(MEDIA, 'brief-foto-3.jpg')]);
    await page.waitForFunction(() => document.querySelectorAll('.page-item').length === 2 && !document.querySelector('.page-item.is-busy'), null, { timeout: 30000 });
    await page.click('[data-submit]');
    await page.waitForFunction(() => /^#\/briefe\/[\w-]+$/.test(location.hash), null, { timeout: 30000 });
    const twoPageId = await page.evaluate(() => location.hash.split('/').pop());
    await page.waitForFunction(() => !document.querySelector('.note .spinner'), null, { timeout: 20000 });
    await page.click('.tabs [data-tab="original"]');
    await page.click('[data-panel="original"] [data-action="split-start"]');
    await page.check('[data-panel="original"] [data-split-page]:nth-of-type(1)', { force: true }).catch(async () => {
      await page.locator('[data-panel="original"] .page-pick').nth(1).click();
    });
    if (!(await page.$('[data-panel="original"] .original-page.is-picked'))) await page.locator('[data-panel="original"] .page-pick').nth(1).click();
    await page.click('[data-panel="original"] [data-action="split-do"]');
    await page.click('dialog [data-act="ok"]');
    await page.waitForSelector('dialog [data-act="cancel"]');
    await page.click('dialog [data-act="cancel"]'); // „Hier bleiben“
    await page.waitForFunction(() => document.querySelectorAll('[data-panel="original"] .original-page').length === 1, null, { timeout: 20000 });
    // Wieder anhängen: der abgetrennte Brief ist der neueste
    await page.waitForFunction(() => !document.querySelector('.note .spinner'), null, { timeout: 20000 });
    await page.click('[data-panel="original"] [data-action="merge"]');
    await page.waitForSelector('dialog input[name="sourceId"]');
    await page.locator('dialog label.check').first().click();
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => document.querySelectorAll('[data-panel="original"] .original-page').length === 2, null, { timeout: 20000 });
    assert.equal(await page.evaluate(() => location.hash.split('/').pop()), twoPageId);
    await page.click('.tabs [data-tab="erklaerung"]');
    await page.click('.history summary');
    const hist = await text(page, '.timeline');
    assert.match(hist, /Seiten in neuen Brief verschoben/);
    assert.match(hist, /Mit anderem Brief zusammengeführt/);
  });

  await step('Export: ZIP mit Briefen, Akten und Verlauf', async () => {
    await page.goto(`${server.base}/#/einstellungen`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]')]);
    const zip = fs.readFileSync(await download.path());
    const data = JSON.parse(unzipEntry(zip, 'daten.json').toString('utf8'));
    assert.equal(data.akten.length, 1);
    assert.equal(data.akten[0].name, 'Strom Zuhause');
    assert.ok(data.personen.some((p) => p.name === 'Lena Beispiel'));
    assert.ok(data.verlauf.length >= 5);
    assert.equal(JSON.stringify(data).includes('password'), false, 'kein Passwort im Export');
  });

  await step('Abmelden und wieder anmelden', async () => {
    await page.click('[data-action="logout"]');
    await page.waitForSelector('#email');
    await page.fill('#email', 'lena@example.org');
    await page.fill('#password', 'sehr-sicheres-passwort-42');
    await page.click('form [type=submit]');
    await page.waitForSelector('.hello', { timeout: 15000 });
  });

  await step('Passwort ändern', async () => {
    await page.goto(`${server.base}/#/einstellungen`);
    await page.click('[data-action="password"]');
    await page.fill('dialog #pw-old', 'sehr-sicheres-passwort-42');
    await page.fill('dialog #pw-new', 'noch-sichereres-passwort-43');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => !document.querySelector('dialog'));
  });

  await step('Tastatur: Akte im „Zuordnen“ mit Leertaste wählen', async () => {
    // Zweite Strom-Akte mit derselben Kundennummer → der nächste Brief ist mehrdeutig
    const call = (method, p, body) => page.evaluate(async ({ method, p, body }) => {
      const res = await fetch(p, { method, headers: { 'X-BriefPilot': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: await res.json().catch(() => null) };
    }, { method, p, body });
    const objs = (await call('GET', '/api/objects')).data.objects;
    await call('POST', `/api/objects/${objs[0].id}/identifiers`, { kind: 'vertragskonto', value: '7788 1122' });
    await call('POST', '/api/objects', { type: 'strom', name: 'Strom Garage', provider: 'Stadtwerke Musterstadt GmbH', identifiers: [{ kind: 'vertragskonto', value: '7788 1122' }] });
    await call('DELETE', `/api/identifiers/${(await call('GET', `/api/objects/${objs[0].id}`)).data.identifiers.find((i) => i.kind === 'zaehlernummer').id}`);
    await call('POST', `/api/letters/${letterId}/links/auto`);
    await page.goto(`${server.base}/#/zuordnen`);
    await page.waitForSelector('.decision-card [data-choice]');
    await page.focus('.decision-card [data-choice]');
    await page.keyboard.press('Space');
    await page.waitForSelector('.decision-card .choice.is-on');
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
    console.log('  Fokus nach Tab:', focused);
    await shot(page, '31-journey-tastatur');
  });

  await step('Konto löschen (mit Passwort und „LÖSCHEN“)', async () => {
    await page.goto(`${server.base}/#/einstellungen`);
    await page.click('[data-action="delete-account"]');
    await page.fill('dialog #d-pw', 'noch-sichereres-passwort-43');
    await page.fill('dialog #d-confirm', 'löschen');
    await page.click('dialog [type=submit]');
    await page.waitForSelector('#email');
    // Anmeldung mit dem gelöschten Konto schlägt fehl (die Antwort 401 ist hier erwartet)
    const before = problems.length;
    await page.fill('#email', 'lena@example.org');
    await page.fill('#password', 'noch-sichereres-passwort-43');
    await page.click('form [type=submit]');
    await page.waitForSelector('.form-error, .field-error');
    await page.waitForTimeout(200);
    const expected = problems.splice(before).filter((x) => !/status of 401/.test(x));
    problems.push(...expected);
  });
} finally {
  console.log(results.join('\n'));
  console.log(problems.length ? `Probleme:\n${problems.join('\n')}` : 'Keine Browser-Fehler.');
  const serverErrors = server.logs.filter((l) => l[0] === 'error');
  if (serverErrors.length) console.log('Server-Fehler:', serverErrors);
  console.log('KI-Anfragen (nachgebaut):', gemini.requests.length);
  await browser.close();
  await server.stop();
  await gemini.stop();
}
