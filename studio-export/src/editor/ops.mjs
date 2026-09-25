// Pure, immutable editing operations on a Studio project (see project.mjs for the model). Every op takes a project and returns
// `{ ok: true, project, ...extra }` with a NEW project (the input is never touched) or `{ ok: false, code, message }` with a code
// from ERR. Nothing here reads a file or a clock; ids are minted deterministically (`c<n>`, one above the highest in the project).
//
// Rules shared by all ops: a locked layer refuses every edit to its clips (`LOCKED`; setLayerFlag itself is how you unlock);
// clips never overlap inside a subtitle layer (`OVERLAP`) but may on video layers (the earlier clip is on top) and on voice and music layers, which are mixed; a clip
// keeps `MIN_CLIP_MS` at least; times are whole milliseconds.
import { AUTOMATABLE, CURVES, MAX_POINTS, PARAMS, ZOOM_DEFAULT, baseValue, laneMean, laneValueAt, lineProblem, opacityProblem, speedProblem, zoomProblem } from './ui/effects.mjs';
import { ERR, KINDS, MAX_MS, MAX_NOTES, MAX_TEXT, MEDIA_KINDS, MIN_CLIP_MS, isMediaName, overlaps } from './project.mjs';

const isInt = (v) => Number.isSafeInteger(v);
const fail = (code, message) => ({ ok: false, code, message });
const clone = (p) => JSON.parse(JSON.stringify(p));
const endOf = (c) => c.start + c.duration;

function locate(project, clipId) {
  for (const layer of project.layers) {
    const clip = layer.clips.find((c) => c.id === clipId);
    if (clip) return { layer, clip };
  }
  return null;
}

/** The next free clip id: `c` + (highest number used by any `c<n>` id in the project) + 1. */
export function nextClipId(project) {
  let max = 0;
  for (const l of project.layers) for (const c of l.clips) { const m = /^c(\d+)$/.exec(c.id); if (m) max = Math.max(max, Number(m[1])); }
  return `c${max + 1}`;
}

/** An automation layer draws a line for one clip; when that clip is gone (deleted, or its layer was) the line goes with it. */
function pruneLines(p) {
  const alive = new Set();
  for (const l of p.layers) for (const c of l.clips) alive.add(c.id);
  p.layers = p.layers.filter((l) => l.kind !== 'automation' || alive.has(l.link.clipId));
}

/** Give a list of points new times through `fn(t)`, keeping the times strictly increasing (two points that would meet are nudged 1 ms apart). */
function retime(points, fn) {
  let prev = -1;
  return points.map((pt) => { const t = Math.max(prev + 1, Math.max(0, Math.round(fn(pt.t)))); prev = t; return { ...pt, t }; });
}

/** The automation layers linked to a clip, in layer order. */
const linesOf = (p, clipId) => p.layers.filter((l) => l.kind === 'automation' && l.link.clipId === clipId);

/** Cutting a clip in two: the right half gets its own copy of every line, starting from the value the line has at the cut. */
function splitLines(p, leftId, rightId, cut) {
  for (const line of linesOf(p, leftId)) {
    let curve = 'linear';
    for (const pt of line.points) if (pt.t <= cut) curve = pt.curve;
    const points = [{ t: 0, v: laneValueAt(line.points, cut), curve }, ...line.points.filter((pt) => pt.t > cut).map((pt) => ({ ...pt, t: pt.t - cut }))];
    p.layers.splice(p.layers.findIndex((l) => l.id === line.id) + 1, 0, { ...clone(line), id: nextLayerId(p), link: { clipId: rightId, param: line.link.param }, points });
  }
}

/** Trimming the start of a clip by `delta` ms (negative: extending it earlier) keeps each line attached to the picture: it starts from the value it had at the new start. */
function reanchorLines(p, clipId, delta) {
  if (!delta) return;
  for (const line of linesOf(p, clipId)) {
    if (delta < 0) { line.points = line.points.map((pt) => ({ ...pt, t: pt.t - delta })); continue; }
    let curve = 'linear';
    for (const pt of line.points) if (pt.t <= delta) curve = pt.curve;
    line.points = [{ t: 0, v: laneValueAt(line.points, delta), curve }, ...line.points.filter((pt) => pt.t > delta).map((pt) => ({ ...pt, t: pt.t - delta }))];
  }
}

/** Copy the project, run `mutate(copy)` (returns an error result or nothing), keep clips sorted by start, and check overlaps in the touched layers. */
function edit(project, touchedLayerIds, mutate) {
  const next = clone(project);
  const err = mutate(next);
  if (err) return err;
  pruneLines(next);
  for (const id of touchedLayerIds(next)) {
    const layer = next.layers.find((l) => l.id === id);
    if (!layer) continue;
    layer.clips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const clash = overlaps(layer)[0];
    if (clash) return fail(ERR.OVERLAP, `That would overlap ${clash[0]} and ${clash[1]} on the ${layer.kind} layer "${layer.name}".`);
  }
  return { ok: true, project: next };
}

const withClip = (project, clipId) => {
  if (typeof clipId !== 'string') return { err: fail(ERR.BAD_ARG, 'clipId must be text.') };
  const found = locate(project, clipId);
  if (!found) return { err: fail(ERR.NO_CLIP, `No clip "${clipId}".`) };
  if (found.layer.locked) return { err: fail(ERR.LOCKED, `The layer "${found.layer.name}" is locked.`) };
  return found;
};

const timeArg = (v, name, min = 0) => (isInt(v) && v >= min && v <= MAX_MS ? null : fail(ERR.BAD_ARG, `${name} must be whole milliseconds from ${min} to ${MAX_MS}.`));

