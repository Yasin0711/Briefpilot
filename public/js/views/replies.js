// Antworten auf einen Brief (Vorlage oder KI → bearbeiten → PDF, E-Mail, Kopieren, Entwurf)
// und Rückfragen an die KI zum Brief. Grundsatz: Nichts wird ohne ausdrückliche Freigabe verschickt.
import { html, mount } from '../html.js';
import { api, download } from '../api.js';
import { icon, toast, openDialog, showError, clearErrors, busy, confirmDialog, naStar } from '../ui.js';
import { formatDate } from '../shared/dates.js';

const SENT_VIA = { email: 'per E-Mail aus BriefPilot', post: 'per Post', eigenes_programm: 'mit eigenem E-Mail-Programm', kopiert: 'Text kopiert' };
const SUGGESTIONS = [
  'Was muss ich jetzt tun?',
  'Muss ich etwas bezahlen – und bis wann?',
  'Kann ich widersprechen?',
  'Erkläre den Brief in einfachen Worten.',
  'Hilf mir bei einer Antwort.',
];

let templatesCache = null;
async function loadTemplates() {
  if (!templatesCache) templatesCache = (await api.get('/api/reply-templates')).templates;
  return templatesCache;
}

/** Vorlagen und Fragen passend zum Brief; bei Fehler die allgemeine Liste. */
async function loadSuggestions(letterId) {
  try {
    return await api.get(`/api/letters/${encodeURIComponent(letterId)}/reply-suggestions`);
  } catch {
    return { templates: await loadTemplates(), questions: null };
  }
}

function templateButton(t) {
  return html`<button class="template-btn${t.recommended ? ' is-recommended' : ''}" type="button" data-template="${t.id}">${icon(t.id === 'leer' ? 'file' : t.recommended ? 'star' : 'pen')}<span><span>${t.label}</span>${t.reason ? html`<small class="template-reason">${t.reason}</small>` : ''}</span></button>`;
}

/** Ob Rückfragen und KI-Entwürfe möglich sind – und wenn nicht, warum. */
export function aiState(state, letter) {
  const ai = state.status?.ai;
  if (!ai?.enabled) return { ready: false, reason: html`Mit KI formulieren und fragen${naStar()}`, na: true };
  if (state.me?.aiConsent !== 'ja') return { ready: false, reason: html`Dafür muss die KI-Auswertung erlaubt sein (<a href="#/einstellungen">Einstellungen → Datenschutz und KI</a>).`, consent: true };
  if (!letter.fullText || letter.fullText.trim().length < 20) return { ready: false, reason: 'Fragen und KI-Entwürfe sind möglich, sobald der Brief gelesen wurde.' };
  return { ready: true, provider: ai.provider };
}

function plainText(reply) {
  const body = String(reply.body || '').trim();
  const name = reply.sender?.name;
  return `Betreff: ${reply.subject}\n\n${name && !body.endsWith(name) ? `${body}\n${name}` : body}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Rückfall für ältere Browser oder ohne Berechtigung
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function mailtoLink(to, reply) {
  const body = plainText(reply).replace(/^Betreff:.*\n\n/, '');
  // Manche E-Mail-Programme kürzen sehr lange Links – dann den Text lieber kopieren
  return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(reply.subject || '')}&body=${encodeURIComponent(body.slice(0, 1800))}`;
}

// ---------- Darstellung ----------

