// Stichprobe Barrierefreiheit (ohne Zusatzpakete): Bedienelemente mit Namen, Bilder mit Alternativtext,
// Farbkontrast nach WCAG 2.2 (AA) – auf den wichtigsten Seiten, hell und dunkel, Handy und Computer.
import { chromium, startServer, demoLogin } from './harness.mjs';
import { startMockGemini } from './mock-gemini.mjs';

const gemini = await startMockGemini();
const server = await startServer({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'AIza-test-0123456789abcdef', GEMINI_BASE_URL: gemini.url, GEMINI_FALLBACK_MODEL: '' });
const browser = await chromium.launch();

/** Läuft im Browser: sammelt Verstöße auf der aktuellen Seite. */
function audit() {
  const out = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const nameOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l?.textContent.trim()) return l.textContent.trim();
    }
    const wrap = el.closest('label');
    if (wrap?.textContent.trim()) return wrap.textContent.trim();
    if (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type)) return el.value;
    const t = el.textContent.trim();
    if (t) return t;
    return el.getAttribute('title') || el.querySelector('img[alt]')?.alt || '';
  };
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio]')) {
    if (el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) continue;
    // Versteckte Eingabefelder in Schaltern (Chips) zählen über ihr Label
    if (!visible(el) && !(el.matches('input') && el.closest('label'))) continue;
    if (!nameOf(el)) out.push(`Ohne Namen: ${label(el)}`);
  }
  for (const img of document.querySelectorAll('img')) {
    if (!img.hasAttribute('alt') && visible(img)) out.push(`Bild ohne alt: ${img.src.slice(-40)}`);
  }
  // Kontrast
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    let layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null; // Verlauf/Bild: nicht prüfbar
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    if (!layers.length) return { r: 255, g: 255, b: 255 };
    let base = layers.pop();
    if (base.a < 1) base = { r: 255, g: 255, b: 255 };
    for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) };
    return base;
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || !visible(el) || el.closest('[aria-hidden="true"], .visually-hidden, .scanner')) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    const bg = bgOf(el);
    if (!fg || !bg) continue;
    const fgMixed = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) } : fg;
    const L1 = lum(fgMixed);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.push(`Kontrast ${ratio.toFixed(2)} < ${need}: „${node.textContent.trim().slice(0, 40)}“ (${label(el)})`);
  }
  return { issues: [...new Set(out)], checked: seen.size };
}

const pages = [
  ['Übersicht', '/#/'],
  ['Scannen', '/#/scannen'],
  ['Briefe', '/#/briefe'],
  ['Zuordnen', '/#/zuordnen'],
  ['Akten', '/#/akten'],
  ['Aufgaben', '/#/aufgaben'],
  ['Einstellungen', '/#/einstellungen'],
  ['Status', '/#/status'],
  ['Datenschutz', '/#/datenschutz'],
  ['Pro', '/#/pro'],
];
let total = 0;
let checkedTotal = 0;
try {
  for (const [theme, viewport] of [['light', { width: 390, height: 844 }], ['dark', { width: 390, height: 844 }], ['light', { width: 1366, height: 900 }]]) {
    const context = await browser.newContext({ viewport, colorScheme: theme });
    const page = await context.newPage();
    await demoLogin(page, server.base);
    const extra = [];
    // Erste Akte und erster Brief (alle Reiter)
    const firstObject = await page.evaluate(async () => (await (await fetch('/api/objects', { headers: { 'X-BriefPilot': '1' } })).json()).objects[0].id);
    const letters = await page.evaluate(async () => (await (await fetch('/api/letters', { headers: { 'X-BriefPilot': '1' } })).json()).letters.map((l) => l.id));
    extra.push(['Akte', `/#/akten/${firstObject}`]);
    for (const tab of ['', '?ansicht=antworten', '?ansicht=original', '?ansicht=text']) extra.push([`Brief${tab}`, `/#/briefe/${letters[2]}${tab}`]);
    for (const [name, url] of [...pages, ...extra]) {
      await page.goto(server.base + url);
      await page.waitForTimeout(700);
      const { issues, checked } = await page.evaluate(audit);
      checkedTotal += checked;
      total += issues.length;
      if (issues.length) console.log(`[${theme} ${viewport.width}px] ${name}:\n  - ${issues.slice(0, 12).join('\n  - ')}${issues.length > 12 ? `\n  … ${issues.length - 12} weitere` : ''}`);
    }
    await context.close();
  }
  console.log(`${checkedTotal} Textelemente geprüft. ${total ? `Gefunden: ${total} Hinweise` : 'Keine Verstöße gefunden.'}`);
} finally {
  await browser.close();
  await server.stop();
  await gemini.stop();
}