/** Split a subtitle's text: at `index` characters when given, else in half at the space nearest the middle. Returns [left, right] or null. */
export function splitText(text, index) {
  let at = index;
  if (at === undefined) {
    const mid = Math.floor(text.length / 2);
    let best = -1;
    for (let i = 1; i < text.length - 1; i++) if (/\s/.test(text[i]) && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    at = best < 0 ? mid : best;
  }
  const left = text.slice(0, at).trim();
  const right = text.slice(at).trim();
  return left && right ? [left, right] : null;
}

/**
 * Cut one clip in two at timeline time `atMs`, on any layer kind. The left half keeps the id; the right half gets a new one and,
 * for media, `in` advances by the cut so the source still lines up. A subtitle also splits its text: at `textIndex` characters, or
 * in half when omitted. Both halves keep the gain.
 */
export function splitClip(project, clipId, atMs, { textIndex } = {}) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  const bad = timeArg(atMs, 'atMs');
  if (bad) return bad;
  const { clip } = f;
  if (atMs <= clip.start || atMs >= endOf(clip)) return fail(ERR.OUT_OF_CLIP, 'Put the playhead inside the clip to split it.');
  if (atMs - clip.start < MIN_CLIP_MS || endOf(clip) - atMs < MIN_CLIP_MS) return fail(ERR.TOO_SHORT, `Each half must be at least ${MIN_CLIP_MS} ms.`);
  if (textIndex !== undefined && (!isInt(textIndex) || textIndex < 1)) return fail(ERR.BAD_ARG, 'textIndex must be a whole number of characters, 1 or more.');
  let texts = null;
  if (f.layer.kind === 'subtitle') {
    texts = splitText(clip.text, textIndex);
    if (!texts) return fail(ERR.BAD_TEXT, 'That text cannot be split there; both halves need words.');
  }
  const id = nextClipId(project);
  const res = edit(project, () => [f.layer.id], (p) => {
    const layer = p.layers.find((l) => l.id === f.layer.id);
    const c = layer.clips.find((x) => x.id === clipId);
    const right = { ...c, id, start: atMs, duration: endOf(c) - atMs };
    c.duration = atMs - c.start;
    if (texts) { c.text = texts[0]; right.text = texts[1]; } else right.in = c.in + Math.round((atMs - c.start) * (c.speed ?? 1));
    if (right.zoom) right.zoom = { ...right.zoom, at: right.zoom.at - (atMs - c.start) };
    layer.clips.push(right);
    splitLines(p, clipId, id, c.duration);
    return undefined;
  });
  return res.ok ? { ...res, clipId, newClipId: id } : res;
}

/**
 * Trim one edge of a clip to timeline time `toMs`. Trimming the start moves `in` by the same amount for media, so the picture and
 * sound stay in place; it cannot reach before the start of the source (`BEFORE_SOURCE`). Trimming the end only changes the duration
 * (the source length is not known here; a render shows black or silence past a source's end).
 */
export function trimClip(project, clipId, edge, toMs) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (edge !== 'start' && edge !== 'end') return fail(ERR.BAD_ARG, 'edge must be "start" or "end".');
  const bad = timeArg(toMs, 'toMs');
  if (bad) return bad;
  const c = f.clip;
  if (edge === 'start') {
    if (endOf(c) - toMs < MIN_CLIP_MS) return fail(ERR.TOO_SHORT, `A clip keeps at least ${MIN_CLIP_MS} ms.`);
    if (MEDIA_KINDS.has(f.layer.kind) && c.in + Math.round((toMs - c.start) * (c.speed ?? 1)) < 0) return fail(ERR.BEFORE_SOURCE, 'The clip already starts at the beginning of its source.');
  } else if (toMs - c.start < MIN_CLIP_MS) return fail(ERR.TOO_SHORT, `A clip keeps at least ${MIN_CLIP_MS} ms.`);
  return edit(project, () => [f.layer.id], (p) => {
    const t = p.layers.find((l) => l.id === f.layer.id).clips.find((x) => x.id === clipId);
    if (edge === 'start') {
      const delta = toMs - t.start;
      if (MEDIA_KINDS.has(f.layer.kind)) t.in += Math.round(delta * (t.speed ?? 1));
      if (t.zoom) t.zoom = { ...t.zoom, at: t.zoom.at - delta };
      reanchorLines(p, clipId, delta);
      t.start = toMs;
      t.duration -= delta;
    } else t.duration = toMs - t.start;
    return undefined;
  });
}

const targetLayer = (project, clip, layer, toLayerId) => {
  if (toLayerId === undefined || toLayerId === layer.id) return { target: layer };
  const target = project.layers.find((l) => l.id === toLayerId);
  if (!target) return { err: fail(ERR.NO_LAYER, `No layer "${toLayerId}".`) };
  if (target.kind !== layer.kind) return { err: fail(ERR.KIND_MISMATCH, `A ${layer.kind} clip cannot go on a ${target.kind} layer.`) };
  if (target.locked) return { err: fail(ERR.LOCKED, `The layer "${target.name}" is locked.`) };
  return { target };
};

/** Move a clip to a new start, optionally onto another layer of the same kind. */
export function moveClip(project, clipId, toStartMs, toLayerId) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  const bad = timeArg(toStartMs, 'toStartMs');
  if (bad) return bad;
  const { target, err } = targetLayer(project, f.clip, f.layer, toLayerId);
  if (err) return err;
  return edit(project, () => [f.layer.id, target.id], (p) => {
    const from = p.layers.find((l) => l.id === f.layer.id);
    const to = p.layers.find((l) => l.id === target.id);
    const i = from.clips.findIndex((x) => x.id === clipId);
    const [c] = from.clips.splice(i, 1);
    c.start = toStartMs;
    to.clips.push(c);
    return undefined;
  });
}

/** Duplicate a clip at a new start, on its own layer or another of the same kind, with a new id. Only the target layer must be unlocked. */
export function copyClip(project, clipId, toStartMs, toLayerId) {
  if (typeof clipId !== 'string') return fail(ERR.BAD_ARG, 'clipId must be text.');
  const found = locate(project, clipId);
  if (!found) return fail(ERR.NO_CLIP, `No clip "${clipId}".`);
  const bad = timeArg(toStartMs, 'toStartMs');
  if (bad) return bad;
  const { layer, clip } = found;
  const target = toLayerId === undefined ? layer : project.layers.find((l) => l.id === toLayerId);
  if (!target) return fail(ERR.NO_LAYER, `No layer "${toLayerId}".`);
  if (target.kind !== layer.kind) return fail(ERR.KIND_MISMATCH, `A ${layer.kind} clip cannot go on a ${target.kind} layer.`);
  if (target.locked) return fail(ERR.LOCKED, `The layer "${target.name}" is locked.`);
  const id = nextClipId(project);
  const res = edit(project, () => [target.id], (p) => {
    p.layers.find((l) => l.id === target.id).clips.push({ ...clone(clip), id, start: toStartMs });
    return undefined;
  });
  return res.ok ? { ...res, newClipId: id } : res;
}

/** Delete a clip. With `ripple`, every later clip on that layer (starting at or after its end) moves left by its length, closing the gap. */
export function deleteClip(project, clipId, { ripple = false } = {}) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  return edit(project, () => [f.layer.id], (p) => {
    const layer = p.layers.find((l) => l.id === f.layer.id);
    layer.clips = layer.clips.filter((x) => x.id !== clipId);
    if (ripple) for (const c of layer.clips) if (c.start >= endOf(f.clip)) c.start -= f.clip.duration;
    return undefined;
  });
}

const cleanText = (text) => (typeof text === 'string' && text.trim() && text.length <= MAX_TEXT ? text.trim() : null);

