// Web-Push (RFC 8030/8291/8292) ohne externe Bibliothek.
// Die Nachricht wird Ende-zu-Ende verschlüsselt: Der Push-Dienst des Browsers
// (Google, Apple, Mozilla) kann den Inhalt nicht lesen.
import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(String(str), 'base64url');

/** Erzeugt ein neues VAPID-Schlüsselpaar (für „npm run setup“). */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const priv = ecdh.getPrivateKey();
  const padded = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(padded) };
}

function vapidPrivateKey(publicKeyB64, privateKeyB64) {
  const pub = fromB64url(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY ist ungültig.');
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC', crv: 'P-256',
      x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: String(privateKeyB64),
    },
  });
}

export function createVapidJwt({ audience, subject, publicKey, privateKey, expiresInSeconds = 12 * 3600 }) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + expiresInSeconds, sub: subject }));
  const input = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: vapidPrivateKey(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(signature)}`;
}

/** Verschlüsselt die Nachricht nach RFC 8291 (aes128gcm). */
export function encryptPayload(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Ungültiges Push-Abonnement');
  const server = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) server.generateKeys();
  const asPublic = server.getPublicKey();
  const sharedSecret = server.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

export function createPushService(config) {
  const enabled = config.push.enabled;
  return {
    enabled,
    publicKey: enabled ? config.push.publicKey : null,
    /**
     * Sendet eine Benachrichtigung. Ergebnis: { ok, gone } – gone=true heißt,
     * das Abonnement existiert nicht mehr und kann gelöscht werden.
     */
    async send(subscription, message) {
      if (!enabled) return { ok: false, reason: 'nicht_eingerichtet' };
      const endpoint = new URL(subscription.endpoint);
      const jwt = createVapidJwt({
        audience: endpoint.origin,
        subject: config.push.subject,
        publicKey: config.push.publicKey,
        privateKey: config.push.privateKey,
      });
      const body = encryptPayload(JSON.stringify(message), subscription);
      try {
        const res = await fetch(subscription.endpoint, {
          method: 'POST',
          headers: {
            TTL: '86400',
            Urgency: 'normal',
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            Authorization: `vapid t=${jwt}, k=${config.push.publicKey}`,
          },
          body,
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 404 || res.status === 410) return { ok: false, gone: true, reason: 'abgelaufen' };
        if (!res.ok) return { ok: false, reason: `status_${res.status}` };
        return { ok: true };
      } catch {
        return { ok: false, reason: 'netzwerk' };
      }
    },
  };
}

// Nur bekannte Push-Dienste der Browserhersteller sind erlaubt. So kann niemand
// den Server dazu bringen, Anfragen an beliebige Adressen zu schicken.
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com',
  'push.apple.com', 'notify.windows.com', 'push.microsoft.com',
];

/** Prüft, ob eine Push-Adresse zu einem bekannten Push-Dienst gehört. */
export function isAllowedPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port) return false;
  const host = url.hostname.toLowerCase();
  const known = PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return known && endpoint.length < 1000;
}
