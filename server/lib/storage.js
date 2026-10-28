// Verschlüsselte Dateiablage (AES-256-GCM).
// Jede Datei wird einzeln verschlüsselt. Der Speicherpfad ist als „zusätzliche
// authentifizierte Daten“ an die Verschlüsselung gebunden: Eine Datei kann also
// nicht unbemerkt unter einem anderen Pfad (z. B. bei einem anderen Nutzer) abgelegt werden.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectOffice } from './office.js';

const MAGIC = Buffer.from('BPF1');
const KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.bin$/;

export function createStorage({ dir, keyBase64 }) {
  const key = Buffer.from(keyBase64 || '', 'base64');
  if (key.length !== 32) throw new Error('FILE_ENCRYPTION_KEY muss 32 Byte (Base64) lang sein.');

  function resolve(storageKey) {
    if (!KEY_PATTERN.test(storageKey)) throw new Error('Ungültiger Speicherschlüssel');
    return path.join(dir, storageKey);
  }

  return {
    async put(userId, data) {
      const storageKey = `${userId}/${crypto.randomUUID()}.bin`;
      const target = resolve(storageKey);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(storageKey));
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();
      const tmp = `${target}.tmp`;
      await fs.writeFile(tmp, Buffer.concat([MAGIC, iv, tag, encrypted]), { mode: 0o600 });
      await fs.rename(tmp, target);
      return storageKey;
    },

    async get(storageKey) {
      const buf = await fs.readFile(resolve(storageKey));
      if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Unbekanntes Dateiformat');
      const iv = buf.subarray(4, 16);
      const tag = buf.subarray(16, 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(storageKey));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
    },

    async remove(storageKey) {
      await fs.rm(resolve(storageKey), { force: true });
    },

    async removeUser(userId) {
      if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('Ungültige Nutzerkennung');
      await fs.rm(path.join(dir, userId), { recursive: true, force: true });
    },
  };
}

/** Erkennt den Dateityp anhand der ersten Bytes – nicht anhand der Dateiendung. */
export function detectFileType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  const brand = buf.subarray(4, 12).toString('latin1');
  if (/^ftyp(heic|heix|hevc|mif1|msf1|avif)/.test(brand)) return { kind: 'unsupported', mime: 'image/heic', reason: 'heic' };
  const office = detectOffice(buf);
  if (office) return office.macros ? { kind: 'unsupported', mime: office.mime, reason: 'macros', label: office.label } : office;
  return null;
}
