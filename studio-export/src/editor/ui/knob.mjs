// A rotary volume knob. The sweep is 270 degrees on a dB scale: the bottom of the sweep is silence, then -40 dB up to +12 dB (a gain of 4),
// with unity (0 dB) about three quarters of the way round. Drag up or down (Shift for fine), scroll, use the arrow keys, double-click to reset,
// right-click for a menu with "type a value". It is a role=slider element, so it works with a keyboard and a screen reader (the spoken value is
// in dB). The knob only reports values: `onInput` while it moves (a live preview), `onCommit` once it settles (send the edit).
import { ask, h } from './dom.mjs';
import { openMenu } from './menu.mjs';

const DB_MIN = -40;
const DB_MAX = 20 * Math.log10(4);
const FLOOR = 0.02; // the first 2% of the sweep is silence

/** Gain (0-4) to the knob's position (0-1), and back. */
export const gainToPos = (g) => (g <= 0 ? 0 : Math.min(1, Math.max(FLOOR, FLOOR + ((20 * Math.log10(g) - DB_MIN) / (DB_MAX - DB_MIN)) * (1 - FLOOR))));
export const posToGain = (p) => (p <= FLOOR ? 0 : Math.min(4, 10 ** ((DB_MIN + ((p - FLOOR) / (1 - FLOOR)) * (DB_MAX - DB_MIN)) / 20)));
/** Pan as it is said: C, L 40%, R 25%. */
export const formatPan = (p) => (Math.abs(p) < 0.005 ? 'C' : `${p < 0 ? 'L' : 'R'} ${Math.round(Math.abs(p) * 100)}%`);
/** "-6.0 dB", or "-inf dB" for silence. */
export const formatDb = (g) => (g <= 0 ? '-inf dB' : `${(20 * Math.log10(g)).toFixed(1)} dB`);

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; };
const polar = (deg, r) => [24 + r * Math.cos((deg * Math.PI) / 180), 24 + r * Math.sin((deg * Math.PI) / 180)];
const arc = (from, to, r) => { const [x1, y1] = polar(from, r); const [x2, y2] = polar(to, r); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`; };
const START = 135;
const SWEEP = 270;

/**
 * `label` names it, `value` and `def` are gains, `small` drops the text (a tooltip carries the value), `disabled` freezes it.
 * Returns `{ el, set(gain) }`; `set` redraws without calling back.
 */
export function createKnob({ label, title, value = 1, def = 1, small = false, disabled = false, mode = 'gain', menuExtra = [], onInput = () => {}, onCommit = () => {} }) {
  // `mode: 'pan'` is the same knob for a pan from -1 (left) to 1 (right): linear, with a detent at the centre and an arc that fills from there
  const pan = mode === 'pan';
  const toPos = pan ? (g) => (Math.min(1, Math.max(-1, g)) + 1) / 2 : gainToPos;
  const fromPos = pan ? (p) => { const v = Math.round((p * 2 - 1) * 1000) / 1000; return Math.abs(v) < 0.03 ? 0 : v; } : posToGain;
  const fmt = pan ? formatPan : formatDb;
  let gain = value;
  let pos = toPos(value);
  let timer = 0;
  const track = svg('path', { class: 'knob-track', d: arc(START, START + SWEEP, 19) });
  const fill = svg('path', { class: 'knob-fill' });
  const cap = svg('circle', { class: 'knob-cap', cx: 24, cy: 24, r: 13 });
  const tick = svg('line', { class: 'knob-tick', x1: 24, y1: 15, x2: 24, y2: 21 });
  const dial = svg('svg', { viewBox: '0 0 48 48', 'aria-hidden': 'true', focusable: 'false' });
  dial.append(track, fill, cap, tick);
  const valueEl = h('span', { class: 'knob-value' });
  const el = h('div', { class: `knob${small ? ' small' : ''}`, role: 'slider', tabindex: disabled ? '-1' : '0', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-disabled': String(disabled), title: title || label }, dial, small ? null : valueEl, small ? null : h('span', { class: 'knob-label' }, label));

  function draw() {
    const a = START + SWEEP * pos;
    const mid = START + SWEEP * 0.5;
    fill.setAttribute('d', pan ? (Math.abs(pos - 0.5) > 0.005 ? (pos > 0.5 ? arc(mid, a, 19) : arc(a, mid, 19)) : '') : (pos > 0.005 ? arc(START, a, 19) : ''));
    tick.setAttribute('transform', `rotate(${a - 270} 24 24)`);
    const text = fmt(gain);
    valueEl.textContent = text;
    el.setAttribute('aria-valuenow', String(Math.round(pos * 100)));
    el.setAttribute('aria-valuetext', text);
    el.dataset.gain = String(Math.round(gain * 10000) / 10000);
    if (small) el.title = `${title || label}: ${text}`;
  }
  const move = (p) => { pos = Math.min(1, Math.max(0, p)); gain = fromPos(pos); draw(); onInput(gain); };
  const commit = () => { clearTimeout(timer); gain = Math.round(gain * 10000) / 10000; onCommit(gain); }; // a saved volume is a tidy number, not a long float
  const later = () => { clearTimeout(timer); timer = setTimeout(commit, 350); }; // keys and the wheel come in bursts: send the edit once it settles
  const setGain = (g, send = true) => { gain = g; pos = toPos(g); draw(); onInput(gain); if (send) commit(); };

  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, pos, moved: false };
    el.focus();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.moved = true;
    move(drag.pos + (drag.y - e.clientY) / (e.shiftKey ? 1000 : 180));
  });
  const end = () => { if (drag && drag.moved) commit(); drag = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('mousedown', (e) => e.stopPropagation()); // inside a timeline label: never start a timeline gesture
  el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  el.addEventListener('wheel', (e) => { if (disabled) return; e.preventDefault(); e.stopPropagation(); move(pos + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02)); later(); }, { passive: false });
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); if (!disabled) setGain(def); });
  el.addEventListener('keydown', (e) => {
    if (disabled) return;
    const step = { ArrowUp: 0.01, ArrowRight: 0.01, ArrowDown: -0.01, ArrowLeft: -0.01, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step !== undefined) move(pos + step * (e.shiftKey ? 0.2 : 1));
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(1);
    else if (e.key === 'Enter') { setGain(def); e.preventDefault(); e.stopPropagation(); return; }
    else return;
    e.preventDefault();
    e.stopPropagation(); // the arrow keys are the knob's while it has focus, not the timeline's
    later();
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    const typed = async () => {
      const t = await ask({ title: pan ? `${label} in percent` : `${label} in dB`, text: pan ? 'From -100 (hard left) to 100 (hard right); 0 is the centre.' : 'From -40 to 12. Type -inf for silence.', input: pan ? String(Math.round(gain * 100)) : (gain <= 0 ? '-inf' : (20 * Math.log10(gain)).toFixed(1)), confirmLabel: 'Set' });
      if (t === null) return;
      const s = t.trim().toLowerCase();
      if (pan) { const n = Number(s.replace(/%$/, '')); if (Number.isFinite(n)) setGain(Math.min(1, Math.max(-1, n / 100))); return; }
      const db = /^-?inf/.test(s) ? -Infinity : Number(s.replace(/db$/, ''));
      if (Number.isFinite(db) || db === -Infinity) setGain(db === -Infinity ? 0 : Math.min(4, 10 ** (Math.max(-40, Math.min(DB_MAX, db)) / 20)));
    };
    const items = [
      { label: `Reset to ${fmt(def)}`, hint: 'Double-click', run: () => setGain(def) },
      { label: pan ? 'Type a percent...' : 'Type a value in dB...', run: typed },
      ...(pan ? [{ label: 'Hard left', run: () => setGain(-1) }, { label: 'Hard right', run: () => setGain(1) }] : [{ label: 'Silence', run: () => setGain(0) }]),
    ];
    if (menuExtra.length) items.push({ separator: true }, ...menuExtra);
    openMenu({ x: e.clientX, y: e.clientY, label: `${label} options`, items });
  });
  draw();
  return { el, set(g) { gain = g; pos = toPos(g); draw(); } };
}