export function repliesPanel(data, state) {
  const { letter, replies } = data;
  const ai = aiState(state, letter);
  return html`<section class="stack-l" aria-labelledby="reply-h">
    <div class="stack">
      <h2 id="reply-h">Antwort schreiben</h2>
      <p class="muted">Wählen Sie eine Vorlage${ai.ready ? ' oder lassen Sie die KI einen Entwurf formulieren' : ''}. Sie prüfen und bearbeiten den Text – verschickt wird erst, wenn Sie es ausdrücklich bestätigen.</p>
      <div class="template-grid" data-templates><p class="muted small">Vorlagen werden geladen …</p></div>
      ${ai.ready ? html`<form class="panel stack" data-ai-reply novalidate>
        <div class="field"><label for="ai-instr">${icon('spark')} Mit KI formulieren</label>
          <textarea class="input" id="ai-instr" name="instruction" rows="3" maxlength="1000" placeholder="Was soll in der Antwort stehen? Zum Beispiel: Ich bitte um Ratenzahlung von 50 € im Monat."></textarea>
          <p class="hint">Der Brief und Ihr Wunsch werden dafür an ${ai.provider} übermittelt.</p></div>
        <p><button class="btn" type="submit">${icon('spark')}Entwurf erstellen</button></p>
      </form>` : ai.na ? html`<p class="small na-row">${ai.reason}</p>` : html`<div class="note">${icon('info')}<p>${ai.reason}</p></div>`}
    </div>

    <div class="stack" aria-labelledby="drafts-h">
      <h2 id="drafts-h">Ihre Antworten</h2>
      ${replies.length ? replies.map((r) => replyCard(r)) : html`<p class="muted">Noch keine Antwort. Entwürfe werden hier gespeichert, bis Sie sie verschicken oder löschen.</p>`}
    </div>
  </section>`;
}

function replyCard(r) {
  const sent = r.status === 'gesendet';
  return html`<article class="reply-card ${sent ? 'is-sent' : ''}" data-reply="${r.id}">
    <div class="row">
      ${sent ? html`<span class="badge badge-done">${icon('check')}Versendet ${SENT_VIA[r.sentVia] || ''}${r.sentAt ? ` am ${formatDate(r.sentAt.slice(0, 10))}` : ''}</span>`
        : html`<span class="badge badge-open">${icon('edit')}Entwurf</span>`}
      <span class="badge">${r.origin === 'ki' ? 'KI-Entwurf' : 'Vorlage'}</span>
      ${r.sentTo ? html`<span class="small muted">an ${r.sentTo}</span>` : ''}
    </div>
    <h3>${r.subject}</h3>
    <p class="reply-preview">${String(r.body || '').slice(0, 260)}${String(r.body || '').length > 260 ? ' …' : ''}</p>
    ${!sent && r.placeholders ? html`<p class="task-notes">${icon('alert')}<span>Noch ${r.placeholders === 1 ? 'eine Stelle' : `${r.placeholders} Stellen`} in [eckigen Klammern] ausfüllen.</span></p>` : ''}
    <div class="row">
      ${!sent ? html`<button class="btn btn-small" type="button" data-reply-act="edit">${icon('edit')}Bearbeiten</button>` : ''}
      <button class="btn btn-small btn-secondary" type="button" data-reply-act="pdf">${icon('printer')}PDF</button>
      <button class="btn btn-small btn-secondary" type="button" data-reply-act="copy">${icon('copy')}Text kopieren</button>
      ${!sent ? html`<button class="btn btn-small btn-secondary" type="button" data-reply-act="email">${icon('send')}Per E-Mail …</button>
        <button class="btn btn-small btn-ghost" type="button" data-reply-act="mark">${icon('check')}Als versendet markieren</button>
        <button class="btn btn-small btn-ghost" type="button" data-reply-act="delete" aria-label="Entwurf löschen">${icon('trash')}</button>` : ''}
    </div>
  </article>`;
}

