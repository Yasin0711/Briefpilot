// Dateien, die über das Plus-Menü gewählt wurden und von „Scannen“ übernommen werden.
let pending = null;
export function setPendingFiles(files, options = {}) {
  pending = { files, ...options };
}
export function takePendingFiles() {
  const p = pending;
  pending = null;
  return p;
}