/** Replace the text of a subtitle clip. */
export function setSubtitleText(project, clipId, text) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (f.layer.kind !== 'subtitle') return fail(ERR.NOT_SUBTITLE, 'Only a subtitle clip has text.');
  const t = cleanText(text);
  if (!t) return fail(ERR.BAD_TEXT, `A subtitle needs text of 1-${MAX_TEXT} characters.`);
  return edit(project, () => [], (p) => { locate(p, clipId).clip.text = t; return undefined; });
}

/** Add a subtitle clip to a subtitle layer. */
export function addSubtitle(project, layerId, startMs, durationMs, text) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  if (layer.kind !== 'subtitle') return fail(ERR.NOT_SUBTITLE, 'Subtitles go on a subtitle layer.');
  if (layer.locked) return fail(ERR.LOCKED, `The layer "${layer.name}" is locked.`);
  const bad = timeArg(startMs, 'startMs') || timeArg(durationMs, 'durationMs', MIN_CLIP_MS);
  if (bad) return bad;
  const t = cleanText(text);
  if (!t) return fail(ERR.BAD_TEXT, `A subtitle needs text of 1-${MAX_TEXT} characters.`);
  const id = nextClipId(project);
  const res = edit(project, () => [layerId], (p) => { p.layers.find((l) => l.id === layerId).clips.push({ id, start: startMs, duration: durationMs, in: 0, text: t }); return undefined; });
  return res.ok ? { ...res, newClipId: id } : res;
}

/** Add a media clip (video, voice or music) naming a workspace file by bare name. `inMs` is where in the file it starts playing. */
export function addClip(project, layerId, { src, start, duration, inMs = 0, gain } = {}) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  if (!MEDIA_KINDS.has(layer.kind)) return fail(ERR.KIND_MISMATCH, 'Media goes on a video, voice or music layer.');
  if (layer.locked) return fail(ERR.LOCKED, `The layer "${layer.name}" is locked.`);
  if (!isMediaName(src)) return fail(ERR.BAD_ARG, 'src must be the bare name of a video or audio file in the workspace, never a path.');
  const bad = timeArg(start, 'start') || timeArg(duration, 'duration', MIN_CLIP_MS) || timeArg(inMs, 'inMs');
  if (bad) return bad;
  if (gain !== undefined && (typeof gain !== 'number' || !(gain >= 0 && gain <= 4) || layer.kind === 'video')) return fail(ERR.BAD_GAIN, 'gain is a number from 0 to 4, on a voice or music clip.');
  const id = nextClipId(project);
  const res = edit(project, () => [layerId], (p) => {
    p.layers.find((l) => l.id === layerId).clips.push({ id, start, duration, in: inMs, src, ...(gain !== undefined ? { gain } : {}) });
    return undefined;
  });
  return res.ok ? { ...res, newClipId: id } : res;
}

/** Set a voice or music clip's linear gain (1 = unchanged). */
export function setClipGain(project, clipId, gain) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (f.layer.kind !== 'voice' && f.layer.kind !== 'music') return fail(ERR.BAD_GAIN, 'Only voice and music clips have a gain.');
  if (typeof gain !== 'number' || !(gain >= 0 && gain <= 4)) return fail(ERR.BAD_GAIN, 'gain is a number from 0 to 4.');
  return edit(project, () => [], (p) => { locate(p, clipId).clip.gain = gain; return undefined; });
}

/**
 * Set a video, voice or music clip's speed (0.25 to 16; 1 is normal and removes the field). The clip keeps the same part of its
 * source, so its length on the timeline becomes duration * old speed / new speed. With `ripple`, later clips on the layer move
 * by the difference. A zoom on the clip keeps its place in the picture (its times scale with the speed).
 */
export function setClipSpeed(project, clipId, speed, { ripple = false } = {}) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (!MEDIA_KINDS.has(f.layer.kind)) return fail(ERR.BAD_SPEED, 'Only video, voice and music clips have a speed.');
  const why = speedProblem(speed);
  if (why) return fail(ERR.BAD_SPEED, why);
  const old = f.clip.speed ?? 1;
  const duration = Math.max(MIN_CLIP_MS, Math.round((f.clip.duration * old) / speed));
  if (duration > MAX_MS) return fail(ERR.BAD_SPEED, 'That speed would make the clip longer than a project may be.');
  const delta = duration - f.clip.duration;
  if (ripple && delta > 0 && f.layer.clips.some((o) => o.id !== clipId && o.start >= endOf(f.clip) && o.start + delta > MAX_MS)) return fail(ERR.BAD_SPEED, 'Moving the later clips would put them past the end a project may have.');
  return edit(project, () => [f.layer.id], (p) => {
    const layer = p.layers.find((l) => l.id === f.layer.id);
    const c = layer.clips.find((x) => x.id === clipId);
    const oldEnd = endOf(c);
    const k = old / speed;
    c.duration = duration;
    if (speed === 1) delete c.speed; else c.speed = speed;
    if (c.zoom) c.zoom = { ...c.zoom, at: Math.round(c.zoom.at * k), ramp: Math.round(c.zoom.ramp * k), hold: c.zoom.hold === null ? null : Math.round(c.zoom.hold * k) };
    for (const line of linesOf(p, clipId)) line.points = retime(line.points, (t) => t * k); // a line stays attached to the picture when the clip is stretched
    if (ripple && delta) for (const o of layer.clips) if (o.id !== clipId && o.start >= oldEnd) o.start += delta;
    return undefined;
  });
}

/** Set a video clip's opacity (0 invisible to 1 solid; 1 removes the field). */
export function setClipOpacity(project, clipId, opacity) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (f.layer.kind !== 'video') return fail(ERR.BAD_OPACITY, 'Only video clips have an opacity.');
  const why = opacityProblem(opacity);
  if (why) return fail(ERR.BAD_OPACITY, why);
  return edit(project, () => [], (p) => { const c = locate(p, clipId).clip; if (opacity === 1) delete c.opacity; else c.opacity = opacity; return undefined; });
}

/**
 * Set or clear (`null`) a video clip's zoom: `{ scale, x, y, at, ramp, hold }`, see ui/effects.mjs. Missing fields take the defaults
 * (2x, centred, at the start, 600 ms ramp, stay zoomed).
 */
export function setClipZoom(project, clipId, zoom) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (f.layer.kind !== 'video') return fail(ERR.BAD_ZOOM, 'Only video clips have a zoom.');
  if (zoom === undefined) return fail(ERR.BAD_ZOOM, 'zoom is an object { scale, x, y, at, ramp, hold }, or null to remove it.');
  const z = zoom === null ? null : (zoom !== null && typeof zoom === 'object' && !Array.isArray(zoom) ? { ...ZOOM_DEFAULT, ...zoom } : zoom);
  if (z !== null) { const why = zoomProblem(z); if (why) return fail(ERR.BAD_ZOOM, why); }
  return edit(project, () => [], (p) => { const c = locate(p, clipId).clip; if (z === null) delete c.zoom; else c.zoom = z; return undefined; });
}

