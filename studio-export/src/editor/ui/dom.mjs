// Tiny DOM helpers: build elements with textContent only (never innerHTML, so user text cannot become markup), format times,
// and one accessible dialog for confirm and prompt.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

/** 83500 -> "1:23.5" ; 4000 -> "0:04.0" */
export function fmt(ms) {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
};

/** A modal question. `input` adds a text field (resolves to its text or null); without it resolves to true or false. */
export function ask({ title, text = '', input, confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const field = input === undefined ? null : h('input', { type: 'text', value: input, 'aria-label': title, maxlength: 120 });
    const ok = h('button', { type: 'submit', class: danger ? 'danger' : 'primary' }, confirmLabel);
    const dlg = h('dialog', { class: 'ask', 'aria-labelledby': 'ask-title' },
      h('form', { method: 'dialog' }, h('h2', { id: 'ask-title' }, title), text ? h('p', {}, text) : null, field, h('div', { class: 'row end' }, h('button', { type: 'button', 'data-cancel': '' }, 'Cancel'), ok)));
    let answer = field ? null : false;
    dlg.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
    dlg.querySelector('form').addEventListener('submit', () => { answer = field ? field.value : true; });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); });
    document.body.append(dlg);
    dlg.showModal();
    (field || ok).focus();
    if (field) field.select();
  });
}
