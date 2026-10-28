// Liest alle Einstellungen aus Umgebungsvariablen (Datei .env).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'ja', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const port = int(env.PORT, 3000);
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR || 'data');

  const config = {
    isProduction,
    port,
    host: env.HOST || '127.0.0.1',
    baseUrl,
    secureCookies: baseUrl.startsWith('https://'),
    trustProxy: bool(env.TRUST_PROXY),
    dataDir,
    dbPath: path.join(dataDir, 'briefpilot.sqlite'),
    filesDir: path.join(dataDir, 'files'),
    publicDir: path.join(ROOT_DIR, 'public'),
    fileEncryptionKey: env.FILE_ENCRYPTION_KEY || '',
    ai: {
      provider: (env.AI_PROVIDER || 'anthropic').toLowerCase(),
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      providerLabel: env.AI_PROVIDER_LABEL || 'Anthropic (Claude-API)',
      dailyLimit: int(env.AI_DAILY_LIMIT, 30),
      demoDailyLimit: int(env.DEMO_AI_DAILY_LIMIT, 5),
      timeoutMs: int(env.AI_TIMEOUT_SECONDS, 180) * 1000,
    },
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      security: (env.SMTP_SECURITY || 'starttls').toLowerCase(), // tls | starttls | none
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || '',
    },
    push: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || 'mailto:datenschutz@example.org',
    },
    demo: {
      enabled: bool(env.DEMO_ENABLED, true),
      ttlHours: int(env.DEMO_TTL_HOURS, 24),
    },
    limits: {
      maxFileBytes: int(env.MAX_FILE_MB, 15) * 1024 * 1024,
      maxFilesPerLetter: int(env.MAX_PAGES_PER_LETTER, 20),
      maxStorageBytesPerUser: int(env.MAX_STORAGE_MB_PER_USER, 500) * 1024 * 1024,
    },
    reminderIntervalMs: int(env.REMINDER_INTERVAL_SECONDS, 60) * 1000,
    passwordHashCost: int(env.PASSWORD_HASH_COST, 15), // scrypt N = 2^cost
    privacyContact: env.PRIVACY_CONTACT || '',
  };

  config.ai.enabled = config.ai.provider === 'anthropic' && config.ai.apiKey.length > 10;
  config.smtp.enabled = Boolean(config.smtp.host && config.smtp.from);
  config.push.enabled = Boolean(config.push.publicKey && config.push.privateKey);
  return config;
}

/** Prüft die Konfiguration und liefert verständliche Fehlermeldungen. */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const key = Buffer.from(config.fileEncryptionKey || '', 'base64');
  if (key.length !== 32) {
    errors.push('FILE_ENCRYPTION_KEY fehlt oder ist ungültig. Bitte einmal „npm run setup“ ausführen – das erzeugt eine .env-Datei mit neuen Schlüsseln.');
  }
  if (config.isProduction) {
    if (!config.baseUrl.startsWith('https://')) errors.push('Im Produktivbetrieb muss BASE_URL mit https:// beginnen.');
    if (!config.smtp.enabled) warnings.push('E-Mail-Versand ist nicht eingerichtet: Passwort-Zurücksetzen funktioniert nicht.');
    if (config.demo.enabled) warnings.push('Der Demomodus ist im Produktivbetrieb eingeschaltet (DEMO_ENABLED).');
  }
  if (!config.ai.enabled) warnings.push('Kein ANTHROPIC_API_KEY gesetzt: KI-Auswertung und Texterkennung für Fotos sind ausgeschaltet.');
  if (!config.push.enabled) warnings.push('Keine VAPID-Schlüssel gesetzt: Push-Benachrichtigungen sind ausgeschaltet.');
  return { errors, warnings };
}

/** Was funktioniert echt, was ist simuliert oder fehlt? (für Oberfläche und Start-Ausgabe) */
export function featureStatus(config) {
  return [
    {
      id: 'speicherung', label: 'Speicherung', state: 'echt',
      detail: 'Briefe werden verschlüsselt auf dem Server abgelegt, Angaben in einer SQLite-Datenbank gespeichert.',
    },
    config.ai.enabled
      ? { id: 'ki', label: 'KI-Auswertung und Texterkennung', state: 'echt', detail: `Echt: Modell ${config.ai.model} über ${config.ai.providerLabel}.` }
      : {
        id: 'ki', label: 'KI-Auswertung und Texterkennung', state: 'aus',
        detail: 'Nicht eingerichtet (kein API-Schlüssel). PDFs mit Textebene werden mit einfacher Regel-Erkennung ohne KI gelesen. Fotos werden gespeichert, aber nicht automatisch gelesen.',
      },
    config.smtp.enabled
      ? { id: 'email', label: 'E-Mail-Versand', state: 'echt', detail: 'Echt: Versand über den eingerichteten SMTP-Server.' }
      : {
        id: 'email', label: 'E-Mail-Versand', state: config.isProduction ? 'aus' : 'simuliert',
        detail: config.isProduction
          ? 'Nicht eingerichtet. Passwort-Links und E-Mail-Erinnerungen werden nicht verschickt.'
          : 'Simuliert: E-Mails werden nicht verschickt, sondern nur im Server-Fenster (Terminal) angezeigt.',
      },
    config.push.enabled
      ? { id: 'push', label: 'Push-Benachrichtigungen', state: 'echt', detail: 'Echt: Benachrichtigungen an Geräte, auf denen Sie sie erlaubt haben.' }
      : { id: 'push', label: 'Push-Benachrichtigungen', state: 'aus', detail: 'Nicht eingerichtet (keine VAPID-Schlüssel).' },
    {
      id: 'erinnerungen', label: 'Erinnerungen', state: 'echt',
      detail: 'Echt: Erinnerungen werden zum geplanten Zeitpunkt ausgelöst und in der App angezeigt. Zustellung per Push oder E-Mail nur, wenn eingerichtet.',
    },
    { id: 'pro', label: 'Pro-Funktionen', state: 'vorschau', detail: 'Nur Vorschau – noch nicht umgesetzt.' },
  ];
}
