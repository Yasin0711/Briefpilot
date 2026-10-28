// Einrichtung: erzeugt die Datei .env mit neuen, zufälligen Schlüsseln.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

let content = fs.readFileSync(examplePath, 'utf8');
const vapid = generateVapidKeys();
const set = (key, value) => {
  content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
};
set('FILE_ENCRYPTION_KEY', crypto.randomBytes(32).toString('base64'));
set('VAPID_PUBLIC_KEY', vapid.publicKey);
set('VAPID_PRIVATE_KEY', vapid.privateKey);
fs.writeFileSync(envPath, content, { mode: 0o600 });

console.log('✓ Datei .env wurde angelegt (mit neuem Verschlüsselungsschlüssel und Push-Schlüsseln).');
console.log('');
console.log('Nächste Schritte:');
console.log('  1. Optional: In .env Ihren ANTHROPIC_API_KEY eintragen (für KI-Auswertung und Fotos).');
console.log('  2. „npm start“ ausführen.');
console.log('  3. Im Browser http://localhost:3000 öffnen.');
