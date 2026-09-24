// The Studio editor's timeline model: one JSON project per video, `<slug>.studio.json` in the workspace.
//
//   { version: 1, fps, width?, height?, name?, rev?, layers: [
//       { id, kind: 'video'|'voice'|'music'|'subtitle', name, muted, locked,
//         clips: [{ id, start, duration, in, src?, text?, gain? }] } ] }
//
// Times are integer milliseconds on the timeline (`start`, `duration`) and in the source file (`in`, the offset the clip
// begins playing from). Media clips (video, voice, music) name a file by a bare workspace file name in `src`; subtitle clips
// carry `text` and no `src`. A project never holds a path: names are [A-Za-z0-9._-] only, and files are looked up inside the
// workspace by `resolveMedia` (realpath containment), never by a client-supplied directory.
//
// Overlap rule (one place, used by validation and by every op): a video layer and a subtitle layer show one clip at a time, so
// their clips may not overlap; voice and music layers are mixed, so their clips may overlap.
import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_VERSION = 1;
export const KINDS = Object.freeze(['video', 'voice', 'music', 'subtitle']);
/** Kinds whose clips may overlap inside one layer (they are mixed). Video and subtitle layers are single-track. */
export const OVERLAP_KINDS = Object.freeze(new Set(['voice', 'music']));
export const MEDIA_KINDS = Object.freeze(new Set(['video', 'voice', 'music']));
export const MAX_TEXT = 500;
export const MAX_MS = 24 * 60 * 60 * 1000;
export const MIN_CLIP_MS = 40;

export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const VIDEO_EXT = Object.freeze(['webm', 'mp4', 'mov', 'mkv']);
export const AUDIO_EXT = Object.freeze(['opus', 'mp3', 'wav', 'ogg', 'm4a', 'flac']);
export const MUSIC_EXT = Object.freeze(['mp3', 'wav', 'ogg', 'm4a', 'opus', 'flac']);

/** Every error code the model, the ops and the routes can answer with. Frozen: a code is a contract. */
export const ERR = Object.freeze({
  // project validation
  BAD_PROJECT: 'BAD_PROJECT', BAD_VERSION: 'BAD_VERSION', BAD_FPS: 'BAD_FPS', BAD_SIZE: 'BAD_SIZE', BAD_NAME: 'BAD_NAME', BAD_REV: 'BAD_REV',
  BAD_LAYERS: 'BAD_LAYERS', BAD_KIND: 'BAD_KIND', BAD_FLAG: 'BAD_FLAG', BAD_CLIPS: 'BAD_CLIPS', BAD_ID: 'BAD_ID', DUP_ID: 'DUP_ID',
  BAD_TIME: 'BAD_TIME', BAD_SRC: 'BAD_SRC', BAD_TEXT: 'BAD_TEXT', BAD_GAIN: 'BAD_GAIN', OVERLAP: 'OVERLAP', UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  // ops
  NO_CLIP: 'NO_CLIP', NO_LAYER: 'NO_LAYER', LOCKED: 'LOCKED', KIND_MISMATCH: 'KIND_MISMATCH', NOT_SUBTITLE: 'NOT_SUBTITLE',
  OUT_OF_CLIP: 'OUT_OF_CLIP', TOO_SHORT: 'TOO_SHORT', BEFORE_SOURCE: 'BEFORE_SOURCE', BAD_ARG: 'BAD_ARG', UNKNOWN_OP: 'UNKNOWN_OP',
  NOTHING_TO_UNDO: 'NOTHING_TO_UNDO', NOTHING_TO_REDO: 'NOTHING_TO_REDO', NO_AUTOSAVE: 'NO_AUTOSAVE', UNSAVED: 'UNSAVED',
  // store and routes
  BAD_SLUG: 'BAD_SLUG', BAD_FILE: 'BAD_FILE', NOT_FOUND: 'NOT_FOUND', EXISTS: 'EXISTS', STALE_REV: 'STALE_REV', REV_REQUIRED: 'REV_REQUIRED',
  NO_SESSION: 'NO_SESSION', CORRUPT: 'CORRUPT', NO_VIDEO: 'NO_VIDEO', NO_DURATION: 'NO_DURATION', CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  BAD_BUNDLE: 'BAD_BUNDLE', BAD_BODY: 'BAD_BODY', TOO_LARGE: 'TOO_LARGE', UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA', FOREIGN_ORIGIN: 'FOREIGN_ORIGIN',
  RENDER_BUSY: 'RENDER_BUSY', NOTHING_TO_RENDER: 'NOTHING_TO_RENDER', RENDER_FAILED: 'RENDER_FAILED', NO_SUCH_JOB: 'NO_SUCH_JOB',
  BAD_RANGE: 'BAD_RANGE', METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
});

