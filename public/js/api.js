// Verbindung zum Server. Jede ändernde Anfrage trägt den Sicherheits-Header X-BriefPilot.

export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.field = data.field;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function request(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { 'X-BriefPilot': '1', ...headers }, credentials: 'same-origin' };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('Keine Verbindung zum Server. Bitte prüfen Sie Ihre Internetverbindung.', 0);
  }
  if (raw && res.ok) return res;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized();
    throw new ApiError(data.error || `Fehler ${res.status}`, res.status, data);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  raw: (method, path, body) => request(method, path, body, { raw: true }),

  /**
   * Lädt eine Datei hoch und meldet den Fortschritt (0–1).
   * headers: z. B. { 'X-File-Role': 'original' } für eine zusätzlich aufbewahrte Originalaufnahme
   */
  upload(blob, onProgress, headers = {}) {
    // Große Dateien in Stücken: stabiler im Mobilfunknetz, einzelne Teile werden bei Fehlern wiederholt
    if (blob.size > CHUNKED_FROM) return uploadChunked(blob, onProgress, headers);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
      xhr.setRequestHeader('X-BriefPilot', '1');
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      for (const [key, value] of Object.entries(headers)) if (value) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || '{}');
        } catch {
          data = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          if (xhr.status === 401) onUnauthorized();
          reject(new ApiError(data.error || `Hochladen fehlgeschlagen (${xhr.status})`, xhr.status, data));
        }
      };
      xhr.onerror = () => reject(new ApiError('Keine Verbindung zum Server. Bitte erneut versuchen.', 0));
      xhr.send(blob);
    });
  },
};

const CHUNKED_FROM = 8 * 1024 * 1024;

async function uploadChunked(blob, onProgress, headers = {}) {
  const role = headers['X-File-Role'] === 'original' ? 'original' : 'seite';
  const { id, chunkSize, chunks } = await request('POST', '/api/uploads', { size: blob.size, type: blob.type || 'application/octet-stream', role });
  for (let i = 0; i < chunks; i++) {
    const part = blob.slice(i * chunkSize, Math.min(blob.size, (i + 1) * chunkSize));
    for (let attempt = 1; ; attempt++) {
      try {
        await request('PUT', `/api/uploads/${id}/${i}`, part, { headers: { 'Content-Type': 'application/octet-stream' } });
        break;
      } catch (err) {
        if (attempt >= 4 || (err.status && err.status !== 0 && err.status < 500 && err.status !== 429)) throw err;
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    onProgress?.((i + 1) / chunks * 0.97);
  }
  const result = await request('POST', `/api/uploads/${id}/complete`, {});
  onProgress?.(1);
  return result;
}

/** Lädt eine Datei herunter (z. B. Export, Kalenderdatei), ohne öffentliche Links. */
export async function download(path, fallbackName) {
  const res = await request('GET', path, undefined, { raw: true });
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : fallbackName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
