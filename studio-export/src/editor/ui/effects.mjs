// The per-clip effects of the model, as pure functions with no DOM and no Node: the zoom curve, the speed limits and the checks.
// One file so the preview (the page bundles it) and the render (imports it as a module) cannot disagree about what a value means.
//
//   speed    0.25 - 16, default 1. The clip's `duration` is its length ON THE TIMELINE; it plays `duration * speed` ms of its source.
//   opacity  0 - 1, default 1, video clips only.
//   zoom     { scale, x, y, at, ramp, hold } on a video clip: from `at` ms into the clip the picture eases from 1x to `scale` over
//            `ramp` ms, centred on the point (x, y) of the frame (0-1 each); after `hold` ms it eases back out over `ramp` ms, and
//            with hold = null it stays zoomed to the end of the clip. Times are on the timeline (not the source); `at` may be negative
//            (a clip cut in the middle of a zoom starts part-way through it).

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 16;
export const ZOOM_SCALE_MIN = 1.05;
export const ZOOM_SCALE_MAX = 8;
export const ZOOM_KEYS = Object.freeze(['scale', 'x', 'y', 'at', 'ramp', 'hold']);
export const ZOOM_DEFAULT = Object.freeze({ scale: 2, x: 0.5, y: 0.5, at: 0, ramp: 600, hold: null });
const LIMIT_MS = 24 * 60 * 60 * 1000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isSafeInteger(v);

/** `null` when `speed` is a valid clip speed, else a message. */
export const speedProblem = (speed) => (isNum(speed) && speed >= SPEED_MIN && speed <= SPEED_MAX ? null : `speed is a number from ${SPEED_MIN} to ${SPEED_MAX}.`);
/** `null` when `opacity` is valid, else a message. */
export const opacityProblem = (opacity) => (isNum(opacity) && opacity >= 0 && opacity <= 1 ? null : 'opacity is a number from 0 (invisible) to 1.');

