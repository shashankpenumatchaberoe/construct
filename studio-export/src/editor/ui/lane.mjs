// The drawing of an automation line: the pure maths (how a value maps to a height on the lane, how it reads, how a freehand stroke is simplified into a few
// points, what a point snaps to) and, below it, the small DOM widget the timeline puts in an automation lane. The widget never edits: it reports what
// the user did (add a point here, move that one, replace the line with this) and the app turns that into ops.
import { CURVES, PARAMS, laneValueAt } from './effects.mjs';
import { formatDb, formatPan, gainToPos, posToGain } from './knob.mjs';
import { fmt, h } from './dom.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Height on the lane, 0 (top) to 1 (bottom), of a value. Volume uses the knob's dB scale, so unity sits about three quarters up; the rest are linear. */
export function valueToY(param, v) {
  if (param === 'gain') return 1 - gainToPos(v);
  if (param === 'pan') return 1 - (clamp(v, -1, 1) + 1) / 2;
  const { min, max } = PARAMS[param];
  return 1 - (clamp(v, min, max) - min) / (max - min);
}

/** The value at a height on the lane (the inverse of valueToY, clamped to the param's range). */
export function yToValue(param, y) {
  const up = 1 - clamp(y, 0, 1);
  if (param === 'gain') return Math.round(posToGain(up) * 10000) / 10000;
  const { min, max } = PARAMS[param];
  return Math.round((min + up * (max - min)) * 10000) / 10000;
}

/** How a value reads: volume in dB, pan as C / L 40% / R 25%, mute as On or Muted (or how far), opacity as a percentage. */
export function formatValue(param, v) {
  if (param === 'gain') return formatDb(v);
  if (param === 'pan') return formatPan(v);
  if (param === 'mute') return v >= 0.995 ? 'Muted' : v <= 0.005 ? 'On' : `${Math.round(v * 100)}% muted`;
  if (param === 'opacity') return `${Math.round(v * 100)}%`;
  return String(Math.round(v * 100) / 100);
}

/** The labels down the side of a lane: `[y, text]` pairs. */
export function axisTicks(param) {
  if (param === 'gain') return [[valueToY('gain', 4), '+12 dB'], [valueToY('gain', 1), '0 dB'], [valueToY('gain', 0.1), '-20 dB']];
  if (param === 'pan') return [[0, 'R'], [0.5, 'C'], [1, 'L']];
  if (param === 'mute') return [[0.05, 'muted'], [0.95, 'on']];
  return [[0, '100%'], [1, '0%']];
}

/**
 * Ramer-Douglas-Peucker: a stroke of many `{x, y}` samples (both 0-1) reduced to the few that keep it within `tolerance` of the original. The ends always stay.
 */
export function simplify(samples, tolerance) {
  if (samples.length < 3) return samples.slice();
  const keep = new Array(samples.length).fill(false);
  keep[0] = keep[samples.length - 1] = true;
  const stack = [[0, samples.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = samples[a];
    const B = samples[b];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy);
    let far = -1;
    let worst = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = len === 0 ? Math.hypot(samples[i].x - A.x, samples[i].y - A.y) : Math.abs(dy * samples[i].x - dx * samples[i].y + B.x * A.y - B.y * A.x) / len;
      if (d > worst) { worst = d; far = i; }
    }
    if (far >= 0) { keep[far] = true; stack.push([a, far], [far, b]); }
  }
  return samples.filter((_, i) => keep[i]);
}

/**
 * A freehand stroke (`[{ t, v }]` in ms and value, in the order it was drawn) as the points of a line: sorted, one point per millisecond at most, the shape
 * simplified (in the lane's own height scale, so it looks the same for every param) and every point given `curve`. Points outside `0..duration` are dropped.
 */
export function strokeToPoints(param, stroke, duration, tolerance, curve = 'linear') {
  const inside = stroke.filter((s) => s.t >= 0 && s.t <= duration).sort((a, b) => a.t - b.t);
  const uniq = [];
  for (const s of inside) if (!uniq.length || s.t > uniq[uniq.length - 1].t) uniq.push(s);
  if (!uniq.length) return [];
  const norm = uniq.map((s) => ({ x: duration > 0 ? s.t / duration : 0, y: valueToY(param, s.v), s }));
  return simplify(norm, tolerance).map(({ s }) => ({ t: Math.round(s.t), v: s.v, curve: param === 'mute' ? 'hold' : curve }));
}

