// Vollbild-Ansichten (Kamera, Seiten-Editor) und die Zurück-Taste:
// Auf dem Smartphone schließt „Zurück“ nur das Vollbild – die Seite mit den bereits
// aufgenommenen Seiten bleibt erhalten. Dafür wird beim Öffnen ein Verlaufseintrag angelegt.

let backPending = null; // Promise, solange ein history.back() unterwegs ist

/**
 * @param {() => void} onBack wird aufgerufen, wenn die Zurück-Taste gedrückt wurde
 * @returns {() => void} release – beim Schließen per Knopf aufrufen (entfernt den Verlaufseintrag)
 */
export function trapBackButton(onBack) {
  let active = true;
  let pushed = false;
  const onPop = () => {
    if (!active || !pushed) return;
    active = false;
    window.removeEventListener('popstate', onPop);
    onBack();
  };
  const push = () => {
    if (!active) return;
    try {
      history.pushState({ bpOverlay: true }, '');
      pushed = true;
      window.addEventListener('popstate', onPop);
    } catch {
      /* ohne Verlaufseintrag: Zurück verlässt dann die Seite */
    }
  };
  if (backPending) backPending.then(push);
  else push();

  return function release() {
    if (!active) return;
    active = false;
    window.removeEventListener('popstate', onPop);
    if (!pushed || !history.state?.bpOverlay) return;
    backPending = new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('popstate', done);
        backPending = null;
        resolve();
      };
      window.addEventListener('popstate', done);
      setTimeout(done, 500);
    });
    history.back();
  };
}

/** Verknüpft ein AbortSignal mit einer Schließen-Funktion (z. B. wenn die Seite gewechselt wird). */
export function closeOnAbort(signal, close) {
  if (!signal) return;
  if (signal.aborted) queueMicrotask(close);
  else signal.addEventListener('abort', close, { once: true });
}