/** `null` when `z` is a valid zoom object, else a message naming the first problem. */
export function zoomProblem(z) {
  if (z === null || typeof z !== 'object' || Array.isArray(z)) return 'zoom is an object { scale, x, y, at, ramp, hold }.';
  for (const k of Object.keys(z)) if (!ZOOM_KEYS.includes(k)) return `unknown zoom field "${k}".`;
  if (!isNum(z.scale) || z.scale < ZOOM_SCALE_MIN || z.scale > ZOOM_SCALE_MAX) return `zoom.scale is a number from ${ZOOM_SCALE_MIN} to ${ZOOM_SCALE_MAX}.`;
  for (const k of ['x', 'y']) if (!isNum(z[k]) || z[k] < 0 || z[k] > 1) return `zoom.${k} is a number from 0 to 1 (the point of the frame the zoom is centred on).`;
  if (!isInt(z.at) || z.at < -LIMIT_MS || z.at > LIMIT_MS) return 'zoom.at is whole milliseconds into the clip (negative when the clip starts part-way through the zoom).';
  if (!isInt(z.ramp) || z.ramp < 0 || z.ramp > 600000) return 'zoom.ramp is whole milliseconds, 0 to 600000.';
  if (z.hold !== null && (!isInt(z.hold) || z.hold < 0 || z.hold > LIMIT_MS)) return 'zoom.hold is whole milliseconds, or null to stay zoomed until the end of the clip.';
  return null;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (r) => r * r * (3 - 2 * r);
const ramp01 = (t, from, len) => (len > 0 ? clamp01((t - from) / len) : (t >= from ? 1 : 0));

/** How far the picture is zoomed (1 = not at all) `tMs` after the clip's start. */
export function zoomAt(zoom, tMs) {
  if (!zoom) return 1;
  let k = smooth(ramp01(tMs, zoom.at, zoom.ramp));
  if (zoom.hold !== null && zoom.hold !== undefined) k -= smooth(ramp01(tMs, zoom.at + zoom.ramp + zoom.hold, zoom.ramp));
  return 1 + (zoom.scale - 1) * k;
}

/**
 * Which part of the frame a zoom shows: the window of the (1x) picture, as fractions of its width and height, whose left and top edges are `left` and `top`
 * (it is 1/z of the frame wide and high). It is centred on the zoom's point (x, y) unless that would leave the frame, then it stops at the edge.
 */
export function zoomWindow(zoom, z) {
  const edge = (c) => Math.min(1 - 1 / z, Math.max(0, c - 0.5 / z));
  return { left: edge(zoom.x), top: edge(zoom.y) };
}

/** How a speed reads: `2x`, `0.5x`, `1.25x`. */
export const formatSpeed = (speed) => `${Math.round(speed * 100) / 100}x`;

/**
 * The picture and the narration are lined up by time, so a video clip and a voice clip that overlap but run at different speeds drift apart. This is what
 * to tell the user after a speed change: `null` when the clip has no such partner, else a sentence naming who it now disagrees with.
 */
export function speedSyncWarning(project, clipId) {
  let mine = null;
  for (const l of project.layers) { const c = l.clips.find((x) => x.id === clipId); if (c) mine = { clip: c, kind: l.kind }; }
  if (!mine || (mine.kind !== 'video' && mine.kind !== 'voice')) return null;
  const partnerKind = mine.kind === 'video' ? 'voice' : 'video';
  const c = mine.clip;
  const speed = c.speed ?? 1;
  const apart = project.layers.filter((l) => l.kind === partnerKind && !l.muted).flatMap((l) => l.clips)
    .filter((o) => o.start < c.start + c.duration && c.start < o.start + o.duration && (o.speed ?? 1) !== speed);
  if (!apart.length) return null;
  const names = [...new Set(apart.map((o) => o.src))].slice(0, 2).join(', ');
  return `This ${mine.kind} clip runs at ${formatSpeed(speed)}, but the ${partnerKind} it overlaps (${names}) is at ${formatSpeed(apart[0].speed ?? 1)}, so they will drift out of sync. Give both the same speed to keep them together.`;
}

/** The atempo factors that make `speed` (0.25-16) in steps every ffmpeg version accepts (each between 0.5 and 2). */
export function atempoFactors(speed) {
  const out = [];
  let s = speed;
  while (s > 2) { out.push(2); s /= 2; }
  while (s < 0.5) { out.push(0.5); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-9 || !out.length) out.push(s);
  return out;
}

// ---------------------------------------------------------------- automation lines
//
// An automation LAYER (project.mjs) is a lane of its own, linked to one clip and one param of it: `{ kind: 'automation', link: { clipId, param },
// points: [{ t, v, curve }] }`. `t` is ms from the start of the linked clip, so the line moves with its clip; `curve` is how the value gets from that
// point to the NEXT one. Before the first point the value is the first point's, after the last it is the last point's. While a line exists for a
// param it decides that param; without one the clip's own constant (or the default) does.

export const CURVES = Object.freeze(['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out']);
/** Range and default of every param a line can drive, and the kinds of clip that have it. */
export const PARAMS = Object.freeze({
  gain: { min: 0, max: 4, def: 1, clips: ['voice', 'music'], label: 'Volume' },
  pan: { min: -1, max: 1, def: 0, clips: ['voice', 'music'], label: 'Pan' },
  mute: { min: 0, max: 1, def: 0, clips: ['voice', 'music'], label: 'Mute' },
  opacity: { min: 0, max: 1, def: 1, clips: ['video'], label: 'Opacity' },
  speed: { min: SPEED_MIN, max: SPEED_MAX, def: 1, clips: ['video', 'voice', 'music'], label: 'Speed' },
  zoom: { min: 1, max: 4, def: 1, clips: ['video'], label: 'Zoom' },
  panX: { min: -1, max: 1, def: 0, clips: ['video'], label: 'Pan X' },
  panY: { min: -1, max: 1, def: 0, clips: ['video'], label: 'Pan Y' },
});
/** The params the editor can draw and render today; the rest are in the model for what comes next (speed, zoom, video pan). */
export const AUTOMATABLE = Object.freeze(['gain', 'pan', 'mute', 'opacity']);
export const MAX_POINTS = 500;
/** The gain a voice or a music clip has when it names none: narration as recorded, music as a quiet bed under it. */
export const defaultGain = (kind) => (kind === 'music' ? 0.0398 : 1);
/** The value of `param` on `clip` (of layer kind `kind`) when no line drives it: the clip's own constant, else the default. */
export function baseValue(clip, kind, param) {
  if (param === 'gain') return clip.gain !== undefined ? clip.gain : defaultGain(kind);
  if (param === 'pan') return clip.pan !== undefined ? clip.pan : 0;
  if (param === 'opacity') return clip.opacity !== undefined ? clip.opacity : 1;
  if (param === 'speed') return clip.speed !== undefined ? clip.speed : 1;
  return PARAMS[param].def;
}

/**
 * `null` when `points` is a valid list of points for `param` on a clip of `kind`, else a message naming the first problem.
 */
export function lineProblem(param, points, kind) {
  const spec = typeof param === 'string' && Object.hasOwn(PARAMS, param) ? PARAMS[param] : null;
  if (!spec) return `param must be one of ${Object.keys(PARAMS).join(', ')}.`;
  if (!spec.clips.includes(kind)) return `a ${kind} clip has no ${param} line.`;
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_POINTS) return `points is a list of 1 to ${MAX_POINTS} points.`;
  let prev = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const at = `points[${i}]`;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return `${at} is an object { t, v, curve }.`;
    for (const k of Object.keys(p)) if (k !== 't' && k !== 'v' && k !== 'curve') return `unknown field "${k}" in ${at}.`;
    if (!isInt(p.t) || p.t < 0 || p.t > LIMIT_MS) return `${at}.t is whole milliseconds, 0 or more.`;
    if (p.t <= prev) return `${at}.t must be later than the point before it (times strictly increase).`;
    prev = p.t;
    if (!isNum(p.v) || p.v < spec.min || p.v > spec.max) return `${at}.v is a number from ${spec.min} to ${spec.max} for ${param}.`;
    if (!CURVES.includes(p.curve)) return `${at}.curve is one of ${CURVES.join(', ')}.`;
  }
  return null;
}

