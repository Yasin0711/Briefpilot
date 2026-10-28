// Einfache Erkennung OHNE KI – für PDFs mit Textebene, wenn keine KI eingerichtet
// oder freigegeben ist. Liefert dasselbe Format wie die KI, aber ohne Erklärung in
// einfacher Sprache. Alles wird anschließend genauso geprüft wie KI-Ergebnisse.
import { parseGermanDates, parseTimes, parseRelativeDeadline, formatDate } from '../../public/js/shared/dates.js';
import { extractIdentifiers } from '../../public/js/shared/identifiers.js';

const CATEGORY_KEYWORDS = {
  behoerden: /(finanzamt|bürgeramt|stadtverwaltung|landratsamt|gemeinde|jobcenter|agentur für arbeit|familienkasse|rentenversicherung|ausländerbehörde|bescheid|behörde|amtsgericht|bundesamt|zulassungsstelle|standesamt|rundfunkbeitrag)/gi,
  versicherungen: /(versicherung|versicherungsschein|police|haftpflicht|hausrat|kfz-versicherung)/gi,
  gesundheit: /(praxis|arzt|ärztin|klinik|krankenhaus|krankenkasse|zahnarzt|apotheke|patient|vorsorge|behandlung)/gi,
  wohnen: /(vermieter|hausverwaltung|miete|nebenkosten|wohnung|heizkosten|eigentümer|ablesung|mietvertrag)/gi,
  arbeit: /(arbeitgeber|gehalt|lohnabrechnung|arbeitsvertrag|personalabteilung|urlaubsantrag|bewerbung)/gi,
  vertraege: /(vertrag|kündigung|laufzeit|tarif|vertragsänderung|preisanpassung)/gi,
  rechnungen: /(rechnung|zahlungserinnerung|mahnung|nachzahlung|abrechnung|rechnungsbetrag|offener betrag)/gi,
  bank: /(sparkasse|volksbank|bank\b|kontoauszug|kredit|depot|girokonto)/gi,
};

const REFERENCE_PATTERN =
  /(Aktenzeichen|Az\.|Kundennummer|Kunden-Nr\.?|Vertragsnummer|Vertrags-Nr\.?|Versicherungsnummer|Versicherungsschein-?(?:nummer|Nr\.?)?|Rechnungsnummer|Rechnungs-Nr\.?|Steuernummer|Steuer-Nr\.?|Steuer-ID|Kassenzeichen|Mitgliedsnummer|Versichertennummer|Zählernummer|Vertragskonto|Buchungszeichen|Geschäftszeichen|Unser Zeichen|Ihr Zeichen|Patientennummer|Mietobjekt)\s*[:.]?\s*([A-Za-z0-9][A-Za-z0-9\-/. ]{2,40})/g;

const AMOUNT_PATTERN = /(?:(?:€|EUR)\s?(\d{1,3}(?:\.\d{3})*,\d{2}))|(?:(\d{1,3}(?:\.\d{3})*,\d{2})\s?(?:€|EUR|Euro))/g;

const ACTION_HINT = /(bis\s+(zum|spätestens)|spätestens|innerhalb|binnen|frist|fällig|termin|überweisen|zahlen\s+sie|begleichen|einreichen|zurücksenden|vorlegen|mitbringen|melden sie sich|vereinbaren|widerspruch|einspruch|kündigen)/i;

function amountLabel(context) {
  const m = /(Nachzahlung|Gesamtbetrag|Rechnungsbetrag|Erstattung|Guthaben|Abschlag|Beitrag|Mahngebühr|offener Betrag|Restbetrag|Betrag)/i.exec(context);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : 'Betrag';
}