/** Where a time (ms) snaps to: the nearest of `targets` within `within` ms, else the time itself. */
export function snapTime(t, targets, within) {
  let best = t;
  let bestD = within + 1;
  for (const x of targets) { const d = Math.abs(x - t); if (d <= within && d < bestD) { best = x; bestD = d; } }
  return best;
}

/** The value snaps to unity (or its own resting value) when it is close in height. */
export function snapValue(param, v, restingValues, withinY) {
  const y = valueToY(param, v);
  for (const r of restingValues) if (Math.abs(valueToY(param, r) - y) <= withinY) return r;
  return v;
}

export const CURVE_LABEL = { linear: 'Straight', hold: 'Hold (step)', 'ease-in': 'Ease in', 'ease-out': 'Ease out', 'ease-in-out': 'Ease in and out' };


// ---------------------------------------------------------------- the widget in an automation lane

const LANE_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS(LANE_NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; };
const RESTING = { gain: [1], pan: [0], mute: [0, 1], opacity: [0, 1] };

/**
 * The line of one automation layer, drawn over the clip it is linked to (the lane's item is exactly as wide as the clip, so everything is a percentage of it
 * and follows the zoom by itself). `o.line` is the automation layer, `o.clip` its clip `{ id, start, duration }`; `o.getTool()` is "pencil", "freehand" or
 * "line" and `o.getTolerance()` the freehand tolerance; `o.getPlayhead()` and `o.siblings` (times of other lines' points on this clip) are what a point snaps
 * to. `o.on` receives what the user does: `add(t, v, curve)`, `move(index, t, v)`, `remove(index)`, `curve(index, curve)`, `replace(points)` and
 * `menu({ kind: 'point' | 'lane', index?, t, v, x, y })`. Returns `{ el, focusPoint(index) }`.
 */
