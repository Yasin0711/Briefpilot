// Bereitet Dateien für die KI so vor, dass auch große Dokumente günstig bleiben:
//  - PowerPoint/Word/Excel und PDFs mit Textebene: Text wird lokal ausgelesen (kostenlos)
//    und der KI nur als Text gegeben – bei langen Dokumenten nur der Anfang.
//  - Gescannte PDFs (ohne Text): bei vielen Seiten bekommt die KI nur die ersten Seiten.
//  - Fotos: wie bisher.
// Der vollständige, lokal gelesene Text wird für Suche und Anzeige gespeichert.
import { extractPdfText, inspectPdf } from '../pdf/extract.js';
import { subsetPdf } from '../pdf/sanitize.js';
import { extractOfficeText } from '../lib/office.js';

export const AI_TEXT_BUDGET = 60000; // Zeichen Text insgesamt an die KI (≈ 15.000 Token)
export const AI_SCAN_PAGES = 20; // Seiten eines gescannten PDFs, die die KI höchstens liest

const meaningful = (t) => String(t || '').replace(/\s|-|Seite \d+|Folie \d+/g, '').length;

/**
 * @param {{kind, mime, data}[]} files
 * @returns {{ aiFiles: object[], localText: string, notes: string[], hasScans: boolean }}
 */
export function prepareForAi(files) {
  const aiFiles = [];
  const localParts = [];
  const notes = [];
  let budget = AI_TEXT_BUDGET;
  let hasScans = false;
  files.forEach((f, i) => {
    if (f.kind === 'office') {
      let text = '';
      try {
        text = extractOfficeText(f.data).text;
      } catch {
        text = '';
      }
      localParts.push(text);
      const part = text.slice(0, Math.max(0, budget));
      budget -= part.length;
      aiFiles.push({ kind: 'text', text: part || '(kein Text gefunden)', label: `Datei ${i + 1} (Office-Dokument)` });
      if (part.length < text.length) notes.push(`Datei ${i + 1} ist lang (${text.length} Zeichen); du siehst nur den Anfang.`);
      return;
    }
    if (f.kind === 'pdf') {
      const { text } = extractPdfText(f.data);
      const pages = inspectPdf(f.data).pageCount || 1;
      if (meaningful(text) >= Math.min(200 * pages, 2000)) {
        localParts.push(text);
        const part = text.slice(0, Math.max(0, budget));
        budget -= part.length;
        aiFiles.push({ kind: 'text', text: part, label: `Datei ${i + 1} (PDF mit ${pages} Seiten, Text ausgelesen)` });
        if (part.length < text.length) notes.push(`Datei ${i + 1} hat ${pages} Seiten; du siehst nur den Anfang des Textes.`);
        return;
      }
      hasScans = true;
      if (pages > AI_SCAN_PAGES) {
        try {
          const sub = subsetPdf(f.data, AI_SCAN_PAGES);
          aiFiles.push({ kind: 'pdf', mime: 'application/pdf', data: sub.pdf });
          notes.push(`Datei ${i + 1} ist ein Scan mit ${pages} Seiten; du siehst nur die ersten ${sub.pages}.`);
          return;
        } catch {
          /* Auszug nicht möglich: ganze Datei */
        }
      }
      aiFiles.push(f);
      return;
    }
    hasScans = true;
    aiFiles.push(f);
  });
  return { aiFiles, localText: localParts.filter((t) => meaningful(t) > 0).join('\n\n').trim(), notes, hasScans };
}

/** Hinweis an die KI für Dokumente, die schon als Text vorliegen oder gekürzt sind. */
export function preparationNote({ aiFiles, notes }) {
  const lines = [];
  if (aiFiles.some((f) => f.kind === 'text')) {
    lines.push('Einige Dateien liegen bereits als ausgelesener Text vor. Für diese Dateien schreibst du KEINE Abschrift in full_text – full_text enthält nur die Abschrift von Fotos bzw. gescannten Seiten (sonst leer "").');
    lines.push('Es kann sich auch um ein anderes Dokument als einen Brief handeln (z. B. Präsentation, Schulungsunterlagen, Vertrag, Zertifikat). Setze document_type passend und lege Aufgaben nur an, wenn das Dokument wirklich etwas verlangt.');
  }
  lines.push(...notes);
  return lines.join('\n');
}
