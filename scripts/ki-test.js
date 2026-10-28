// Prüft die Verbindung zum eingestellten KI-Anbieter mit einer winzigen Testanfrage (ohne Briefdaten).
// Aufruf: npm run ki-test
import { loadConfig } from '../server/config.js';
import { createAiClient } from '../server/analysis/client.js';

const config = loadConfig(process.env);
const ai = createAiClient(config);

if (!ai.enabled) {
  console.log('Es ist keine KI eingerichtet.');
  console.log('So geht es kostenlos: https://aistudio.google.com/apikey öffnen, „API-Schlüssel erstellen“ wählen,');
  console.log('den Schlüssel in die Datei .env bei GEMINI_API_KEY= eintragen und „npm run ki-test“ erneut ausführen.');
  process.exit(1);
}

console.log(`Teste ${ai.label} (Modell ${ai.model}${config.ai.fallbackModel ? `, Ersatz ${config.ai.fallbackModel}` : ''}) …`);
// Für den Test kein langes Warten auf Minutenlimits
config.ai.retryDelayMs = Math.min(config.ai.retryDelayMs, 2000);
const started = Date.now();
try {
  const { result, model } = await ai.completeJson({
    system: 'Du bist ein Verbindungstest. Antworte ausschließlich mit dem verlangten JSON.',
    prompt: 'Antworte mit {"ok": true, "gruss": "Hallo"}.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'gruss'],
      properties: { ok: { type: 'boolean' }, gruss: { type: 'string' } },
    },
    maxTokens: 256,
  });
  if (result?.ok !== true) throw new Error(`Unerwartete Antwort: ${JSON.stringify(result).slice(0, 200)}`);
  console.log(`✓ Verbindung klappt (${model || ai.model}, ${((Date.now() - started) / 1000).toFixed(1)} s). Die KI-Auswertung ist bereit.`);
  console.log('  Hinweis: Jeder Test zählt zum kostenlosen Tageskontingent.');
} catch (err) {
  console.log(`✗ Die KI-Anfrage hat nicht geklappt: ${err.message}`);
  if (err.code) console.log(`  (Fehlerart: ${err.code})`);
  const tips = {
    schluessel: 'Tipp: Den Schlüssel in .env vollständig und ohne Leerzeichen eintragen (bei Gemini: GEMINI_API_KEY=).',
    netzwerk: 'Tipp: Internetverbindung prüfen. Blockiert eine Firewall oder ein Virenschutz Node.js?',
    timeout: 'Tipp: Später erneut versuchen; bei langsamer Verbindung AI_TIMEOUT_SECONDS in .env erhöhen.',
    modell: 'Tipp: Den Modellnamen in .env prüfen – oder die Zeile leer lassen, dann gilt die Vorgabe.',
    kontingent: 'Tipp: Das kostenlose Kontingent erholt sich von selbst (Minutenlimit nach einer Minute, Tageslimit am nächsten Tag).',
  };
  console.log(`  ${tips[err.code] || 'Tipp: Schlüssel in .env und Internetverbindung prüfen.'}`);
  process.exit(1);
}
