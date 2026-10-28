// Browser-Test der neuen Ansichten: Übersicht, Zuordnen, Akten, Brief (Akte, Antwort, Fragen, Verlauf),
// Briefliste (Suche über Kennzeichen), Einstellungen (Haushalt, Dunkelmodus), Computer-Ansicht.
import assert from 'node:assert/strict';
import { chromium, startServer, watchPage, demoLogin, shot, SHOTS } from './harness.mjs';
import { startMockGemini } from './mock-gemini.mjs';

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
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  const page = await context.newPage();
  problems = watchPage(page, 'mobil');
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'X-BriefPilot': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  }, { method, path, body });

  await step('Demo-Anmeldung, KI erlauben', async () => {
    await demoLogin(page, server.base);
    const r = await call('POST', '/api/me/ai-consent', { consent: 'ja' });
    assert.equal(r.status, 200);
    await page.reload();
    await page.waitForSelector('.hello');
  });

  await step('Übersicht: Hinweis „Briefe warten auf Ihre Entscheidung“', async () => {
    await page.goto(`${server.base}/#/`);
    await page.waitForSelector('.inbox-alert');
    assert.match(await text(page, '.inbox-alert'), /2 Briefe warten auf Ihre Entscheidung/);
    assert.equal(await page.$eval('.nav-badge[data-count="inbox"]', (e) => e.textContent.trim()), '2');
    await shot(page, '10-uebersicht');
  });

  await step('Zuordnen: zwei Briefe, Nachweise, Auswahl übernehmen', async () => {
    await page.click('.inbox-alert');
    await page.waitForSelector('.decision-card');
    assert.equal(await page.$$eval('.decision-card', (e) => e.length), 2);
    const msgs = await page.$$eval('.decision-msg', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('  Meldungen:', msgs);
    assert.ok(msgs.some((m) => /zwei mögliche Verträge gefunden/.test(m)));
    await shot(page, '11-zuordnen');
    const card = page.locator('.decision-card', { hasText: 'zwei mögliche Verträge' });
    await card.locator('.choice').first().click();
    await card.locator('.learn').waitFor();
    await shot(page, '12-zuordnen-auswahl');
    await card.locator('[data-save]').click();
    await page.waitForFunction(() => document.querySelectorAll('.decision-card').length === 1, null, { timeout: 10000 });
    // zweiter Brief: gehört zu keiner Akte
    await page.click('.decision-card [data-none]');
    await page.waitForSelector('.empty');
    assert.match(await text(page, '.empty h2'), /Alles zugeordnet/);
    assert.equal(await page.$eval('.nav-badge[data-count="inbox"]', (e) => e.hidden), true);
  });

  await step('Akten: Liste gruppiert, Suche nach Kennzeichen', async () => {
    await page.goto(`${server.base}/#/akten`);
    await page.waitForSelector('.list-row');
    const heads = await page.$$eval('.month-head', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    console.log('  Gruppen:', heads);
    assert.ok(heads.some((h) => h.startsWith('Fahrzeuge (5)')));
    await shot(page, '13-akten');
    await page.fill('#oq', 'SB EF789');
    await page.waitForFunction(() => document.querySelectorAll('.list-row').length === 1, null, { timeout: 5000 });
    assert.match(await text(page, '.list-row .row-title'), /Fahrzeug 3/);
  });

  await step('Akte: Nummer und Vorgang hinzufügen', async () => {
    await page.click('.list-row');
    await page.waitForSelector('[data-id-add]');
    await page.selectOption('#nk', 'fin');
    await page.fill('#nv', 'WVWZZZ1JZXW000003');
    await page.click('[data-id-add] [type=submit]');
    await page.waitForFunction(() => document.body.textContent.includes('WVWZZZ1JZXW000003'));
    await page.fill('#ct', 'Steinschlag Frontscheibe');
    await page.click('[data-case-add] [type=submit]');
    await page.waitForFunction(() => document.body.textContent.includes('Steinschlag Frontscheibe'));
    await shot(page, '14-akte');
  });

  await step('Brief: Akte mit Nachweis', async () => {
    await page.click('section[aria-labelledby="letters-h"] .list-row');
    await page.waitForSelector('.assign-panel');
    await page.click('.why summary');
    const ev = await text(page, '.why .evidence');
    console.log('  Nachweis:', ev.slice(0, 160));
    assert.match(ev, /SB-EF 789|KFZ-003/);
    await shot(page, '15-brief-akte');
  });

  await step('Antwort: Vorlage → bearbeiten → PDF → kopieren → als versendet markieren', async () => {
    await page.click('.tabs [data-tab="antworten"]');
    await page.waitForSelector('[data-template="fristverlaengerung"]');
    await page.click('[data-template="fristverlaengerung"]');
    await page.waitForSelector('dialog #r-body');
    const body = await page.inputValue('dialog #r-body');
    assert.match(body, /\[Grund kurz nennen\]/);
    await page.fill('dialog #r-body', body.replace('[Grund kurz nennen]', 'ich im Urlaub bin').replace('[neues Datum]', '30.11.2026'));
    await shot(page, '16-antwort-editor');
    await page.click('dialog [type=submit]');
    await page.waitForSelector('.reply-card');
    assert.equal(await page.$$eval('.reply-card .task-notes', (e) => e.length), 0, 'keine Platzhalter mehr');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.reply-card [data-reply-act="pdf"]')]);
    const pdfPath = await download.path();
    const head = (await import('node:fs')).readFileSync(pdfPath).subarray(0, 5).toString();
    assert.equal(head, '%PDF-');
    await page.click('.reply-card [data-reply-act="copy"]');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /^Betreff: Bitte um Fristverlängerung/);
    await page.click('.reply-card [data-reply-act="email"]');
    await page.waitForSelector('dialog [data-mailto]');
    const href = await page.getAttribute('dialog [data-mailto]', 'href');
    assert.match(href, /^mailto:/);
    await shot(page, '17-antwort-email');
    await page.click('dialog [data-close]');
    await page.click('.reply-card [data-reply-act="mark"]');
    await page.check('dialog input[value="post"]');
    await page.click('dialog [type=submit]');
    await page.waitForSelector('.reply-card.is-sent');
    assert.match(await text(page, '.reply-card .badge-done'), /Versendet per Post/);
    await shot(page, '18-antwort-versendet');
  });

  await step('KI-Entwurf und Rückfrage (nachgebaute KI)', async () => {
    await page.fill('#ai-instr', 'Bitte um Erklärung der Beitragserhöhung');
    await page.click('[data-ai-reply] [type=submit]');
    await page.waitForSelector('dialog #r-body');
    assert.match(await page.inputValue('dialog #r-subject'), /Rückfrage zum Beitrag/);
    await page.click('dialog [data-close]');
    await page.click('.tabs [data-tab="erklaerung"]');
    await page.waitForSelector('[data-suggest]');
    await page.click('[data-suggest]');
    await page.waitForSelector('.chat-msg.is-antwort:not(.is-pending)', { timeout: 15000 });
    assert.match(await text(page, '.chat-msg.is-antwort .bubble'), /486,30/);
    await shot(page, '19-fragen');
    await page.click('[data-take-reply]');
    await page.waitForSelector('dialog #r-body');
    assert.match(await page.inputValue('dialog #r-body'), /drei Raten/);
    await page.click('dialog [data-close]');
    await page.click('.tabs [data-tab="erklaerung"]');
    await page.click('.history summary');
    const hist = await text(page, '.timeline');
    assert.match(hist, /Antwortentwurf erstellt/);
    assert.match(hist, /Antwort versendet/);
    assert.match(hist, /Frage an die KI/);
  });

  await step('Briefliste: Suche nach Kennzeichen, Filter „Ohne Akte“', async () => {
    await page.goto(`${server.base}/#/briefe`);
    await page.waitForSelector('.list-row');
    await page.fill('#q', 'SB-JK 567');
    await page.waitForFunction(() => document.querySelectorAll('.list-row').length >= 1 && [...document.querySelectorAll('.list-row')].every((r) => /Schaden|Fahrzeug 5/i.test(r.textContent)), null, { timeout: 5000 });
    await page.fill('#q', '');
    await page.click('[data-filter="ohne_akte"]');
    await page.waitForTimeout(600);
    const rows = await page.$$eval('.list-row .row-title', (els) => els.map((e) => e.textContent.trim()));
    console.log('  Ohne Akte:', rows);
    await shot(page, '20-briefe-ohne-akte');
  });

  await step('Einstellungen: Haushalt und Person hinzufügen; Dunkelmodus', async () => {
    await page.goto(`${server.base}/#/einstellungen`);
    await page.waitForSelector('#s-haushalt');
    assert.match(await text(page, 'section[aria-labelledby="s-haushalt"]'), /Lena Beispiel.*Max Beispiel/);
    await page.click('[data-action="person-add"]');
    await page.fill('dialog #pe-name', 'Mia Beispiel');
    await page.selectOption('dialog #pe-rel', 'kind');
    await page.click('dialog [type=submit]');
    await page.waitForFunction(() => document.body.textContent.includes('Mia Beispiel'));
    await page.click('label.chip:has(input[name="theme"][value="dunkel"])');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.goto(`${server.base}/#/`);
    await page.waitForSelector('.hello');
    await shot(page, '21-uebersicht-dunkel');
    await page.goto(`${server.base}/#/akten`);
    await page.waitForSelector('.list-row');
    await shot(page, '22-akten-dunkel');
  });

  await step('Computer-Ansicht (1280 px): Brief mit Original daneben', async () => {
    const desk = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await desk.addCookies(await context.cookies()); // gleiche Sitzung übernehmen
    const p2 = await desk.newPage();
    const deskProblems = watchPage(p2, 'desktop');
    await p2.goto(`${server.base}/#/`);
    await p2.waitForSelector('.hello');
    await p2.screenshot({ path: `${SHOTS}/23-desktop-uebersicht.png` });
    await p2.goto(`${server.base}/#/briefe`);
    await p2.waitForSelector('.list-row');
    await p2.click('.list-row');
    await p2.waitForSelector('.detail-original .original-page, .detail-original p');
    await p2.waitForTimeout(800);
    await p2.screenshot({ path: `${SHOTS}/24-desktop-brief.png` });
    await p2.goto(`${server.base}/#/akten`);
    await p2.waitForSelector('.list-row');
    await p2.click('.list-row');
    await p2.waitForSelector('[data-id-add]');
    await p2.screenshot({ path: `${SHOTS}/25-desktop-akte.png`, fullPage: true });
    problems.push(...deskProblems);
    await desk.close();
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