/** Set the volume of the whole mix (0 to 4; 1 is unchanged and removes the field). It applies to the preview and to every export. */
export function setMasterGain(project, gain) {
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 4) return fail(ERR.BAD_GAIN, 'master is a number from 0 to 4.');
  return edit(project, () => [], (p) => { if (gain === 1) delete p.master; else p.master = gain; return undefined; });
}

/** Set the volume of a whole voice or music layer (0 to 4; 1 removes the field). A locked layer refuses, like its clips. */
export function setLayerGain(project, layerId, gain) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  if (layer.kind !== 'voice' && layer.kind !== 'music') return fail(ERR.BAD_GAIN, 'Only voice and music layers have a volume.');
  if (layer.locked) return fail(ERR.LOCKED, `The layer "${layer.name}" is locked.`);
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 4) return fail(ERR.BAD_GAIN, 'gain is a number from 0 to 4.');
  return edit(project, () => [], (p) => { const l = p.layers.find((x) => x.id === layerId); if (gain === 1) delete l.gain; else l.gain = gain; return undefined; });
}

// ---------------------------------------------------------------- automation: a line drawn for one param of one clip, on a layer of its own

const MAX_LAYERS_LINES = 64;

/** The automation layer `layerId`, or an error result: unknown layer, not an automation layer, or locked. */
function lineLayer(project, layerId, { needUnlocked = true } = {}) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return { err: fail(ERR.NO_LAYER, `No layer "${layerId}".`) };
  if (layer.kind !== 'automation') return { err: fail(ERR.BAD_AUTOMATION, `The layer "${layer.name}" is not an automation layer.`) };
  if (needUnlocked && layer.locked) return { err: fail(ERR.LOCKED, `The layer "${layer.name}" is locked.`) };
  return { layer, target: locate(project, layer.link.clipId) };
}

const lineName = (clip, param) => `${String(clip.src || 'clip').slice(0, 28)}: ${PARAMS[param].label}`;
const valueIn = (param, v) => typeof v === 'number' && Number.isFinite(v) && v >= PARAMS[param].min && v <= PARAMS[param].max;
const tidy = (v) => Math.round(v * 10000) / 10000;

/** Insert a new line for `clipId` right below the clip's layer (below the lines it already has), pushing the layers under it down. */
function insertLine(p, targetLayerId, line) {
  let at = p.layers.findIndex((l) => l.id === targetLayerId) + 1;
  while (p.layers[at] && p.layers[at].kind === 'automation') at++;
  p.layers.splice(at, 0, line);
}

/**
 * Start a line for `param` (volume `gain`, `pan`, `mute` or `opacity`) of a clip. It sits on its own automation layer right below the clip's layer,
 * with one point at the start holding the value the clip has now, so nothing changes until you draw. One line per param per clip.
 */
export function addAutomation(project, clipId, param) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (typeof param !== 'string' || !AUTOMATABLE.includes(param)) return fail(ERR.BAD_AUTOMATION, `param must be one of ${AUTOMATABLE.join(', ')}.`);
  if (!PARAMS[param].clips.includes(f.layer.kind)) return fail(ERR.BAD_AUTOMATION, `A ${f.layer.kind} clip has no ${param} line.`);
  if (project.layers.some((l) => l.kind === 'automation' && l.link.clipId === clipId && l.link.param === param)) return fail(ERR.BAD_AUTOMATION, `This clip already has a ${PARAMS[param].label.toLowerCase()} line.`);
  if (project.layers.length >= MAX_LAYERS_LINES) return fail(ERR.BAD_ARG, `A project holds at most ${MAX_LAYERS_LINES} layers.`);
  const id = nextLayerId(project);
  const v = Math.min(PARAMS[param].max, Math.max(PARAMS[param].min, baseValue(f.clip, f.layer.kind, param)));
  const res = edit(project, () => [], (p) => {
    insertLine(p, f.layer.id, { id, kind: 'automation', name: lineName(f.clip, param), muted: false, locked: false, clips: [], link: { clipId, param }, points: [{ t: 0, v, curve: 'linear' }] });
    return undefined;
  });
  return res.ok ? { ...res, newLayerId: id } : res;
}

/** Add a point at `t` ms from the clip's start with value `v` (and the `curve` towards the next point). Two points may not share a time. */
export function addPoint(project, layerId, t, v, curve = 'linear') {
  const { layer, err } = lineLayer(project, layerId);
  if (err) return err;
  const param = layer.link.param;
  if (!CURVES.includes(curve)) return fail(ERR.BAD_AUTOMATION, `curve is one of ${CURVES.join(', ')}.`);
  const bad = timeArg(t, 't');
  if (bad) return bad;
  if (!valueIn(param, v)) return fail(ERR.BAD_AUTOMATION, `v is a number from ${PARAMS[param].min} to ${PARAMS[param].max} for ${param}.`);
  if (layer.points.some((pt) => pt.t === t)) return fail(ERR.POINT_CROSSING, 'There is already a point at that time; move it instead.');
  if (layer.points.length >= MAX_POINTS) return fail(ERR.BAD_AUTOMATION, `A line holds at most ${MAX_POINTS} points.`);
  let index = 0;
  const res = edit(project, () => [], (p) => {
    const l = p.layers.find((x) => x.id === layerId);
    l.points.push({ t, v: tidy(v), curve });
    l.points.sort((a, b) => a.t - b.t);
    index = l.points.findIndex((pt) => pt.t === t);
    return undefined;
  });
  return res.ok ? { ...res, pointIndex: index } : res;
}

const pointAt = (layer, index) => (Number.isSafeInteger(index) && index >= 0 && index < layer.points.length ? layer.points[index] : null);

/** Move point `index` to time `t` and value `v`. It may not cross or touch its neighbours in time (it keeps its place in the order). */
export function movePoint(project, layerId, index, t, v) {
  const { layer, err } = lineLayer(project, layerId);
  if (err) return err;
  if (!pointAt(layer, index)) return fail(ERR.NO_POINT, `No point ${String(index)} on the line "${layer.name}".`);
  const bad = timeArg(t, 't');
  if (bad) return bad;
  if (!valueIn(layer.link.param, v)) return fail(ERR.BAD_AUTOMATION, `v is a number from ${PARAMS[layer.link.param].min} to ${PARAMS[layer.link.param].max} for ${layer.link.param}.`);
  const prev = layer.points[index - 1];
  const next = layer.points[index + 1];
  if ((prev && t <= prev.t) || (next && t >= next.t)) return fail(ERR.POINT_CROSSING, 'A point may not cross or touch the points beside it.');
  return edit(project, () => [], (p) => { const pt = p.layers.find((x) => x.id === layerId).points[index]; pt.t = t; pt.v = tidy(v); return undefined; });
}