/** An error a caller can branch on: `code` is one of ERR, `status` the HTTP status the routes answer with. */
export class EditorError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const isInt = (v) => Number.isSafeInteger(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True for a bare file name: no directory, no `..`, no drive or absolute prefix, only [A-Za-z0-9._-]. */
export const isBareName = (s) => typeof s === 'string' && NAME_RE.test(s) && !s.includes('..');
const MEDIA_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT]);
export const extOf = (name) => path.extname(name).slice(1).toLowerCase();
/** A bare name of a video or audio file (by extension): what a media clip's `src` may be. */
export const isMediaName = (s) => isBareName(s) && MEDIA_EXT.has(extOf(s));

/** A blank project with the four layers a Studio video has. */
export function blankProject({ name = 'Untitled', fps = 30, width = 1280, height = 720 } = {}) {
  return {
    version: PROJECT_VERSION, fps, width, height, name, rev: 1,
    layers: [
      { id: 'video', kind: 'video', name: 'Video', muted: false, locked: false, clips: [] },
      { id: 'voice', kind: 'voice', name: 'Voice', muted: false, locked: false, clips: [] },
      { id: 'music', kind: 'music', name: 'Music', muted: false, locked: false, clips: [] },
      { id: 'subs', kind: 'subtitle', name: 'Subtitles', muted: false, locked: false, clips: [] },
    ],
  };
}

const end = (c) => c.start + c.duration;

/** Overlapping pairs `[a, b]` of clip ids in one layer (empty for a kind that may overlap). */
export function overlaps(layer) {
  if (OVERLAP_KINDS.has(layer.kind)) return [];
  const sorted = [...layer.clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const out = [];
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < end(sorted[i - 1])) out.push([sorted[i - 1].id, sorted[i].id]);
  return out;
}

/** Total length of the project in ms: the end of the last clip on any layer. */
export const projectDuration = (project) => project.layers.reduce((m, l) => l.clips.reduce((n, c) => Math.max(n, end(c)), m), 0);

const LAYER_KEYS = new Set(['id', 'kind', 'name', 'muted', 'locked', 'clips']);
const CLIP_KEYS = new Set(['id', 'start', 'duration', 'in', 'src', 'text', 'gain']);
const PROJECT_KEYS = new Set(['version', 'fps', 'width', 'height', 'name', 'rev', 'layers']);

/**
 * Validate a project. Returns `{ ok: true }` or `{ ok: false, errors: [{ code, path, message }] }` (all problems, in document
 * order). Pure: reads nothing from disk; whether a `src` exists is the render's and the media route's business.
 */