export function chatPanel(data, state) {
  const { letter, messages } = data;
  const ai = aiState(state, letter);
  return html`<section class="panel stack chat" aria-labelledby="chat-h">
    <div class="section-title"><h2 id="chat-h">${icon('chat')} Fragen zum Brief</h2>
      ${messages.length ? html`<button class="btn btn-ghost btn-small" type="button" data-clear-chat>Gespräch löschen</button>` : ''}</div>
    ${messages.length ? html`<ol class="chat-list" data-chat-list>${messages.map((m) => html`<li class="chat-msg is-${m.role}">
        <span class="visually-hidden">${m.role === 'frage' ? 'Ihre Frage:' : 'Antwort:'}</span>
        <div class="bubble">${m.content}</div>
        ${m.role === 'antwort' && m.replyBody ? html`<button class="btn btn-small btn-secondary" type="button" data-take-reply="${m.id}">${icon('reply')}Als Antwortentwurf übernehmen</button>` : ''}
      </li>`)}</ol>` : html`<ol class="chat-list" data-chat-list hidden></ol>`}
    ${ai.ready ? html`
      ${!messages.length ? html`<div class="chips" role="group" aria-label="Vorschläge" data-question-chips>${SUGGESTIONS.map((s) => html`<button class="chip" type="button" data-suggest="${s}">${s}</button>`)}</div>` : ''}
      <form class="chat-form" data-ask novalidate>
        <label class="visually-hidden" for="ask-q">Ihre Frage zum Brief</label>
        <textarea class="input" id="ask-q" name="question" rows="2" maxlength="1000" placeholder="Ihre Frage zum Brief …"></textarea>
        <button class="btn" type="submit">${icon('send')}Fragen</button>
      </form>
      <p class="small muted">Antworten kommen von der KI (${ai.provider}) und können Fehler enthalten. Keine Rechtsberatung – bei Fristen und Geld im Zweifel beim Absender oder einer Beratungsstelle nachfragen.</p>`
      : ai.na ? html`<p class="small na-row">${ai.reason}</p>` : html`<div class="note">${icon('info')}<p>${ai.reason}</p></div>`}
  </section>`;
}

// ---------- Bedienung ----------

/**
 * Bindet alle Ereignisse für Antworten und Fragen (Ereignis-Delegation auf root).
 * ctx: { letterId, getData: () => data, reload: () => Promise, state, showTab: (tab) => void }
 */