function pickCategory(text) {
  let best = 'sonstiges';
  let bestScore = 0;
  for (const [id, re] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = (text.match(re) || []).length;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function splitSentences(text) {
  return text
    .replace(/--- Seite \d+ ---/g, '\n')
    .split(/\n{2,}/)
    .flatMap((block) => block.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„"])/))
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

export function analyzeWithRules(fullText) {
  const text = String(fullText || '');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/^--- (Seite|Folie|Tabelle) \d+ ---$/.test(l));
  const salutationIndex = lines.findIndex((l) => /^(sehr geehrte|guten tag|hallo|liebe[rs]?\s)/i.test(l));
  const headerEnd = salutationIndex > 0 ? salutationIndex : Math.min(lines.length, 25);

  // Absender: erste Zeile (Absenderzeile über dem Adressfeld)
  let sender = null;
  if (lines[0]) sender = lines[0].split(/\s[·|•]\s|,\s/)[0].trim().slice(0, 80) || null;

  // Briefdatum: „Ort, 12.10.2026“, „Datum: …“ oder alleinstehendes Datum im Kopf
  let letterDate = null;
  let letterDateQuote = null;
  for (const line of lines.slice(0, headerEnd + 1)) {
    if (/^(datum|den)\b/i.test(line) || /^[A-ZÄÖÜ][\p{L} .-]{1,40},\s*(den\s+)?\d/u.test(line) || /^\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}$/.test(line)) {
      const dates = parseGermanDates(line);
      if (dates.length) {
        letterDate = dates[0].date;
        letterDateQuote = line;
        break;
      }
    }
  }

  // Betreff
  let subject = null;
  const betreff = lines.find((l) => /^(betreff|betr\.)\s*:?/i.test(l));
  if (betreff) subject = betreff.replace(/^(betreff|betr\.)\s*:?\s*/i, '').slice(0, 200);
  else if (salutationIndex > 0) {
    for (let i = salutationIndex - 1; i >= Math.max(0, salutationIndex - 4); i--) {
      const l = lines[i];
      if (!parseGermanDates(l).length && !REFERENCE_PATTERN.test(l) && l.length > 5) {
        subject = l.slice(0, 200);
        break;
      }
      REFERENCE_PATTERN.lastIndex = 0;
    }
  }
  REFERENCE_PATTERN.lastIndex = 0;

  // Aktenzeichen, Kunden-, Vertrags-, Zählernummern, Kennzeichen … (mit Art der Kennung)
  const references = extractIdentifiers(text).map((i) => ({ label: i.label, value: i.value, quote: i.quote, kind: i.kind, status: i.status }));

  // Absenderanschrift („Firma · Straße 1 · 12345 Ort“), E-Mail, Empfänger
  let senderAddress = null;
  for (const line of lines.slice(0, 8)) {
    const parts = line.split(/\s[·|•]\s/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3 && parts.some((p) => /\b\d{5}\b/.test(p))) {
      senderAddress = parts.slice(1).join('\n');
      break;
    }
  }
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(text);
  let recipient = null;
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const m = /^(Frau|Herrn?|Familie|Eheleute)\b\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    recipient = (m[2] || lines[i + 1] || '').trim().slice(0, 120) || null;
    break;
  }

  // Beträge
  const amounts = [];
  for (const line of lines) {
    for (const m of line.matchAll(AMOUNT_PATTERN)) {
      const amount = m[1] || m[2];
      if (!amounts.some((a) => a.amount === amount)) amounts.push({ label: amountLabel(line), amount, currency: 'EUR', quote: line });
    }
  }

  // Aufgaben und Fristen
  const actions = [];
  for (const sentence of splitSentences(text)) {
    if (!ACTION_HINT.test(sentence)) continue;
    let dates = parseGermanDates(sentence).map((d) => d.date);
    if (dates.length > 1 && letterDate) dates = dates.filter((d) => d !== letterDate);
    const times = parseTimes(sentence);
    const relative = dates.length ? null : parseRelativeDeadline(sentence);
    const amountMatch = [...sentence.matchAll(AMOUNT_PATTERN)][0];
    const amount = amountMatch ? amountMatch[1] || amountMatch[2] : null;
    let kind = 'aufgabe';
    if (/(überweis|zahlen|begleichen|betrag|fällig)/i.test(sentence)) kind = 'zahlung';
    else if (times.length || /\btermin\b/i.test(sentence)) kind = dates.length ? 'termin' : 'aufgabe';
    else if (dates.length || relative) kind = 'frist';
    if (!dates.length && !relative && kind !== 'zahlung' && !/\bbitte\b/i.test(sentence)) continue;

    let title = 'Aufgabe aus dem Brief prüfen';
    if (kind === 'zahlung') title = amount ? `Zahlung über ${amount} € prüfen` : 'Zahlung prüfen';
    else if (kind === 'termin') title = 'Termin wahrnehmen';
    else if (/(widerspruch|einspruch)/i.test(sentence)) title = 'Frist für Widerspruch/Einspruch beachten';
    else if (/kündig/i.test(sentence)) title = 'Kündigungsfrist beachten';
    else if (/(unterlagen|nachweis|einreichen|zurücksenden|vorlegen)/i.test(sentence)) title = 'Unterlagen einreichen';
    else if (kind === 'frist') title = 'Frist beachten';

    const date = dates[dates.length - 1] || null;
    if (actions.some((a) => a.kind === kind && a.date === date && a.relative_text === (relative?.text || null))) continue;
    actions.push({
      title,
      description: null,
      kind,
      date,
      time: kind === 'termin' ? times[0] || null : null,
      is_relative: Boolean(relative),
      relative_text: relative ? relative.text : null,
      quote: sentence.slice(0, 600),
      page: null,
    });
    if (actions.length >= 8) break;
  }

  const legal = /(rechtsbehelfsbelehrung|widerspruch|einspruch|klage erheben)/i.test(text);
  const parts = [];
  if (sender) parts.push(`von ${sender}`);
  if (letterDate) parts.push(`vom ${formatDate(letterDate)}`);
  const summary = `Automatisch erkannt (ohne KI): ein Schreiben ${parts.join(' ')}${subject ? ` zum Thema „${subject}“` : ''}. Eine Erklärung in einfacher Sprache gibt es nur mit KI-Auswertung. Bitte lesen Sie den Brief selbst und prüfen Sie die erkannten Angaben.`;

  return {
    document_type: null,
    sender,
    sender_quote: lines[0] || null,
    letter_date: letterDate,
    letter_date_quote: letterDateQuote,
    subject,
    category: pickCategory(text),
    references: references.slice(0, 20),
    amounts: amounts.slice(0, 10),
    summary_what: summary,
    actions,
    nothing_to_do: false,
    to_check: ['Diese Auswertung beruht auf einfachen Suchregeln, nicht auf KI. Sie kann Angaben übersehen oder falsch zuordnen.'],
    legal_note: legal ? 'Der Brief enthält einen Hinweis auf Widerspruch, Einspruch oder Klage. Solche Fristen sind wichtig. Lassen Sie sich im Zweifel beraten.' : null,
    contains_instructions_to_ai: false,
    language: 'de',
    full_text: text,
    recipient,
    sender_address: senderAddress,
    sender_email: email ? email[0] : null,
  };
}