export function validateProject(p) {
  const errors = [];
  const bad = (code, where, message) => errors.push({ code, path: where, message });
  if (!isObj(p)) return { ok: false, errors: [{ code: ERR.BAD_PROJECT, path: '', message: 'A project is a JSON object.' }] };
  for (const k of Object.keys(p)) if (!PROJECT_KEYS.has(k)) bad(ERR.UNKNOWN_FIELD, k, `Unknown project field "${k}".`);
  if (p.version !== PROJECT_VERSION) bad(ERR.BAD_VERSION, 'version', `version must be ${PROJECT_VERSION}.`);
  if (!isInt(p.fps) || p.fps < 1 || p.fps > 120) bad(ERR.BAD_FPS, 'fps', 'fps must be a whole number from 1 to 120.');
  for (const k of ['width', 'height']) if (p[k] !== undefined && (!isInt(p[k]) || p[k] < 16 || p[k] > 7680)) bad(ERR.BAD_SIZE, k, `${k} must be a whole number from 16 to 7680.`);
  if (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 120)) bad(ERR.BAD_NAME, 'name', 'name must be text of at most 120 characters.');
  if (p.rev !== undefined && (!isInt(p.rev) || p.rev < 0)) bad(ERR.BAD_REV, 'rev', 'rev must be a whole number, 0 or more.');
  if (!Array.isArray(p.layers) || p.layers.length > 64) {
    bad(ERR.BAD_LAYERS, 'layers', 'layers must be a list of at most 64 layers.');
    return { ok: false, errors };
  }
  const ids = new Set();
  const claim = (id, where) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return bad(ERR.BAD_ID, where, 'An id is 1-40 characters of A-Z a-z 0-9 _ -.');
    if (ids.has(id)) return bad(ERR.DUP_ID, where, `The id "${id}" is used twice; layer and clip ids are unique in a project.`);
    ids.add(id);
    return undefined;
  };
  let clipCount = 0;
  p.layers.forEach((l, li) => {
    const lp = `layers[${li}]`;
    if (!isObj(l)) return bad(ERR.BAD_LAYERS, lp, 'A layer is a JSON object.');
    for (const k of Object.keys(l)) if (!LAYER_KEYS.has(k)) bad(ERR.UNKNOWN_FIELD, `${lp}.${k}`, `Unknown layer field "${k}".`);
    claim(l.id, `${lp}.id`);
    if (!KINDS.includes(l.kind)) bad(ERR.BAD_KIND, `${lp}.kind`, `kind must be one of ${KINDS.join(', ')}.`);
    if (typeof l.name !== 'string' || l.name.length > 80) bad(ERR.BAD_NAME, `${lp}.name`, 'A layer name is text of at most 80 characters.');
    for (const f of ['muted', 'locked']) if (typeof l[f] !== 'boolean') bad(ERR.BAD_FLAG, `${lp}.${f}`, `${f} must be true or false.`);
    if (!Array.isArray(l.clips)) return bad(ERR.BAD_CLIPS, `${lp}.clips`, 'clips must be a list.');
    l.clips.forEach((c, ci) => {
      const cp = `${lp}.clips[${ci}]`;
      if (++clipCount > 5000) return undefined;
      if (!isObj(c)) return bad(ERR.BAD_CLIPS, cp, 'A clip is a JSON object.');
      for (const k of Object.keys(c)) if (!CLIP_KEYS.has(k)) bad(ERR.UNKNOWN_FIELD, `${cp}.${k}`, `Unknown clip field "${k}".`);
      claim(c.id, `${cp}.id`);
      if (!isInt(c.start) || c.start < 0 || c.start > MAX_MS) bad(ERR.BAD_TIME, `${cp}.start`, 'start must be whole milliseconds, 0 or more.');
      if (!isInt(c.duration) || c.duration < 1 || c.duration > MAX_MS) bad(ERR.BAD_TIME, `${cp}.duration`, 'duration must be whole milliseconds, 1 or more.');
      if (!isInt(c.in) || c.in < 0 || c.in > MAX_MS) bad(ERR.BAD_TIME, `${cp}.in`, 'in must be whole milliseconds, 0 or more (0 for a subtitle).');
      if (l.kind === 'subtitle') {
        if (c.src !== undefined) bad(ERR.BAD_SRC, `${cp}.src`, 'A subtitle clip has text, not a source file.');
        if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > MAX_TEXT) bad(ERR.BAD_TEXT, `${cp}.text`, `A subtitle needs text of 1-${MAX_TEXT} characters.`);
        if (c.in !== 0) bad(ERR.BAD_TIME, `${cp}.in`, 'A subtitle clip has in = 0.');
      } else if (MEDIA_KINDS.has(l.kind)) {
        if (!isMediaName(c.src)) bad(ERR.BAD_SRC, `${cp}.src`, 'src must be the bare name of a video or audio file in the workspace (letters, digits, . _ -), never a path.');
        if (c.text !== undefined) bad(ERR.BAD_TEXT, `${cp}.text`, 'Only a subtitle clip has text.');
      }
      if (c.gain !== undefined && (typeof c.gain !== 'number' || !Number.isFinite(c.gain) || c.gain < 0 || c.gain > 4 || l.kind === 'video' || l.kind === 'subtitle')) bad(ERR.BAD_GAIN, `${cp}.gain`, 'gain is a number from 0 to 4 and only voice and music clips have one.');
      return undefined;
    });
  });
  if (clipCount > 5000) bad(ERR.BAD_CLIPS, 'layers', 'A project holds at most 5000 clips.');
  if (!errors.length) for (const l of p.layers) for (const [a, b] of overlaps(l)) bad(ERR.OVERLAP, `layers.${l.id}`, `Clips ${a} and ${b} overlap on a ${l.kind} layer.`);
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Throws an EditorError(BAD_PROJECT..., 422) carrying `errors` when the project is invalid; returns it otherwise. */
export function assertProject(p) {
  const v = validateProject(p);
  if (!v.ok) throw new EditorError(v.errors[0].code, `${v.errors[0].message} (${v.errors[0].path})`, 422, { errors: v.errors });
  return p;
}

