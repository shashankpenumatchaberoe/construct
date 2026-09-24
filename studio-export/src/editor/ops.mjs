// Pure, immutable editing operations on a Studio project (see project.mjs for the model). Every op takes a project and returns
// `{ ok: true, project, ...extra }` with a NEW project (the input is never touched) or `{ ok: false, code, message }` with a code
// from ERR. Nothing here reads a file or a clock; ids are minted deterministically (`c<n>`, one above the highest in the project).
//
// Rules shared by all ops: a locked layer refuses every edit to its clips (`LOCKED`; setLayerFlag itself is how you unlock);
// clips never overlap inside a video or a subtitle layer (`OVERLAP`) but may on voice and music layers, which are mixed; a clip
// keeps `MIN_CLIP_MS` at least; times are whole milliseconds.
import { ERR, MAX_MS, MAX_TEXT, MEDIA_KINDS, MIN_CLIP_MS, isMediaName, overlaps } from './project.mjs';

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

/** Copy the project, run `mutate(copy)` (returns an error result or nothing), keep clips sorted by start, and check overlaps in the touched layers. */
function edit(project, touchedLayerIds, mutate) {
  const next = clone(project);
  const err = mutate(next);
  if (err) return err;
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
    if (texts) { c.text = texts[0]; right.text = texts[1]; } else right.in = c.in + (atMs - c.start);
    layer.clips.push(right);
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
    if (MEDIA_KINDS.has(f.layer.kind) && c.in + (toMs - c.start) < 0) return fail(ERR.BEFORE_SOURCE, 'The clip already starts at the beginning of its source.');
  } else if (toMs - c.start < MIN_CLIP_MS) return fail(ERR.TOO_SHORT, `A clip keeps at least ${MIN_CLIP_MS} ms.`);
  return edit(project, () => [f.layer.id], (p) => {
    const t = p.layers.find((l) => l.id === f.layer.id).clips.find((x) => x.id === clipId);
    if (edge === 'start') {
      const delta = toMs - t.start;
      if (MEDIA_KINDS.has(f.layer.kind)) t.in += delta;
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

/** Mute or lock a layer. Works on a locked layer (that is how it is unlocked). */
export function setLayerFlag(project, layerId, flag, value) {
  if (flag !== 'muted' && flag !== 'locked') return fail(ERR.BAD_ARG, 'flag must be "muted" or "locked".');
  if (typeof value !== 'boolean') return fail(ERR.BAD_ARG, 'value must be true or false.');
  if (!project.layers.some((l) => l.id === layerId)) return fail(ERR.NO_LAYER, `No layer "${layerId}".`);
  return edit(project, () => [], (p) => { p.layers.find((l) => l.id === layerId)[flag] = value; return undefined; });
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