/** How far along a segment (0-1) the value is once the curve is applied; `hold` never leaves the first value (handled by the caller). */
export function curveShape(curve, u) {
  if (curve === 'ease-in') return u * u;
  if (curve === 'ease-out') return 1 - (1 - u) * (1 - u);
  if (curve === 'ease-in-out') return u * u * (3 - 2 * u);
  return u; // linear
}

/** The value of a lane's points at `t` ms. `undefined` when there are no points. */
export function laneValueAt(points, t) {
  if (!points || !points.length) return undefined;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid].t <= t) lo = mid; else hi = mid; }
  const a = points[lo];
  const b = points[hi];
  if (a.curve === 'hold' || b.t === a.t) return a.curve === 'hold' ? a.v : b.v;
  return a.v + (b.v - a.v) * curveShape(a.curve, (t - a.t) / (b.t - a.t));
}

/** The integral of the lane's value from `t0` to `t1` ms (value x ms). For a speed lane this is how much source time has played. */
export function laneIntegral(points, t0, t1) {
  if (t1 <= t0 || !points || !points.length) return 0;
  const cuts = [t0, ...points.map((p) => p.t).filter((t) => t > t0 && t < t1), t1];
  let sum = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const n = 32; // Simpson: exact for a line, very close for the eased curves
    const h = (b - a) / n;
    let s = laneValueAt(points, a) + laneValueAt(points, b - 1e-9 * (b - a));
    for (let k = 1; k < n; k++) s += (k % 2 ? 4 : 2) * laneValueAt(points, a + k * h);
    sum += (s * h) / 3;
  }
  return sum;
}

/** The mean value of the lane over `t0`..`t1` ms. */
export const laneMean = (points, t0, t1) => (t1 > t0 ? laneIntegral(points, t0, t1) / (t1 - t0) : laneValueAt(points, t0));

/** How long (whole ms) a speed lane needs to play `sourceMs` of source: the duration D with the integral of speed over 0..D equal to it. */
export function durationForSource(points, sourceMs) {
  if (sourceMs <= 0) return 0;
  let lo = 0;
  let hi = Math.ceil(sourceMs / SPEED_MIN) + 1;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (laneIntegral(points, 0, mid) < sourceMs) lo = mid; else hi = mid; }
  return Math.round((lo + hi) / 2);
}

// ---------------------------------------------------------------- what a clip sounds and looks like at one moment
//
// The preview and the render both mean the same thing by a clip's level, pan and opacity. These are the preview's numbers; the render builds the same
// formulas as ffmpeg expressions (render.mjs), and the tests hold the two together.

/** Left and right gain of a balance pan (-1 hard left, 0 centre, 1 hard right): the side you pan away from fades out, the other stays at full level. */
export const balance = (pan) => [Math.min(1, 1 - pan), Math.min(1, 1 + pan)];

/**
 * The gain and the left and right pan gains of a voice or music clip `rel` ms after its start. `lineOf(param)` gives the points of the line drawn for that
 * param (or nothing). A line replaces the clip's own constant; the mute line takes the volume down by its own value (1 is silent); the layer's volume and pan
 * multiply on top. `override` is a knob being turned right now: `{ clip: [id, gain], layer: [id, gain], clipPan: [id, pan], layerPan: [id, pan] }`.
 */
export function audioMixAt(clip, kind, layer, lineOf, rel, override = null) {
  const pick = (param, fallback) => { const pts = lineOf(param); return pts ? laneValueAt(pts, rel) : fallback; };
  const own = override && override.clip && override.clip[0] === clip.id ? override.clip[1] : baseValue(clip, kind, 'gain');
  const lay = override && override.layer && override.layer[0] === layer.id ? override.layer[1] : (layer.gain ?? 1);
  const ownPan = override && override.clipPan && override.clipPan[0] === clip.id ? override.clipPan[1] : (clip.pan ?? 0);
  const layerPan = override && override.layerPan && override.layerPan[0] === layer.id ? override.layerPan[1] : (layer.pan ?? 0);
  const [cl, cr] = balance(pick('pan', ownPan));
  const [ll, lr] = balance(layerPan);
  return { gain: pick('gain', own) * (1 - clamp01(pick('mute', 0))) * lay, left: cl * ll, right: cr * lr };
}

/** A video clip's opacity `rel` ms after its start: its line, else its own constant, else 1. */
export function opacityAt(clip, lineOf, rel) {
  const pts = lineOf('opacity');
  return clamp01(pts ? laneValueAt(pts, rel) : (clip.opacity ?? 1));
}