// ---------------------------------------------------------------- files: only ever inside the workspace

/** The folders of a workspace that hold media: the workspace itself and `videos/` (where Studio writes recordings and voice-overs). */
export const MEDIA_DIRS = Object.freeze(['', 'videos']);

/** Resolve a workspace root once (symlinks resolved), so every later containment check compares real paths. */
export function openWorkspace(dir) {
  const real = fs.realpathSync(path.resolve(dir));
  if (!fs.statSync(real).isDirectory()) throw new EditorError(ERR.NOT_FOUND, 'The workspace is not a folder.', 500);
  return real;
}

/** True when `file` (a real path) is a regular file inside `root`. */
export function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The real path of a workspace file by bare name, or null. Looks in the workspace and `videos/` only; a name with a
 * separator, `..`, or that resolves (through a symlink) outside the workspace is refused.
 */
export function resolveMedia(workspace, name, { dirs = MEDIA_DIRS } = {}) {
  if (!isBareName(name)) return null;
  for (const d of dirs) {
    const candidate = path.join(workspace, d, name);
    try {
      const real = fs.realpathSync(candidate);
      if (isInside(workspace, real) && fs.statSync(real).isFile()) return real;
    } catch { /* not in this folder */ }
  }
  return null;
}

/** Media files of the workspace (bare names, sorted), for the "add media" picker. */
export function listMedia(workspace) {
  const names = new Set();
  for (const d of MEDIA_DIRS) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(workspace, d), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isFile() && isBareName(e.name) && MEDIA_EXT.has(extOf(e.name))) names.add(e.name);
  }
  return [...names].sort();
}

// ---------------------------------------------------------------- project from a Studio job

const readingMs = (text) => Math.max(3000, Math.round(text.length * 70));

/**
 * Subtitle clips from a `<slug>.captions.json` script (`[{ id?, text, start, end? }]`, seconds from the video start, the format
 * of the media tools): a missing end is the next start minus 0.1 s, capped at the reading time; an end that would overlap the next
 * line is cut back to it. Lines without text are skipped.
 */
export function subtitleClipsFromCaptions(lines, { firstId = 1 } = {}) {
  if (!Array.isArray(lines)) throw new EditorError(ERR.CORRUPT, 'The captions file must be a JSON array of { text, start }.', 422);
  const rows = lines
    .filter((l) => l && typeof l.text === 'string' && l.text.trim() && Number.isFinite(Number(l.start)) && Number(l.start) >= 0)
    .map((l) => ({ text: l.text.trim().slice(0, MAX_TEXT), start: Math.round(Number(l.start) * 1000), end: l.end === undefined || l.end === null ? undefined : Math.round(Number(l.end) * 1000) }))
    .sort((a, b) => a.start - b.start);
  return rows.map((r, i) => {
    const next = rows[i + 1];
    let e = r.end !== undefined && r.end > r.start ? r.end : Math.min(r.start + readingMs(r.text), next ? next.start - 100 : Infinity);
    if (next) e = Math.min(e, next.start);
    if (e <= r.start) e = r.start + MIN_CLIP_MS;
    return { id: `c${firstId + i}`, start: r.start, duration: e - r.start, in: 0, text: r.text };
  });
}

