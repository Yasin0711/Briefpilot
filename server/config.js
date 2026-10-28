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

/** Welcher KI-Anbieter? Ausdrücklich über AI_PROVIDER, sonst nach vorhandenem Schlüssel. */
export function resolveAiProvider(env) {
  const explicit = String(env.AI_PROVIDER || '').trim().toLowerCase();
  if (['aus', 'off', 'none', 'keine', 'nein'].includes(explicit)) return 'aus';
  if (['gemini', 'google'].includes(explicit)) return 'gemini';
  if (['anthropic', 'claude'].includes(explicit)) return 'anthropic';
  if (['openai', 'openai-kompatibel', 'ollama', 'lmstudio', 'groq', 'openrouter', 'mistral', 'lokal'].includes(explicit)) return 'openai';
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_COMPAT_BASE_URL) return 'openai';
  return 'gemini';
}

function aiConfig(env) {
  const provider = resolveAiProvider(env);
  const common = {
    provider,
    dailyLimit: int(env.AI_DAILY_LIMIT, 30),
    demoDailyLimit: int(env.DEMO_AI_DAILY_LIMIT, 5),
    timeoutMs: int(env.AI_TIMEOUT_SECONDS, 180) * 1000,
    retryDelayMs: int(env.AI_RETRY_DELAY_MS, 4000),
    fallbackModel: null,
    local: false,
    freeTier: false,
  };
  if (provider === 'gemini') {
    const apiKey = env.GEMINI_API_KEY || '';
    return {
      ...common,
      apiKey,
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
      fallbackModel: env.GEMINI_FALLBACK_MODEL === undefined ? 'gemini-3.5-flash-lite' : env.GEMINI_FALLBACK_MODEL,
      baseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
      providerLabel: env.AI_PROVIDER_LABEL || 'Google Gemini',
      freeTier: env.GEMINI_PAID !== 'true',
      enabled: apiKey.length > 10,
    };
  }
  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY || '';
    return {
      ...common,
      apiKey,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      providerLabel: env.AI_PROVIDER_LABEL || 'Anthropic (Claude-API)',
      enabled: apiKey.length > 10,
    };
  }
  if (provider === 'openai') {
    const baseUrl = (env.OPENAI_COMPAT_BASE_URL || '').replace(/\/+$/, '');
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
    return {
      ...common,
      apiKey: env.OPENAI_COMPAT_API_KEY || '',
      model: env.OPENAI_COMPAT_MODEL || '',
      baseUrl,
      local,
      providerLabel: env.AI_PROVIDER_LABEL || (local ? 'Lokales KI-Modell auf diesem Computer' : 'OpenAI-kompatibler KI-Dienst'),
      enabled: Boolean(baseUrl && env.OPENAI_COMPAT_MODEL),
    };
  }
  return { ...common, apiKey: '', model: '', baseUrl: '', providerLabel: 'keine KI', enabled: false };
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
    ai: aiConfig(env),
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
      maxFileBytes: int(env.MAX_FILE_MB, 100) * 1024 * 1024,
      maxPdfPages: int(env.MAX_PDF_PAGES, 1000),
      uploadChunkBytes: int(env.UPLOAD_CHUNK_KB, 4096) * 1024,
      maxFilesPerLetter: int(env.MAX_PAGES_PER_LETTER, 20),
      maxStorageBytesPerUser: int(env.MAX_STORAGE_MB_PER_USER, 5000) * 1024 * 1024,
    },
    reminderIntervalMs: int(env.REMINDER_INTERVAL_SECONDS, 60) * 1000,
    passwordHashCost: int(env.PASSWORD_HASH_COST, 15), // scrypt N = 2^cost
    privacyContact: env.PRIVACY_CONTACT || '',
  };

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
  if (!config.ai.enabled) {
    if (config.ai.provider === 'openai') warnings.push('OpenAI-kompatible KI gewählt, aber OPENAI_COMPAT_BASE_URL oder OPENAI_COMPAT_MODEL fehlt: KI ist ausgeschaltet.');
    else if (config.ai.provider !== 'aus') warnings.push('Keine KI eingerichtet: Fotos werden nicht gelesen. Kostenlos testen: Schlüssel bei https://aistudio.google.com erstellen und in .env als GEMINI_API_KEY eintragen (siehe README).');
  } else if (config.ai.provider === 'gemini' && config.ai.freeTier) {
    warnings.push('KI über das kostenlose Gemini-Kontingent: begrenzte Zahl an Auswertungen pro Tag. Ohne Rechnungskonto bei Google entstehen keine Kosten.');
  }
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
      ? {
        id: 'ki', label: 'KI-Auswertung, Rückfragen und Antwortentwürfe', state: 'echt',
        detail: `Echt: Modell ${config.ai.model}${config.ai.fallbackModel ? ` (Ersatz: ${config.ai.fallbackModel})` : ''} über ${config.ai.providerLabel}.${config.ai.freeTier ? ' Kostenloses Kontingent – begrenzte Anzahl pro Tag.' : ''}${config.ai.local ? ' Läuft auf diesem Computer, Briefe verlassen ihn nicht.' : ''}`,
      }
      : {
        id: 'ki', label: 'KI-Auswertung, Rückfragen und Antwortentwürfe', state: 'aus',
        detail: 'Nicht eingerichtet (kein API-Schlüssel). PDFs mit Textebene werden mit einfacher Regel-Erkennung ohne KI gelesen. Fotos werden gespeichert, aber nicht automatisch gelesen. Antwortbriefe gibt es als Vorlagen.',
      },
    {
      id: 'scanner', label: 'Scanner mit Kantenerkennung', state: 'echt',
      detail: 'Echt: Blattränder erkennen, Perspektive korrigieren, Bild verbessern – direkt auf dem Gerät. Live-Kamera braucht https oder localhost; sonst öffnet sich die Kamera-App des Handys.',
    },
    {
      id: 'akten', label: 'Objektakten und automatische Zuordnung', state: 'echt',
      detail: 'Echt: Briefe werden anhand eindeutiger Nummern (Kennzeichen, Vertrags-, Zählernummer …) Akten zugeordnet. Unklare Fälle landen zur Prüfung im Eingang.',
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
    config.smtp.enabled
      ? { id: 'antwort-mail', label: 'Antworten per E-Mail senden', state: 'echt', detail: 'Echt: über den eingerichteten Mailserver, nur nach ausdrücklicher Freigabe.' }
      : { id: 'antwort-mail', label: 'Antworten per E-Mail senden', state: 'aus', detail: 'Nicht eingerichtet (kein Mailserver). Antworten lassen sich im eigenen E-Mail-Programm öffnen, kopieren oder als PDF drucken.' },
    { id: 'pro', label: 'Pro-Funktionen', state: 'vorschau', detail: 'Nur Vorschau – Kalender-Abgleich, E-Mail-Import, Familienfreigaben und Abo sind noch nicht umgesetzt.' },
  ];
}