/** Delete point `index`. A line keeps at least one point: to remove the line itself, delete its layer. */
export function deletePoint(project, layerId, index) {
  const { layer, err } = lineLayer(project, layerId);
  if (err) return err;
  if (!pointAt(layer, index)) return fail(ERR.NO_POINT, `No point ${String(index)} on the line "${layer.name}".`);
  if (layer.points.length === 1) return fail(ERR.BAD_AUTOMATION, 'A line needs at least one point. To remove the line, delete its layer.');
  return edit(project, () => [], (p) => { p.layers.find((x) => x.id === layerId).points.splice(index, 1); return undefined; });
}

/** Set how the value gets from point `index` to the next one: linear, hold, ease-in, ease-out or ease-in-out. */
export function setCurve(project, layerId, index, curve) {
  const { layer, err } = lineLayer(project, layerId);
  if (err) return err;
  if (!pointAt(layer, index)) return fail(ERR.NO_POINT, `No point ${String(index)} on the line "${layer.name}".`);
  if (!CURVES.includes(curve)) return fail(ERR.BAD_AUTOMATION, `curve is one of ${CURVES.join(', ')}.`);
  return edit(project, () => [], (p) => { p.layers.find((x) => x.id === layerId).points[index].curve = curve; return undefined; });
}

/** Wipe the drawing: one point at the start, holding the value the line had there. */
export function clearLane(project, layerId) {
  const { layer, err } = lineLayer(project, layerId);
  if (err) return err;
  return edit(project, () => [], (p) => { const l = p.layers.find((x) => x.id === layerId); l.points = [{ t: 0, v: layer.points[0].v, curve: 'linear' }]; return undefined; });
}

/**
 * Copy the line `fromLayerId` onto another clip (a new line of the same param, below that clip's layer). With `fit` its times are stretched or squeezed
 * to the other clip's length. The clip must be able to have that param and not already have a line for it.
 */
export function copyLane(project, fromLayerId, toClipId, { fit = false } = {}) {
  const { layer: src, target: from, err } = lineLayer(project, fromLayerId, { needUnlocked: false });
  if (err) return err;
  const f = withClip(project, toClipId);
  if (f.err) return f.err;
  const param = src.link.param;
  if (!PARAMS[param].clips.includes(f.layer.kind)) return fail(ERR.BAD_AUTOMATION, `A ${f.layer.kind} clip has no ${param} line.`);
  if (project.layers.some((l) => l.kind === 'automation' && l.link.clipId === toClipId && l.link.param === param)) return fail(ERR.BAD_AUTOMATION, `That clip already has a ${PARAMS[param].label.toLowerCase()} line; paste onto it instead.`);
  if (project.layers.length >= MAX_LAYERS_LINES) return fail(ERR.BAD_ARG, `A project holds at most ${MAX_LAYERS_LINES} layers.`);
  const id = nextLayerId(project);
  const ratio = fit && from ? f.clip.duration / from.clip.duration : 1;
  const res = edit(project, () => [], (p) => {
    insertLine(p, f.layer.id, { id, kind: 'automation', name: lineName(f.clip, param), muted: false, locked: false, clips: [], link: { clipId: toClipId, param }, points: retime(clone(src.points), (t) => t * ratio) });
    return undefined;
  });
  return res.ok ? { ...res, newLayerId: id } : res;
}

/** Replace the points of a line with `points` (`[{ t, v, curve }]`, checked like any line): what pasting a copied line does. */
export function pasteLane(project, layerId, points) {
  const { layer, target, err } = lineLayer(project, layerId);
  if (err) return err;
  if (!Array.isArray(points)) return fail(ERR.BAD_AUTOMATION, 'points is a list of { t, v, curve }.');
  const clean = points.map((pt) => (pt !== null && typeof pt === 'object' ? { t: pt.t, v: pt.v, curve: pt.curve } : pt));
  const why = lineProblem(layer.link.param, clean, target ? locate(project, layer.link.clipId).layer.kind : 'none');
  if (why) return fail(ERR.BAD_AUTOMATION, why);
  return edit(project, () => [], (p) => { p.layers.find((x) => x.id === layerId).points = clean.map((pt) => ({ ...pt, v: tidy(pt.v) })); return undefined; });
}

/**
 * Bake a line into a constant on its clip and remove the line. `at` picks the value: "start" (the first point), "end", "mean" (the average over the
 * clip) or a number. Volume, pan and opacity become the clip's own gain, pan and opacity; mute has no constant, so delete its layer instead.
 */
export function flattenLane(project, layerId, { at = 'start' } = {}) {
  const { layer, target, err } = lineLayer(project, layerId);
  if (err) return err;
  if (!target) return fail(ERR.NO_CLIP, 'The clip this line belonged to is gone.');
  const param = layer.link.param;
  if (!['gain', 'pan', 'opacity'].includes(param)) return fail(ERR.BAD_AUTOMATION, `A ${param} line cannot be baked into a constant. Delete its layer to remove it.`);
  let v;
  if (at === 'start') v = layer.points[0].v;
  else if (at === 'end') v = layer.points[layer.points.length - 1].v;
  else if (at === 'mean') v = laneMean(layer.points, 0, target.clip.duration);
  else if (valueIn(param, at)) v = at;
  else return fail(ERR.BAD_ARG, `at is "start", "end", "mean" or a number from ${PARAMS[param].min} to ${PARAMS[param].max}.`);
  if (target.layer.locked) return fail(ERR.LOCKED, `The layer "${target.layer.name}" is locked.`);
  v = Math.min(PARAMS[param].max, Math.max(PARAMS[param].min, tidy(v)));
  return edit(project, () => [], (p) => {
    const c = locate(p, layer.link.clipId).clip;
    if (param === 'opacity' && v === 1) delete c.opacity; else c[param] = v;
    p.layers = p.layers.filter((l) => l.id !== layerId);
    return undefined;
  });
}