/**
 * Length in ms of a media file, or null. Tries ffprobe, then the banner of `ffmpeg -i`, then a stream-copy pass to null (a
 * Playwright recording often has no duration in its header). `execFile` is injectable; failures never throw.
 */
export async function probeDurationMs(file, { execFile, ffprobe = process.env.FFPROBE || 'ffprobe', ffmpeg = process.env.FFMPEG || 'ffmpeg' } = {}) {
  const run = (cmd, args) => new Promise((resolve) => {
    try {
      execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => resolve({ e, out: String(stdout || ''), err: String(stderr || '') }));
    } catch (e) { resolve({ e, out: '', err: '' }); }
  });
  const a = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const s = Number.parseFloat(a.out.trim());
  if (Number.isFinite(s) && s > 0) return Math.round(s * 1000);
  const b = await run(ffmpeg, ['-hide_banner', '-i', file]);
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(b.err);
  if (m) { const v = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000; if (v > 0) return Math.round(v); }
  const c = await run(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']);
  const times = [...c.err.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  if (times.length) { const t = times[times.length - 1]; return Math.round((Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3])) * 1000); }
  return null;
}

/**
 * Build a project from a Studio job's outputs, reading only workspace-relative names: `<slug>.webm` (video layer),
 * `<slug>.captions.json` (subtitle layer), `<slug>.voice.opus` (voice) and `<slug>.music.<ext>` (music) when present.
 * Throws EditorError(NO_VIDEO) when the recording is missing and NO_DURATION when its length cannot be found.
 */
export async function projectFromJob(workspace, slug, { execFile, name } = {}) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new EditorError(ERR.BAD_SLUG, 'A job name is letters, digits, . _ - (start with a letter or digit).', 400);
  const videoName = `${slug}.webm`;
  const videoFile = resolveMedia(workspace, videoName);
  if (!videoFile) throw new EditorError(ERR.NO_VIDEO, `No recording ${videoName} in the workspace.`, 404);
  const captionsFile = resolveMedia(workspace, `${slug}.captions.json`);
  let subs = [];
  if (captionsFile) {
    let lines;
    try { lines = JSON.parse(fs.readFileSync(captionsFile, 'utf8')); } catch { throw new EditorError(ERR.CORRUPT, `${slug}.captions.json is not valid JSON.`, 422); }
    subs = subtitleClipsFromCaptions(lines);
  }
  const captionsEnd = subs.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const probe = (f) => probeDurationMs(f, { execFile });
  let videoMs = await probe(videoFile);
  if (!videoMs) videoMs = captionsEnd > 0 ? captionsEnd + 1000 : null;
  if (!videoMs) throw new EditorError(ERR.NO_DURATION, `The length of ${videoName} could not be read (is ffmpeg installed?) and there are no captions to estimate it from.`, 422);
  const project = blankProject({ name: name || slug });
  const layer = (id) => project.layers.find((l) => l.id === id);
  layer('video').clips.push({ id: 'c1', start: 0, duration: videoMs, in: 0, src: videoName });
  let n = 2;
  const voiceName = `${slug}.voice.opus`;
  const voiceFile = resolveMedia(workspace, voiceName);
  if (voiceFile) {
    const ms = (await probe(voiceFile)) || Math.min(videoMs, captionsEnd || videoMs);
    layer('voice').clips.push({ id: `c${n++}`, start: 0, duration: Math.min(ms, videoMs), in: 0, src: voiceName });
  }
  for (const ext of MUSIC_EXT) {
    const musicName = `${slug}.music.${ext}`;
    const musicFile = resolveMedia(workspace, musicName);
    if (!musicFile) continue;
    const ms = (await probe(musicFile)) || videoMs;
    layer('music').clips.push({ id: `c${n++}`, start: 0, duration: Math.min(ms, videoMs), in: 0, src: musicName });
    break;
  }
  layer('subs').clips.push(...subs.map((c, i) => ({ ...c, id: `c${n + i}` })));
  assertProject(project);
  return project;
}
