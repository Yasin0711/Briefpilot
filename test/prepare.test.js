// Sparsame KI-Vorbereitung: Text statt Datei, Kürzung, Scan-Auszug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareForAi, preparationNote, AI_TEXT_BUDGET, AI_SCAN_PAGES } from '../server/analysis/prepare.js';
import { buildPdf, buildScanPdf } from '../server/pdf/write.js';
import { inspectPdf } from '../server/pdf/extract.js';
import { makePptx } from './office-fixtures.js';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAA4ACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0WiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP//Z', 'base64');

test('Digitale PDF mit 900 Seiten: nur Text an die KI, gekürzt; voller Text bleibt lokal', () => {
  const pages = Array.from({ length: 900 }, (_, i) => [{ type: 'text', x: 72, y: 720, text: `Seite ${i + 1}: Lerninhalt zum Thema Brandschutz und Arbeitssicherheit im Betrieb.`, size: 11 }]);
  const pdf = buildPdf(pages);
  const p = prepareForAi([{ kind: 'pdf', mime: 'application/pdf', data: pdf }]);
  assert.equal(p.aiFiles[0].kind, 'text');
  assert.ok(p.aiFiles[0].text.length <= AI_TEXT_BUDGET);
  assert.match(p.localText, /Seite 900:/, 'vollständiger Text für die Suche');
  assert.match(preparationNote(p), /nur den Anfang/);
  assert.match(preparationNote(p), /KEINE Abschrift/);
});

test('Gescannte PDF mit 45 Seiten: KI bekommt nur die ersten Seiten', () => {
  const pdf = buildScanPdf(Array.from({ length: 45 }, () => JPEG), { title: 'Scan' });
  assert.equal(inspectPdf(pdf).pageCount, 45);
  const p = prepareForAi([{ kind: 'pdf', mime: 'application/pdf', data: pdf }]);
  assert.equal(p.aiFiles[0].kind, 'pdf');
  assert.equal(inspectPdf(p.aiFiles[0].data).pageCount, AI_SCAN_PAGES);
  assert.ok(p.aiFiles[0].data.length < pdf.length);
  assert.match(preparationNote(p), /ersten 20/);
});

test('PowerPoint: Text an die KI', () => {
  const p = prepareForAi([{ kind: 'office', mime: 'x', data: makePptx(['Seminar Erste Hilfe', 'Teilnahmebescheinigung']) }]);
  assert.equal(p.aiFiles[0].kind, 'text');
  assert.match(p.aiFiles[0].text, /Erste Hilfe/);
});