export function createLineWidget(o) {
  const { line, clip, fps = 30, disabled = false, on } = o;
  const param = line.link.param;
  const dur = Math.max(1, clip.duration);
  const pts = line.points;
  const spec = PARAMS[param];
  const X = (t) => (t / dur) * 100;
  const Y = (v) => valueToY(param, v) * 100;
  const curveOf = () => (param === 'mute' ? 'hold' : 'linear');

  const root = h('div', { class: `line${disabled ? ' locked' : ''}`, 'data-layer': line.id, 'data-param': param });
  const plot = h('div', { class: 'plot' }); // the drawing area, inset from the lane's edges so a point at the very start or end of the clip is a whole circle inside it
  const svg = svgEl('svg', { class: 'line-svg', viewBox: '0 0 1000 100', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
  let prevY = -1;
  for (const [y, text] of axisTicks(param)) {
    svg.append(svgEl('line', { class: `guide${text === '0 dB' || text === 'C' ? ' unity' : ''}`, x1: 0, x2: 1000, y1: y * 100, y2: y * 100, 'vector-effect': 'non-scaling-stroke' }));
    // a label hangs under a guide in the top half and sits on one in the bottom half, so it never straddles the line or runs off the lane; one too close to the label above it goes to the other side
    const crowded = prevY >= 0 && y - prevY < 0.3;
    root.append(h('span', { class: `tick ${y <= 0.5 ? 'below' : 'above'}${crowded ? ' far' : ''}`, style: `top:calc(6px + (100% - 12px) * ${y})` }, text));
    prevY = y;
  }
  // the curve: a horizontal run to the first point, each segment sampled along its curve (a hold is a step), then a run to the end of the clip
  const segments = [];
  const x0 = X(pts[0].t) * 10;
  segments.push(`M0 ${Y(pts[0].v)} L${x0} ${Y(pts[0].v)}`);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.curve === 'hold') { segments.push(`L${X(b.t) * 10} ${Y(a.v)} L${X(b.t) * 10} ${Y(b.v)}`); continue; }
    const n = a.curve === 'linear' ? 1 : 24;
    for (let k = 1; k <= n; k++) { const t = a.t + ((b.t - a.t) * k) / n; segments.push(`L${X(t) * 10} ${Y(laneValueAt(pts, t))}`); }
  }
  const last = pts[pts.length - 1];
  segments.push(`L${Math.max(1000, X(last.t) * 10)} ${Y(last.v)}`);
  const d = segments.join(' ');
  svg.append(svgEl('path', { class: 'area', d: `${d} L1000 100 L0 100 Z` }), svgEl('path', { class: 'path', d, 'vector-effect': 'non-scaling-stroke' }));
  const draft = svgEl('path', { class: 'draft', d: '', 'vector-effect': 'non-scaling-stroke' });
  svg.append(draft);
  plot.append(svg);
  root.append(plot);
  const readout = h('div', { class: 'readout', hidden: true, role: 'status' });
  plot.append(readout);

  const label = (p, i) => `Point ${i + 1}: ${formatValue(param, p.v)} at ${fmt(p.t)}, ${CURVE_LABEL[p.curve].toLowerCase()} to the next`;
  const dots = pts.map((p, i) => {
    const dot = h('div', { class: 'pt', tabindex: disabled ? '-1' : '0', role: 'slider', 'data-index': i, 'aria-label': label(p, i), 'aria-valuetext': `${formatValue(param, p.v)} at ${fmt(p.t)}`, 'aria-valuemin': spec.min, 'aria-valuemax': spec.max, 'aria-valuenow': p.v, style: `left:${X(p.t)}%;top:${Y(p.v)}%` });
    plot.append(dot);
    return dot;
  });

  const rect = () => plot.getBoundingClientRect();
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const tAt = (x) => Math.round(clamp01((x - rect().left) / rect().width) * dur);
  const yAt = (y) => clamp01((y - rect().top) / rect().height);
  const say = (v, t, at) => { readout.hidden = false; readout.textContent = `${formatValue(param, v)}  ${fmt(t)}`; readout.style.left = `${Math.min(88, Math.max(2, X(t)))}%`; readout.style.top = `${Math.min(70, Math.max(0, at))}%`; };
  const targets = () => { const rel = o.getPlayhead() - clip.start; return [0, dur, ...(rel > 0 && rel < dur ? [rel] : []), ...(o.siblings || [])]; };
  const withinMs = () => (8 / Math.max(1, rect().width)) * dur;
  const valueAtY = (y, snap) => {
    if (param === 'mute') return y < 0.5 ? 1 : 0;
    const v = yToValue(param, y);
    return snap ? snapValue(param, v, RESTING[param], 0.035) : v;
  };

  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || disabled) return;
    e.stopPropagation();
    const pt = e.target.closest && e.target.closest('.pt');
    root.setPointerCapture(e.pointerId);
    const snap = !e.altKey;
    if (pt) {
      const i = Number(pt.dataset.index);
      drag = { kind: 'point', i, dot: pt, t: pts[i].t, v: pts[i].v, moved: false, snap };
      pt.focus();
      e.preventDefault();
      return;
    }
    const tool = o.getTool();
    const t = tAt(e.clientX);
    const v = valueAtY(yAt(e.clientY), snap);
    if (tool === 'pencil') { drag = { kind: 'add' }; on.add(snap ? snapTime(t, targets(), withinMs()) : t, v, curveOf()); return; }
    drag = { kind: tool, samples: [{ t, v }], a: { t, v }, snap };
    draft.setAttribute('d', `M${X(t) * 10} ${Y(v)}`);
    e.preventDefault();
  });
  root.addEventListener('pointermove', (e) => {
    const t = tAt(e.clientX);
    const y = yAt(e.clientY);
    if (!drag) { if (!disabled) say(valueAtY(y, false), t, y * 100); return; }
    if (drag.kind === 'point') {
      drag.moved = true;
      const prev = pts[drag.i - 1];
      const next = pts[drag.i + 1];
      let nt = drag.snap ? snapTime(t, targets(), withinMs()) : t;
      nt = Math.min(next ? next.t - 1 : dur, Math.max(prev ? prev.t + 1 : 0, nt));
      drag.t = nt;
      drag.v = valueAtY(y, drag.snap);
      drag.dot.style.left = `${X(nt)}%`;
      drag.dot.style.top = `${Y(drag.v)}%`;
      say(drag.v, nt, Y(drag.v));
    } else if (drag.kind === 'freehand') {
      const v = valueAtY(y, false);
      drag.samples.push({ t, v });
      draft.setAttribute('d', drag.samples.map((s, k) => `${k ? 'L' : 'M'}${X(s.t) * 10} ${Y(s.v)}`).join(' '));
      say(v, t, y * 100);
    } else if (drag.kind === 'line') {
      const b = { t, v: valueAtY(y, drag.snap) };
      drag.b = b;
      draft.setAttribute('d', `M${X(drag.a.t) * 10} ${Y(drag.a.v)} L${X(b.t) * 10} ${Y(b.v)}`);
      say(b.v, b.t, y * 100);
    }
  });
  const finish = (e) => {
    const dr = drag;
    drag = null;
    draft.setAttribute('d', '');
    if (!dr) return;
    if (dr.kind === 'point' && dr.moved && (dr.t !== pts[dr.i].t || dr.v !== pts[dr.i].v)) on.move(dr.i, dr.t, dr.v);
    else if (dr.kind === 'freehand' && dr.samples.length > 1) {
      const drawn = strokeToPoints(param, dr.samples, dur, o.getTolerance(), curveOf());
      if (drawn.length) { const t0 = drawn[0].t; const t1 = drawn[drawn.length - 1].t; on.replace([...pts.filter((p) => p.t < t0 || p.t > t1), ...drawn].sort((p, q) => p.t - q.t)); }
    } else if (dr.kind === 'line' && dr.b && Math.abs(dr.b.t - dr.a.t) >= 20) {
      const [a, b] = dr.a.t < dr.b.t ? [dr.a, dr.b] : [dr.b, dr.a];
      const t0 = dr.snap ? snapTime(a.t, targets(), withinMs()) : a.t;
      const t1 = dr.snap ? snapTime(b.t, targets(), withinMs()) : b.t;
      if (t1 > t0) on.replace([...pts.filter((p) => p.t < t0 || p.t > t1), { t: t0, v: a.v, curve: curveOf() }, { t: t1, v: b.v, curve: curveOf() }].sort((p, q) => p.t - q.t));
    } else if (dr.kind === 'line') on.add(dr.a.t, dr.a.v, curveOf());
    if (e && e.pointerId !== undefined) { try { root.releasePointerCapture(e.pointerId); } catch { /* already released */ } }
  };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);
  root.addEventListener('pointerleave', () => { if (!drag) readout.hidden = true; });
  for (const type of ['mousedown', 'touchstart', 'click']) root.addEventListener(type, (e) => e.stopPropagation(), type === 'touchstart' ? { passive: true } : undefined);
  root.addEventListener('dblclick', (e) => { e.stopPropagation(); const pt = e.target.closest && e.target.closest('.pt'); if (pt && !disabled) on.remove(Number(pt.dataset.index)); });
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    const pt = e.target.closest && e.target.closest('.pt');
    on.menu({ kind: pt ? 'point' : 'lane', index: pt ? Number(pt.dataset.index) : undefined, t: tAt(e.clientX), v: valueAtY(yAt(e.clientY), false), x: e.clientX, y: e.clientY });
  });

  // keys on a point: arrows nudge (a frame in time, 1% of the lane in value; Shift for ten times as much), Delete removes, C cycles the curve
  let pending = null;
  let timer = 0;
  root.addEventListener('keydown', (e) => {
    const pt = e.target.closest && e.target.closest('.pt');
    if (!pt || disabled) return;
    const i = Number(pt.dataset.index);
    const p = pts[i];
    const big = e.shiftKey ? 10 : 1;
    const frame = Math.max(1, Math.round(1000 / fps)) * big;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); on.remove(i); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); e.stopPropagation(); on.curve(i, CURVES[(CURVES.indexOf(p.curve) + 1) % CURVES.length]); return; }
    const cur = pending && pending.i === i ? pending : { i, t: p.t, y: valueToY(param, p.v) };
    if (e.key === 'ArrowLeft') cur.t = cur.t - frame;
    else if (e.key === 'ArrowRight') cur.t = cur.t + frame;
    else if (e.key === 'ArrowUp') cur.y = cur.y - 0.01 * big;
    else if (e.key === 'ArrowDown') cur.y = cur.y + 0.01 * big;
    else return;
    e.preventDefault();
    e.stopPropagation(); // the arrows are the point's while it has focus, not the timeline's
    const prev = pts[i - 1];
    const next = pts[i + 1];
    cur.t = Math.min(next ? next.t - 1 : dur, Math.max(prev ? prev.t + 1 : 0, cur.t));
    cur.y = clamp01(cur.y);
    pending = cur;
    const v = param === 'mute' ? (cur.y < 0.5 ? 1 : 0) : yToValue(param, cur.y);
    pt.style.left = `${X(cur.t)}%`;
    pt.style.top = `${Y(v)}%`;
    say(v, cur.t, Y(v));
    clearTimeout(timer);
    timer = setTimeout(() => { const m = pending; pending = null; if (m && (m.t !== p.t || v !== p.v)) on.move(m.i, m.t, v); }, 350);
  });

  return { el: root, focusPoint(i) { const dot = dots[Math.min(dots.length - 1, Math.max(0, i))]; if (dot) dot.focus({ preventScroll: true }); } };
}