export function bindAssistant(root, ctx) {
  const { letterId, getData, reload, state } = ctx;

  async function fillTemplates() {
    const box = root.querySelector('[data-templates]');
    if (!box) return;
    try {
      const { templates, questions } = await loadSuggestions(letterId);
      if (!box.isConnected) return;
      const recommended = templates.filter((t) => t.recommended);
      const others = templates.filter((t) => !t.recommended);
      mount(box, recommended.length
        ? html`<p class="small template-head">${icon('star')} Passend zu diesem Brief</p>${recommended.map(templateButton)}<p class="small muted template-head">Weitere Vorlagen</p>${others.map(templateButton)}`
        : templates.map(templateButton));
      const chips = root.querySelector('[data-question-chips]');
      if (chips && questions?.length) mount(chips, questions.map((s) => html`<button class="chip" type="button" data-suggest="${s}">${s}</button>`));
    } catch (err) {
      mount(box, html`<p class="small muted">${err.message}</p>`);
    }
  }

  async function createReply(body, button) {
    await busy(button, async () => {
      try {
        const { reply } = await api.post(`/api/letters/${letterId}/replies`, body);
        toast(body.mode === 'ki' ? 'Entwurf erstellt. Bitte prüfen und anpassen.' : 'Entwurf angelegt.');
        await reload();
        ctx.showTab?.('antworten');
        openEditor(reply);
      } catch (err) {
        toast(err.message, { error: true });
      }
    });
  }

  function openEditor(reply) {
    const r = reply;
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Antwort bearbeiten</h2>
      <div class="field"><label for="r-subject">Betreff</label><input class="input" id="r-subject" name="subject" value="${r.subject || ''}" maxlength="300"></div>
      <div class="field"><label for="r-body">Text</label>
        <textarea class="input reply-text" id="r-body" name="body" rows="14" maxlength="12000">${r.body || ''}</textarea>
        <p class="hint">Stellen in [eckigen Klammern] bitte durch Ihre Angaben ersetzen. Die Grußformel steht am Ende; Ihr Name wird darunter gesetzt.</p></div>
      <details class="stack">
        <summary>Empfänger, Absender, Ort und Datum</summary>
        <div class="field-pair">
          <div class="field"><label for="r-rn">Empfänger</label><input class="input" id="r-rn" name="recipientName" value="${r.recipient?.name || ''}" maxlength="160"></div>
          <div class="field"><label for="r-re">E-Mail des Empfängers</label><input class="input" type="email" id="r-re" name="recipientEmail" value="${r.recipient?.email || ''}" maxlength="254"></div>
        </div>
        <div class="field"><label for="r-ra">Anschrift des Empfängers</label><textarea class="input" id="r-ra" name="recipientAddress" rows="3" maxlength="400">${r.recipient?.address || ''}</textarea></div>
        <div class="field-pair">
          <div class="field"><label for="r-sn">Ihr Name</label><input class="input" id="r-sn" name="senderName" value="${r.sender?.name || ''}" maxlength="160"></div>
          <div class="field"><label for="r-sp">Telefon <span class="muted">(freiwillig)</span></label><input class="input" id="r-sp" name="senderPhone" value="${r.sender?.phone || ''}" maxlength="60"></div>
        </div>
        <div class="field"><label for="r-sa">Ihre Anschrift</label><textarea class="input" id="r-sa" name="senderAddress" rows="3" maxlength="400">${r.sender?.address || ''}</textarea></div>
        <div class="field-pair">
          <div class="field"><label for="r-pl">Ort</label><input class="input" id="r-pl" name="place" value="${r.place || ''}" maxlength="80"></div>
          <div class="field"><label for="r-dt">Datum</label><input class="input" type="date" id="r-dt" name="replyDate" value="${r.replyDate || ''}"></div>
        </div>
      </details>
      <div class="row"><button class="btn" type="submit">${icon('check')}Entwurf speichern</button>
        <button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      dialog.classList.add('is-wide');
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearErrors(form);
        const v = Object.fromEntries(new FormData(form).entries());
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.patch(`/api/replies/${r.id}`, {
              subject: v.subject, body: v.body, place: v.place, replyDate: v.replyDate || null,
              recipient: { name: v.recipientName, address: v.recipientAddress, email: v.recipientEmail },
              sender: { name: v.senderName, address: v.senderAddress, phone: v.senderPhone, email: r.sender?.email || '' },
            });
            close();
            toast('Entwurf gespeichert.');
            await reload();
            ctx.showTab?.('antworten');
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  function markSent(reply, preset = 'post') {
    openDialog(html`<form class="dialog-body stack" novalidate>
      <h2>Als versendet markieren</h2>
      <p class="muted">So sehen Sie später, dass und wie Sie geantwortet haben. Der Entwurf kann danach nicht mehr geändert werden.</p>
      <fieldset class="field"><legend class="field-label">Wie haben Sie die Antwort verschickt?</legend>
        ${[['post', 'Per Post (ausgedruckt)'], ['eigenes_programm', 'Mit meinem E-Mail-Programm'], ['kopiert', 'Text kopiert und anders verschickt']].map(([v, l]) => html`<label class="check"><input type="radio" name="via" value="${v}" ${v === preset ? 'checked' : ''}><span>${l}</span></label>`)}
      </fieldset>
      <div class="row"><button class="btn" type="submit">${icon('check')}Speichern</button><button class="btn btn-secondary" type="button" data-close>Abbrechen</button></div>
    </form>`, (dialog, close) => {
      const form = dialog.querySelector('form');
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.post(`/api/replies/${reply.id}/mark-sent`, { via: new FormData(form).get('via') });
            close();
            toast('Als versendet gespeichert.');
            await reload();
            ctx.showTab?.('antworten');
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  function emailDialog(reply) {
    const { letter } = getData();
    const smtp = state.status?.mail?.enabled && !state.me?.isDemo;
    const to = reply.recipient?.email || letter.senderEmail || '';
    const blocked = reply.placeholders > 0;
    openDialog(html`<div class="dialog-body stack">
      <h2>Antwort per E-Mail</h2>
      ${blocked ? html`<div class="note note-warn">${icon('alert')}<p>Der Text enthält noch ${reply.placeholders === 1 ? 'eine Stelle' : `${reply.placeholders} Stellen`} in [eckigen Klammern]. Bitte zuerst ersetzen.</p></div>` : ''}
      ${smtp ? html`<form class="stack" data-send novalidate>
          <div class="field"><label for="m-to">An</label><input class="input" type="email" id="m-to" name="to" value="${to}" required maxlength="254" autocomplete="email">
            ${!to ? html`<p class="hint">Im Brief wurde keine E-Mail-Adresse gefunden. Bitte die Adresse des Absenders eintragen.</p>` : ''}</div>
          <label class="check"><input type="checkbox" name="attachPdf" checked><span>Antwort zusätzlich als PDF anhängen</span></label>
          <label class="check check-strong"><input type="checkbox" name="confirm" required><span>Ich habe die Antwort geprüft und möchte sie <strong>jetzt</strong> an diese Adresse senden.</span></label>
          <p class="small muted">Gesendet wird über den Mailserver dieser BriefPilot-Installation, mit Ihrem Namen als Absender und Ihrer E-Mail-Adresse für Antworten.</p>
          <div class="row"><button class="btn" type="submit" ${blocked ? 'disabled' : ''}>${icon('send')}Jetzt senden</button></div>
        </form>
        <div class="divider">oder</div>` : html`<p class="small na-row">Direkt aus BriefPilot senden${naStar(state.me?.isDemo ? 'Im Demomodus nicht verfügbar' : 'Zurzeit nicht verfügbar')}</p>`}
      <div class="stack">
        <a class="btn btn-secondary" href="${mailtoLink(to, reply)}" data-mailto>${icon('external')}Im E-Mail-Programm öffnen</a>
        <p class="small muted">Sehr lange Texte werden dabei gekürzt – nutzen Sie dann „Text kopieren“. Das PDF hängen Sie im E-Mail-Programm selbst an.</p>
        <p data-after-mailto hidden><button class="btn btn-small" type="button" data-mark-mail>${icon('check')}Ich habe sie gesendet – als versendet markieren</button></p>
      </div>
      <div class="dialog-actions-inline"><button class="btn btn-ghost" type="button" data-close>Schließen</button></div>
    </div>`, (dialog, close) => {
      dialog.querySelector('[data-close]').addEventListener('click', () => close());
      dialog.querySelector('[data-mailto]').addEventListener('click', () => {
        dialog.querySelector('[data-after-mailto]').hidden = false;
      });
      dialog.querySelector('[data-mark-mail]').addEventListener('click', () => {
        close();
        markSent(reply, 'eigenes_programm');
      });
      const form = dialog.querySelector('[data-send]');
      form?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        clearErrors(form);
        const fd = new FormData(form);
        if (!fd.get('confirm')) {
          showError(form, Object.assign(new Error('Bitte bestätigen Sie, dass die E-Mail jetzt gesendet werden soll.'), { field: 'confirm' }));
          return;
        }
        await busy(form.querySelector('[type=submit]'), async () => {
          try {
            await api.post(`/api/replies/${reply.id}/send`, { to: fd.get('to'), confirm: true, attachPdf: Boolean(fd.get('attachPdf')) });
            close();
            toast('E-Mail gesendet.');
            await reload();
            ctx.showTab?.('antworten');
          } catch (err) {
            showError(form, err);
          }
        });
      });
    });
  }

  async function ask(question, form) {
    const list = root.querySelector('[data-chat-list]');
    if (list) {
      list.hidden = false;
      const pending = document.createElement('li');
      pending.className = 'chat-msg is-frage';
      pending.innerHTML = '<div class="bubble"></div>';
      pending.querySelector('.bubble').textContent = question;
      const thinking = document.createElement('li');
      thinking.className = 'chat-msg is-antwort is-pending';
      thinking.innerHTML = '<div class="bubble"><span class="spinner spinner-s" aria-hidden="true"></span> Die KI liest den Brief …</div>';
      list.append(pending, thinking);
      thinking.scrollIntoView({ block: 'nearest' });
    }
    const button = form?.querySelector('[type=submit]');
    await busy(button, async () => {
      try {
        const res = await api.post(`/api/letters/${letterId}/ask`, { question });
        getData().messages = res.messages;
        const y = window.scrollY;
        await reload();
        window.scrollTo(0, y);
        const last = root.querySelector('[data-chat-list] .chat-msg:last-child');
        last?.scrollIntoView({ block: 'nearest' });
        root.querySelector('#ask-q')?.focus({ preventScroll: true });
      } catch (err) {
        root.querySelectorAll('[data-chat-list] .is-pending').forEach((el) => el.remove());
        toast(err.message, { error: true });
        const input = root.querySelector('#ask-q');
        if (input && !input.value) input.value = question;
      }
    });
  }

  root.addEventListener('submit', async (e) => {
    const askForm = e.target.closest('[data-ask]');
    if (askForm) {
      e.preventDefault();
      const input = askForm.querySelector('[name=question]');
      const question = input.value.trim();
      if (question.length < 3) {
        toast('Bitte stellen Sie eine Frage.', { error: true });
        return;
      }
      input.value = '';
      await ask(question, askForm);
      return;
    }
    const aiForm = e.target.closest('[data-ai-reply]');
    if (aiForm) {
      e.preventDefault();
      const instruction = aiForm.querySelector('[name=instruction]').value.trim();
      await createReply({ mode: 'ki', instruction }, aiForm.querySelector('[type=submit]'));
    }
  });

  root.addEventListener('keydown', (e) => {
    // Strg/Cmd + Enter sendet die Frage
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('#ask-q')) {
      e.preventDefault();
      e.target.closest('form').requestSubmit();
    }
  });

  root.addEventListener('click', async (e) => {
    const suggest = e.target.closest('[data-suggest]');
    if (suggest) {
      await ask(suggest.dataset.suggest, root.querySelector('[data-ask]'));
      return;
    }
    if (e.target.closest('[data-clear-chat]')) {
      if (await confirmDialog({ title: 'Gespräch löschen?', body: 'Alle Fragen und Antworten zu diesem Brief werden gelöscht. Der Brief bleibt erhalten.', confirmLabel: 'Löschen', danger: true })) {
        await api.del(`/api/letters/${letterId}/messages`);
        await reload();
      }
      return;
    }
    const take = e.target.closest('[data-take-reply]');
    if (take) {
      const m = getData().messages.find((x) => x.id === take.dataset.takeReply);
      if (m) await createReply({ mode: 'text', subject: m.replySubject || '', body: m.replyBody }, take);
      return;
    }
    const tpl = e.target.closest('[data-template]');
    if (tpl) {
      await createReply({ mode: 'vorlage', template: tpl.dataset.template }, tpl);
      return;
    }
    const act = e.target.closest('[data-reply-act]');
    if (!act) return;
    const reply = getData().replies.find((r) => r.id === act.closest('[data-reply]').dataset.reply);
    if (!reply) return;
    try {
      switch (act.dataset.replyAct) {
        case 'edit':
          openEditor(reply);
          break;
        case 'pdf':
          await download(`/api/replies/${reply.id}/pdf`, 'antwort.pdf');
          toast('PDF heruntergeladen – zum Ausdrucken oder Anhängen.');
          break;
        case 'copy':
          toast((await copyText(plainText(reply))) ? 'Text in die Zwischenablage kopiert.' : 'Kopieren hat nicht geklappt. Bitte den Text im Entwurf markieren und kopieren.', { error: false });
          break;
        case 'email':
          emailDialog(reply);
          break;
        case 'mark':
          markSent(reply);
          break;
        case 'delete':
          if (await confirmDialog({ title: 'Entwurf löschen?', body: `„${reply.subject}“ wird gelöscht.`, confirmLabel: 'Löschen', danger: true })) {
            await api.del(`/api/replies/${reply.id}`);
            toast('Entwurf gelöscht.');
            await reload();
            ctx.showTab?.('antworten');
          }
          break;
        default:
      }
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  return { fillTemplates, openEditor };
}

