// Einrichtung: erzeugt die Datei .env mit neuen, zufälligen Schlüsseln.
// Fragt (nur im Terminal) optional nach einem kostenlosen Gemini-Schlüssel für die KI-Auswertung.
// Ohne Rückfragen: „npm run setup -- --ohne-fragen“ oder GEMINI_API_KEY als Umgebungsvariable mitgeben.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys } from '../server/lib/push.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js ${process.versions.node} ist zu alt. Bitte Node.js 22.13 oder neuer installieren (empfohlen: aktuelle LTS-Version).`);
  process.exit(1);
}

if (fs.existsSync(envPath)) {
  console.log('Die Datei .env existiert bereits – sie wird nicht überschrieben.');
  console.log('(Wenn Sie neu anfangen möchten: .env löschen und „npm run setup“ erneut ausführen.');
  console.log(' Achtung: Mit einem neuen Schlüssel sind bereits gespeicherte Briefe nicht mehr lesbar.)');
  process.exit(0);
}

/** Fragt im Terminal nach dem Gemini-Schlüssel (Enter = später). */
async function askGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  if (!process.stdin.isTTY || process.argv.includes('--ohne-fragen')) return '';
  console.log('');
  console.log('KI-Auswertung – kostenlos mit Google Gemini (für Fotos von Briefen nötig):');
  console.log('  1. https://aistudio.google.com/apikey öffnen und mit einem Google-Konto anmelden');
  console.log('  2. „API-Schlüssel erstellen“ (Create API key) wählen und den Schlüssel kopieren');
  console.log('  Kosten: keine, solange kein Rechnungskonto verknüpft ist. Nutzung ab 18 Jahren.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('  Schlüssel einfügen und Enter drücken (nur Enter = später in .env eintragen): ');
    return answer.trim();
  } finally {
    rl.close();
  }
}

let content = fs.readFileSync(examplePath, 'utf8');
const vapid = generateVapidKeys();
const set = (key, value) => {
  content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
};
set('FILE_ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64'));
set('VAPID_PUBLIC_KEY', vapid.publicKey);
set('VAPID_PRIVATE_KEY', vapid.privateKey);

const geminiKey = await askGeminiKey();
if (geminiKey) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(geminiKey)) {
    console.log('  Hinweis: Der Schlüssel sieht ungewöhnlich aus (erwartet: Buchstaben, Ziffern, - und _). Er wird trotzdem eingetragen – bitte prüfen.');
  }
  set('GEMINI_API_KEY', geminiKey);
  set('AI_PROVIDER', 'gemini');
}
fs.writeFileSync(envPath, content, { mode: 0o600 });

console.log('');
console.log('✓ Datei .env wurde angelegt (mit neuem Verschlüsselungsschlüssel und Push-Schlüsseln).');
console.log(geminiKey ? '✓ Gemini-Schlüssel eingetragen – die KI-Auswertung ist eingeschaltet.' : '• Ohne KI-Schlüssel: PDFs mit Text werden einfach erkannt, Fotos nur gespeichert.');
console.log('');
console.log('WICHTIG: Den Wert FILE_ENCRYPTION_KEY in .env sicher aufbewahren. Ohne ihn sind gespeicherte Briefe nicht lesbar.');
console.log('');
console.log('Nächste Schritte:');
if (!geminiKey) console.log('  • Optional: In .env bei GEMINI_API_KEY= Ihren kostenlosen Schlüssel eintragen (siehe README).');
console.log('  • „npm start“ ausführen (unter Windows: BriefPilot-starten.cmd doppelklicken).');
console.log('  • Im Browser http://localhost:3000 öffnen.');