/** Set a voice or music clip's stereo pan, -1 (left) to 1 (right); 0 is centred and removes the field. */
export function setClipPan(project, clipId, pan) {
  const f = withClip(project, clipId);
  if (f.err) return f.err;
  if (f.layer.kind !== 'voice' && f.layer.kind !== 'music') return fail(ERR.BAD_PAN, 'Only voice and music clips have a pan.');
  if (typeof pan !== 'number' || !Number.isFinite(pan) || pan < -1 || pan > 1) return fail(ERR.BAD_PAN, 'pan is a number from -1 (left) to 1 (right).');
  return edit(project, () => [], (p) => { const c = locate(p, clipId).clip; if (pan === 0) delete c.pan; else c.pan = pan; return undefined; });
}

/** Set the stereo pan of a whole voice or music layer, -1 to 1; 0 removes the field. A locked layer refuses. */
export function setLayerPan(project, layerId, pan) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  if (layer.kind !== 'voice' && layer.kind !== 'music') return fail(ERR.BAD_PAN, 'Only voice and music layers have a pan.');
  if (layer.locked) return fail(ERR.LOCKED, `The layer "${layer.name}" is locked.`);
  if (typeof pan !== 'number' || !Number.isFinite(pan) || pan < -1 || pan > 1) return fail(ERR.BAD_PAN, 'pan is a number from -1 (left) to 1 (right).');
  return edit(project, () => [], (p) => { const l = p.layers.find((x) => x.id === layerId); if (pan === 0) delete l.pan; else l.pan = pan; return undefined; });
}

/** Mute or lock a layer. Works on a locked layer (that is how it is unlocked). */
export function setLayerFlag(project, layerId, flag, value) {
  if (flag !== 'muted' && flag !== 'locked') return fail(ERR.BAD_ARG, 'flag must be "muted" or "locked".');
  if (typeof value !== 'boolean') return fail(ERR.BAD_ARG, 'value must be true or false.');
  if (!project.layers.some((l) => l.id === layerId)) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  return edit(project, () => [], (p) => { p.layers.find((l) => l.id === layerId)[flag] = value; return undefined; });
}

/** The next free layer id: `l` + (highest number used by any `l<n>` layer id) + 1. Layer and clip ids share one namespace, and clips are `c<n>`, so these never clash. */
export function nextLayerId(project) {
  let max = 0;
  for (const l of project.layers) { const m = /^l(\d+)$/.exec(l.id); if (m) max = Math.max(max, Number(m[1])); }
  return `l${max + 1}`;
}

const MAX_LAYERS = 64;
const MAX_CLIPS = 5000;

const KIND_LABEL = { video: 'Video', voice: 'Voice', music: 'Music', subtitle: 'Subtitles' };

/**
 * Add an empty layer of `kind` (video, voice, music or subtitle). It goes right after the last layer of that kind (or at the end
 * when there is none) so like layers stay together, and is named `name` or "<Kind> 2", "<Kind> 3", ... (the first free number).
 */
export function addLayer(project, kind, { name } = {}) {
  if (kind === 'automation') return fail(ERR.BAD_KIND, 'An automation layer is a line for a clip on another layer; make it from that clip, not as an empty layer.');
  if (!KINDS.includes(kind)) return fail(ERR.BAD_KIND, `kind must be one of ${KINDS.join(', ')}.`);
  if (project.layers.length >= MAX_LAYERS) return fail(ERR.BAD_ARG, `A project holds at most ${MAX_LAYERS} layers.`);
  const taken = new Set(project.layers.map((l) => l.name));
  let label;
  if (name === undefined) {
    label = KIND_LABEL[kind];
    for (let n = 2; taken.has(label); n++) label = `${KIND_LABEL[kind]} ${n}`;
  } else {
    label = typeof name === 'string' ? name.trim() : '';
    if (!label || label.length > 80) return fail(ERR.BAD_NAME, 'A layer name is text of 1-80 characters.');
  }
  const id = nextLayerId(project);
  const res = edit(project, () => [], (p) => {
    let at = p.layers.length;
    for (let i = p.layers.length - 1; i >= 0; i--) if (p.layers[i].kind === kind) { at = i + 1; break; }
    p.layers.splice(at, 0, { id, kind, name: label, muted: false, locked: false, clips: [] });
    return undefined;
  });
  return res.ok ? { ...res, newLayerId: id } : res;
}

/**
 * Duplicate a layer with all of its clips: the copy sits right below the original, has the same kind and mute flag, is never
 * locked, is named "<name> copy" (then "copy 2", ...), and its clips get new ids and keep their times and sources. The original's
 * lock does not matter (nothing on it changes).
 */
export function duplicateLayer(project, layerId) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  if (layer.kind === 'automation') return fail(ERR.BAD_AUTOMATION, 'A line belongs to one clip. Copy it onto another clip with copyLane instead of duplicating its layer.');
  if (project.layers.length >= MAX_LAYERS) return fail(ERR.BAD_ARG, `A project holds at most ${MAX_LAYERS} layers.`);
  if (project.layers.reduce((n, l) => n + l.clips.length, 0) + layer.clips.length > MAX_CLIPS) return fail(ERR.BAD_ARG, `A project holds at most ${MAX_CLIPS} clips.`);
  const id = nextLayerId(project);
  const base = layer.name.replace(/ copy( \d+)?$/, '').slice(0, 70);
  const taken = new Set(project.layers.map((l) => l.name));
  let name = `${base} copy`;
  for (let n = 2; taken.has(name); n++) name = `${base} copy ${n}`;
  let next = Number(nextClipId(project).slice(1));
  const clipIds = [];
  const res = edit(project, () => [id], (p) => {
    const at = p.layers.findIndex((l) => l.id === layerId);
    const copy = clone(layer);
    copy.id = id;
    copy.name = name;
    copy.locked = false;
    copy.clips = copy.clips.map((c) => { const cid = `c${next++}`; clipIds.push(cid); return { ...c, id: cid }; });
    p.layers.splice(at + 1, 0, copy);
    return undefined;
  });
  return res.ok ? { ...res, newLayerId: id, newClipIds: clipIds } : res;
}

/** Delete a layer with all of its clips (one undo step brings it back). A locked layer refuses: unlock it first. */
export function deleteLayer(project, layerId) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  if (layer.locked) return fail(ERR.LOCKED, `The layer "${layer.name}" is locked.`);
  const res = edit(project, () => [], (p) => { p.layers = p.layers.filter((l) => l.id !== layerId); return undefined; });
  return res.ok ? { ...res, removedClips: layer.clips.length } : res;
}

// ---------------------------------------------------------------- batch ops: many clips, all or nothing, one undo step

const MAX_BATCH = 500;

