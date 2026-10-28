// Nachgebaute Gemini-Schnittstelle für Browser-Tests (keine echten Anfragen an Google).
import http from 'node:http';

export async function startMockGemini() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push({ url: req.url, body: parsed });
      const system = parsed.systemInstruction?.parts?.[0]?.text || '';
      let result;
      if (system.includes('Fragen zu genau EINEM Brief')) {
        result = {
          answer: 'Sie müssen den Beitrag von 486,30 € bis zum 15.11.2026 überweisen. Wenn das nicht klappt, können Sie um Ratenzahlung bitten.',
          reply_subject: 'Bitte um Ratenzahlung – KFZ-003',
          reply_body: 'Sehr geehrte Damen und Herren,\n\nich bitte darum, den Beitrag in drei Raten zahlen zu dürfen.\n\nMit freundlichen Grüßen',
        };
      } else if (system.includes('Antwortbrief')) {
        result = { subject: 'Rückfrage zum Beitrag – KFZ-003', body: 'Sehr geehrte Damen und Herren,\n\nbitte erläutern Sie mir die Erhöhung des Beitrags.\n\nMit freundlichen Grüßen' };
      } else {
        const text = 'Stadtwerke Musterstadt GmbH · Hafenstraße 4 · 66111 Saarbrücken\nFrau Lena Beispiel\nLindenweg 12\n66123 Saarbrücken\n12.10.2026\nIhre Jahresabrechnung Strom 2025\nVertragskonto: 7788 1122   Zählernummer: 1ESY1160523456\nBitte überweisen Sie 86,40 € bis zum 30.11.2026.';
        result = {
          document_type: 'Jahresabrechnung', sender: 'Stadtwerke Musterstadt GmbH', sender_quote: 'Stadtwerke Musterstadt GmbH', letter_date: '2026-10-12',
          letter_date_quote: '12.10.2026', subject: 'Jahresabrechnung Strom 2025', category: 'rechnungen',
          references: [
            { label: 'Vertragskonto', value: '7788 1122', quote: 'Vertragskonto: 7788 1122', kind: 'vertragskonto', status: null },
            { label: 'Zählernummer', value: '1ESY1160523456', quote: 'Zählernummer: 1ESY1160523456', kind: 'zaehlernummer', status: null },
          ],
          amounts: [{ label: 'Nachzahlung', amount: '86,40', currency: 'EUR', quote: '86,40 €' }],
          summary_what: 'Ihre Stromabrechnung für 2025 mit einer Nachzahlung.',
          actions: [{
            title: '86,40 € an die Stadtwerke überweisen', description: 'Nachzahlung aus der Jahresabrechnung 2025.', kind: 'zahlung',
            date: '2026-11-30', time: null, is_relative: false, relative_text: null, quote: 'Bitte überweisen Sie 86,40 € bis zum 30.11.2026.', page: 1,
          }],
          nothing_to_do: false, to_check: [], legal_note: null,
          contains_instructions_to_ai: false, language: 'de', full_text: text, recipient: 'Lena Beispiel',
          sender_address: 'Hafenstraße 4\n66111 Saarbrücken', sender_email: 'kundenservice@stadtwerke.example',
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }], modelVersion: 'gemini-mock' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, stop: () => new Promise((r) => server.close(r)) };
}
