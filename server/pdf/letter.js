// Antwortbrief als druckfertiges PDF – angelehnt an DIN 5008 (Form B):
// Absender, Anschriftfeld für Fensterumschläge, Infoblock, Datum, Betreff, Text,
// Unterschriftsbereich sowie Falz- und Lochmarken.
import { buildPdf, wrapText, textWidth } from './write.js';
import { formatDate } from '../../public/js/shared/dates.js';

const MM = 2.8346;
const PAGE_H = 842;
const LEFT = 25 * MM;
const RIGHT = 595 - 20 * MM;
const BODY_SIZE = 11;
const LEADING = 15.5;
const fromTop = (mm) => PAGE_H - mm * MM;

function lines(value) {
  return String(value || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * reply: { subject, body, recipient: {name, address}, sender: {name, address, email, phone},
 *          place, date (YYYY-MM-DD), references: [{label, value}], theirDate }
 */
export function renderReplyPdf(reply) {
  const pages = [[]];
  let page = pages[0];
  const text = (x, y, value, opts = {}) => page.push({ type: 'text', x, y, text: value, ...opts });
  const sender = reply.sender || {};
  const recipient = reply.recipient || {};
  const senderLines = lines(sender.address);

  // Briefkopf: Absender
  if (sender.name) text(LEFT, fromTop(15), sender.name, { size: 13, bold: true });
  const contact = [senderLines.join(' · '), sender.phone ? `Tel. ${sender.phone}` : '', sender.email || ''].filter(Boolean).join(' · ');
  if (contact) {
    let y = fromTop(20.5);
    for (const l of wrapText(contact, RIGHT - LEFT, 8.5)) {
      text(LEFT, y, l, { size: 8.5, gray: 0.3 });
      y -= 11;
    }
  }

  // Anschriftfeld (45 mm von oben) mit Rücksendeangabe
  const returnLine = [sender.name, ...senderLines].filter(Boolean).join(' · ');
  if (returnLine) text(LEFT, fromTop(49), returnLine.slice(0, 95), { size: 6.5, gray: 0.4 });
  let y = fromTop(56);
  for (const l of [recipient.name, ...lines(recipient.address)].filter(Boolean).slice(0, 7)) {
    text(LEFT, y, l, { size: 10.5 });
    y -= 13.5;
  }

  // Infoblock rechts
  let infoY = fromTop(50);
  const info = [];
  for (const r of (reply.references || []).slice(0, 4)) info.push(`${r.label}: ${r.value}`);
  if (reply.theirDate) info.push(`Ihr Schreiben vom: ${formatDate(reply.theirDate, { short: true })}`);
  for (const l of info) {
    for (const part of wrapText(l, RIGHT - 125 * MM, 8.5)) {
      text(125 * MM, infoY, part, { size: 8.5 });
      infoY -= 11.5;
    }
  }

  // Ort und Datum
  const dateLine = `${reply.place ? `${reply.place}, ` : ''}${formatDate(reply.date, { short: true })}`;
  text(RIGHT - textWidth(dateLine, 10.5), fromTop(98.5), dateLine, { size: 10.5 });

  // Betreff
  y = fromTop(107);
  for (const l of wrapText(reply.subject || 'Ihr Schreiben', RIGHT - LEFT, 11.5, true)) {
    text(LEFT, y, l, { size: 11.5, bold: true });
    y -= 16;
  }
  y -= 12;

  const newPageIfNeeded = (needed = 0) => {
    if (y - needed < 80) {
      page = [];
      pages.push(page);
      text(LEFT, PAGE_H - 40, `${sender.name ? `${sender.name} – ` : ''}${reply.subject || ''}`.slice(0, 90), { size: 8, gray: 0.45 });
      text(RIGHT - textWidth(`Seite ${pages.length}`, 8), PAGE_H - 40, `Seite ${pages.length}`, { size: 8, gray: 0.45 });
      y = PAGE_H - 70;
    }
  };

  const paragraphs = String(reply.body || '').replace(/\r\n/g, '\n').split(/\n/);
  for (const p of paragraphs) {
    if (!p.trim()) {
      y -= LEADING * 0.6;
      continue;
    }
    for (const l of wrapText(p, RIGHT - LEFT, BODY_SIZE)) {
      newPageIfNeeded();
      text(LEFT, y, l, { size: BODY_SIZE });
      y -= LEADING;
    }
  }

  // Unterschriftsbereich
  y -= 8;
  newPageIfNeeded(70);
  y -= 42;
  page.push({ type: 'line', x1: LEFT, y1: y, x2: LEFT + 190, y2: y, gray: 0.5, width: 0.5 });
  y -= 13;
  text(LEFT, y, sender.name ? `${sender.name} (Unterschrift)` : 'Unterschrift', { size: 9, gray: 0.35 });

  // Falzmarken (105 mm, 210 mm) und Lochmarke (148,5 mm) auf der ersten Seite
  pages[0].push({ type: 'line', x1: 3.5 * MM, y1: fromTop(105), x2: 8.5 * MM, y2: fromTop(105), gray: 0.55, width: 0.4 });
  pages[0].push({ type: 'line', x1: 3.5 * MM, y1: fromTop(210), x2: 8.5 * MM, y2: fromTop(210), gray: 0.55, width: 0.4 });
  pages[0].push({ type: 'line', x1: 3.5 * MM, y1: fromTop(148.5), x2: 10.5 * MM, y2: fromTop(148.5), gray: 0.55, width: 0.4 });

  return buildPdf(pages, { title: reply.subject || 'Antwortbrief' });
}