/** Resolve a list of clip ids to `[{ layer, clip }]` in the order given: unique text ids, 1..MAX_BATCH, all present. Returns `{ err }` or `{ found }`. */
function resolveMany(project, clipIds, { needUnlocked = true } = {}) {
  if (!Array.isArray(clipIds) || !clipIds.length || clipIds.length > MAX_BATCH || clipIds.some((id) => typeof id !== 'string') || new Set(clipIds).size !== clipIds.length) {
    return { err: fail(ERR.BAD_ARG, `clipIds must be a list of 1 to ${MAX_BATCH} different clip ids.`) };
  }
  const found = [];
  for (const id of clipIds) {
    const f = locate(project, id);
    if (!f) return { err: fail(ERR.NO_CLIP, `No clip "${id}".`) };
    if (needUnlocked && f.layer.locked) return { err: fail(ERR.LOCKED, `The layer "${f.layer.name}" is locked.`) };
    found.push(f);
  }
  return { found };
}

/** Delete several clips at once. With `ripple`, each affected layer closes the gaps the deleted clips leave (later clips move left). All or nothing. */
export function deleteClips(project, clipIds, { ripple = false } = {}) {
  const { found, err } = resolveMany(project, clipIds);
  if (err) return err;
  const gone = new Set(clipIds);
  const layerIds = [...new Set(found.map((f) => f.layer.id))];
  const res = edit(project, () => layerIds, (p) => {
    for (const id of layerIds) {
      const layer = p.layers.find((l) => l.id === id);
      const removed = layer.clips.filter((c) => gone.has(c.id)).sort((a, b) => b.start - a.start); // latest first: earlier gaps stay where they are
      layer.clips = layer.clips.filter((c) => !gone.has(c.id));
      if (ripple) for (const r of removed) for (const c of layer.clips) if (c.start >= endOf(r)) c.start -= r.duration;
    }
    return undefined;
  });
  return res.ok ? { ...res, removed: clipIds.length } : res;
}

/**
 * Copy several clips at once. The earliest of them lands at `toStartMs` and the others keep their distances from it (and their
 * layers). With `toLayerId` they all go on that layer, which they must all share the kind of, and only when they came from one layer.
 * New ids are given in start order. All or nothing (an overlap on a subtitle layer refuses the whole paste).
 */
export function copyClips(project, clipIds, toStartMs, { toLayerId } = {}) {
  const { found, err } = resolveMany(project, clipIds, { needUnlocked: false });
  if (err) return err;
  const bad = timeArg(toStartMs, 'toStartMs');
  if (bad) return bad;
  const order = [...found].sort((a, b) => a.clip.start - b.clip.start || clipIds.indexOf(a.clip.id) - clipIds.indexOf(b.clip.id));
  const base = order[0].clip.start;
  let target = null;
  if (toLayerId !== undefined) {
    if (new Set(found.map((f) => f.layer.id)).size > 1) return fail(ERR.BAD_ARG, 'toLayerId needs clips from a single layer; leave it out to keep each clip on its own layer.');
    target = project.layers.find((l) => l.id === toLayerId);
    if (!target) return fail(ERR.NO_LAYER, `No layer "${toLayerId}".`);
    if (target.kind !== order[0].layer.kind) return fail(ERR.KIND_MISMATCH, `A ${order[0].layer.kind} clip cannot go on a ${target.kind} layer.`);
  }
  for (const t of new Set(order.map((f) => (target || f.layer).id))) {
    const l = project.layers.find((x) => x.id === t);
    if (l.locked) return fail(ERR.LOCKED, `The layer "${l.name}" is locked.`);
  }
  for (const f of order) if (f.clip.start - base + toStartMs > MAX_MS) return fail(ERR.BAD_ARG, `A pasted clip would start after ${MAX_MS} ms.`);
  if (project.layers.reduce((n, l) => n + l.clips.length, 0) + order.length > MAX_CLIPS) return fail(ERR.BAD_ARG, `A project holds at most ${MAX_CLIPS} clips.`);
  let next = Number(nextClipId(project).slice(1));
  const newClipIds = [];
  const layerIds = [...new Set(order.map((f) => (target || f.layer).id))];
  const res = edit(project, () => layerIds, (p) => {
    for (const f of order) {
      const id = `c${next++}`;
      newClipIds.push(id);
      p.layers.find((l) => l.id === (target || f.layer).id).clips.push({ ...clone(f.clip), id, start: f.clip.start - base + toStartMs });
    }
    return undefined;
  });
  return res.ok ? { ...res, newClipIds } : res;
}

/**
 * Move several clips at once: `moves` is `[{ clipId, toStartMs, toLayerId? }]`. Overlaps are checked once at the end, so clips may
 * swap places or move together without an in-between clash. A clip may change layer only to one of the same kind. All or nothing.
 */
export function moveClips(project, moves) {
  if (!Array.isArray(moves) || !moves.length || moves.length > MAX_BATCH || moves.some((m) => m === null || typeof m !== 'object')) return fail(ERR.BAD_ARG, `moves must be a list of 1 to ${MAX_BATCH} { clipId, toStartMs, toLayerId? }.`);
  const { found, err } = resolveMany(project, moves.map((m) => m.clipId));
  if (err) return err;
  const plan = [];
  for (let i = 0; i < moves.length; i++) {
    const bad = timeArg(moves[i].toStartMs, 'toStartMs');
    if (bad) return bad;
    const { target, err: e2 } = targetLayer(project, found[i].clip, found[i].layer, moves[i].toLayerId);
    if (e2) return e2;
    plan.push({ id: moves[i].clipId, from: found[i].layer.id, to: target.id, start: moves[i].toStartMs });
  }
  const touched = [...new Set(plan.flatMap((m) => [m.from, m.to]))];
  return edit(project, () => touched, (p) => {
    for (const m of plan) {
      const from = p.layers.find((l) => l.id === m.from);
      const c = from.clips.splice(from.clips.findIndex((x) => x.id === m.id), 1)[0];
      c.start = m.start;
      p.layers.find((l) => l.id === m.to).clips.push(c);
    }
    return undefined;
  });
}

// ---------------------------------------------------------------- notes

/** The next free note id: `n` + (highest number used by any `n<n>` note) + 1. */
export function nextNoteId(project) {
  let max = 0;
  for (const n of project.notes ?? []) { const m = /^n(\d+)$/.exec(n.id); if (m) max = Math.max(max, Number(m[1])); }
  return `n${max + 1}`;
}
const byTime = (a, b) => a.at - b.at || a.id.localeCompare(b.id);

/** Pin a note (1-500 characters) to timeline time `at`. A project holds at most MAX_NOTES; they are kept in time order. */
export function addNote(project, at, text) {
  const bad = timeArg(at, 'at');
  if (bad) return bad;
  const t = cleanText(text);
  if (!t) return fail(ERR.BAD_NOTE, `A note needs text of 1-${MAX_TEXT} characters.`);
  if ((project.notes ?? []).length >= MAX_NOTES) return fail(ERR.BAD_NOTE, `A project holds at most ${MAX_NOTES} notes.`);
  const id = nextNoteId(project);
  const res = edit(project, () => [], (p) => { p.notes = [...(p.notes ?? []), { id, at, text: t }].sort(byTime); return undefined; });
  return res.ok ? { ...res, newNoteId: id } : res;
}

/** Change a note's text, its time, or whether it is done (any of `{ text, at, done }`; the rest stay as they are). */
export function editNote(project, noteId, { text, at, done } = {}) {
  if (!(project.notes ?? []).some((n) => n.id === noteId)) return fail(ERR.NO_NOTE, `No note "${String(noteId).slice(0, 40)}".`);
  if (text === undefined && at === undefined && done === undefined) return fail(ERR.BAD_ARG, 'Give the note a new text, at or done.');
  let t;
  if (text !== undefined) { t = cleanText(text); if (!t) return fail(ERR.BAD_NOTE, `A note needs text of 1-${MAX_TEXT} characters.`); }
  if (at !== undefined) { const bad = timeArg(at, 'at'); if (bad) return bad; }
  if (done !== undefined && typeof done !== 'boolean') return fail(ERR.BAD_NOTE, 'done is true or false.');
  return edit(project, () => [], (p) => {
    const n = p.notes.find((x) => x.id === noteId);
    if (t !== undefined) n.text = t;
    if (at !== undefined) n.at = at;
    if (done === true) n.done = true; else if (done === false) delete n.done;
    p.notes.sort(byTime);
    return undefined;
  });
}

/** Remove a note. The last one takes the `notes` field with it. */
export function deleteNote(project, noteId) {
  if (!(project.notes ?? []).some((n) => n.id === noteId)) return fail(ERR.NO_NOTE, `No note "${String(noteId).slice(0, 40)}".`);
  return edit(project, () => [], (p) => { p.notes = p.notes.filter((n) => n.id !== noteId); if (!p.notes.length) delete p.notes; return undefined; });
}

/** The named ops the HTTP endpoint accepts, each mapping a JSON `args` object onto the function above. Undo and redo are the history's, in routes.mjs. */
export const OPS = Object.freeze({
  splitClip: (p, a) => splitClip(p, a.clipId, a.atMs, { textIndex: a.textIndex }),
  trimClip: (p, a) => trimClip(p, a.clipId, a.edge, a.toMs),
  moveClip: (p, a) => moveClip(p, a.clipId, a.toStartMs, a.toLayerId),
  copyClip: (p, a) => copyClip(p, a.clipId, a.toStartMs, a.toLayerId),
  deleteClip: (p, a) => deleteClip(p, a.clipId, { ripple: a.ripple === true }),
  setSubtitleText: (p, a) => setSubtitleText(p, a.clipId, a.text),
  addSubtitle: (p, a) => addSubtitle(p, a.layerId, a.startMs, a.durationMs, a.text),
  addClip: (p, a) => addClip(p, a.layerId, { src: a.src, start: a.start, duration: a.duration, inMs: a.in ?? 0, gain: a.gain }),
  setClipGain: (p, a) => setClipGain(p, a.clipId, a.gain),
  setLayerFlag: (p, a) => setLayerFlag(p, a.layerId, a.flag, a.value),
  setMasterGain: (p, a) => setMasterGain(p, a.gain),
  addAutomation: (p, a) => addAutomation(p, a.clipId, a.param),
  addPoint: (p, a) => addPoint(p, a.layerId, a.t, a.v, a.curve),
  movePoint: (p, a) => movePoint(p, a.layerId, a.index, a.t, a.v),
  deletePoint: (p, a) => deletePoint(p, a.layerId, a.index),
  setCurve: (p, a) => setCurve(p, a.layerId, a.index, a.curve),
  clearLane: (p, a) => clearLane(p, a.layerId),
  copyLane: (p, a) => copyLane(p, a.fromLayerId, a.toClipId, { fit: a.fit === true }),
  pasteLane: (p, a) => pasteLane(p, a.layerId, a.points),
  flattenLane: (p, a) => flattenLane(p, a.layerId, { at: a.at === undefined ? 'start' : a.at }),
  setClipPan: (p, a) => setClipPan(p, a.clipId, a.pan),
  setLayerPan: (p, a) => setLayerPan(p, a.layerId, a.pan),
  setLayerGain: (p, a) => setLayerGain(p, a.layerId, a.gain),
  setClipSpeed: (p, a) => setClipSpeed(p, a.clipId, a.speed, { ripple: a.ripple === true }),
  setClipOpacity: (p, a) => setClipOpacity(p, a.clipId, a.opacity),
  setClipZoom: (p, a) => setClipZoom(p, a.clipId, a.zoom),
  addLayer: (p, a) => addLayer(p, a.kind, { name: a.name }),
  duplicateLayer: (p, a) => duplicateLayer(p, a.layerId),
  deleteLayer: (p, a) => deleteLayer(p, a.layerId),
  deleteClips: (p, a) => deleteClips(p, a.clipIds, { ripple: a.ripple === true }),
  copyClips: (p, a) => copyClips(p, a.clipIds, a.toStartMs, { toLayerId: a.toLayerId }),
  moveClips: (p, a) => moveClips(p, a.moves),
  addNote: (p, a) => addNote(p, a.at, a.text),
  editNote: (p, a) => editNote(p, a.noteId, { text: a.text, at: a.at, done: a.done }),
  deleteNote: (p, a) => deleteNote(p, a.noteId),
});

/** Apply a named op with its args object; unknown names and non-object args are typed errors. */
export function applyOp(project, name, args) {
  if (typeof name !== 'string' || !Object.hasOwn(OPS, name)) return fail(ERR.UNKNOWN_OP, `Unknown op "${String(name).slice(0, 40)}".`);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail(ERR.BAD_ARG, 'args must be an object.');
  return OPS[name](project, args);
}

/** Bounded undo/redo of immutable projects: `push` a new present, `undo`/`redo` move along the stack. At most `limit` (100) undo steps are kept. */
export function createHistory(present, limit = 100) {
  let past = [];
  let future = [];
  let now = present;
  return {
    get present() { return now; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get undoDepth() { return past.length; },
    push(next) {
      past.push(now);
      if (past.length > limit) past = past.slice(past.length - limit);
      future = [];
      now = next;
      return now;
    },
    undo() { if (!past.length) return null; future.push(now); now = past.pop(); return now; },
    redo() { if (!future.length) return null; past.push(now); now = future.pop(); return now; },
    /** Replace the present without keeping history (a project loaded or saved from outside). */
    reset(next) { past = []; future = []; now = next; return now; },
  };
}

