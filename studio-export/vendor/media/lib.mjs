// Shared, model-free pieces of the media tools: the caption script (data model), subtitles, the clip cache key and the
// write guard. The script is `site/assets/video/<slug>.captions.json`, [{ id, text, start, end? }] in seconds from the
// start of the video, and is meant to be edited by hand or with `node packages/tools/media/script.mjs <slug>`.
// Subtitle text is produced by the `subtitle` package (MIT); ffmpeg does all audio and video work.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringifySync } from 'subtitle';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// STUDIO_ROOT / STUDIO_VIDEO_DIR: set by the packed @line/studio (bin/cli.mjs) to its workspace, so a vendored copy of this
// file never derives a path from its own location outside the package. In the repo they are unset and nothing changes.
export const REPO = process.env.STUDIO_ROOT ? path.resolve(process.env.STUDIO_ROOT) : path.resolve(HERE, '..', '..', '..'); // studio-pack: escape-ok (repo checkout only; STUDIO_ROOT replaces it)
export const VIDEO_DIR = process.env.STUDIO_VIDEO_DIR ? path.resolve(process.env.STUDIO_VIDEO_DIR) : path.join(REPO, 'site', 'assets', 'video');
/** Generated clips, one per (text, voice, model); git-ignored. */
export const CLIP_CACHE = path.join(REPO, '.media-cache');

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MUSIC_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'opus', 'flac'];

/** Reading time for a caption in seconds, the same rule the recording uses (about 14 characters a second, at least 3 s). */
export const readingSeconds = (text) => Math.max(3, text.length * 0.07);

/** Fill ids and ends so every line is complete: id `l01`.. when missing; end = the next start (minus 0.1 s), capped at the
 * reading time; the last line gets its reading time. Never mutates the input; throws on bad input. */
export function normalize(lines) {
  if (!Array.isArray(lines)) throw new Error('the script must be a JSON array of { text, start }');
  const seen = new Set();
  const out = lines.map((l, i) => {
    if (!l || typeof l.text !== 'string' || !l.text.trim()) throw new Error(`line ${i + 1}: text is required`);
    const start = Number(l.start);
    if (!Number.isFinite(start) || start < 0) throw new Error(`line ${i + 1}: start must be seconds >= 0`);
    let id = typeof l.id === 'string' && /^[\w-]{1,40}$/.test(l.id) ? l.id : `l${String(i + 1).padStart(2, '0')}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const end = l.end === undefined || l.end === null || l.end === '' ? undefined : Number(l.end);
    if (end !== undefined && !(end > start)) throw new Error(`line ${i + 1}: end must be after start`);
    // Speech-only fields: say (spoken wording, defaults to text), exaggeration, cfg_weight, pause_ms, temperature.
    const extra = {};
    if (Array.isArray(l.para)) extra.para = l.para.filter((x) => typeof x === 'string');
    if (typeof l.say === 'string' && l.say.trim()) extra.say = l.say.trim();
    for (const k of ['exaggeration', 'cfg_weight', 'pause_ms', 'temperature']) {
      if (l[k] === undefined || l[k] === null || l[k] === '') continue;
      if (!Number.isFinite(Number(l[k]))) throw new Error(`line ${i + 1}: ${k} must be a number`);
      extra[k] = Number(l[k]);
    }
    return { id, text: l.text.trim(), start, ...(end !== undefined ? { end } : {}), ...extra };
  });
  return out.map((l, i) => {
    if (l.end !== undefined) return l;
    const next = out[i + 1];
    const cap = l.start + readingSeconds(l.text);
    return { ...l, end: Math.round((next ? Math.min(cap, next.start - 0.1) : cap) * 1000) / 1000 };
  });
}

/** What is spoken for a line: `say` when given, else `text`. */
export const spoken = (l) => l.say || l.text;

const cues = (lines) => normalize(lines).map((l) => ({ type: 'cue', data: { start: Math.round(l.start * 1000), end: Math.round(l.end * 1000), text: l.text } }));
/** SubRip text for the script. */
export const toSrt = (lines) => stringifySync(cues(lines), { format: 'SRT' });
/** WebVTT text for the script. */
export const toVtt = (lines) => stringifySync(cues(lines), { format: 'WebVTT' });

/** Cache key of one clip: changes when the text, the voice (a stock voice id or a hash of the supplied sample), the model
 * or the speed changes, so only edited lines are generated again. */
export function clipKey({ text, voice, model, speed = 1 }) {
  return crypto.createHash('sha256').update(JSON.stringify([text.trim(), voice, model, speed])).digest('hex').slice(0, 24);
}

/** Fingerprint of a voice sample for the cache key. Only a hash is kept; the sample itself is never copied. */
export const sampleFingerprint = (file) => 'sample:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

/** Throw unless `p` lies inside site/assets/video or the clip cache. Every write goes through this. */
export function assertWritable(p) {
  const abs = path.resolve(p);
  const ok = [VIDEO_DIR, CLIP_CACHE].some((d) => abs === d || abs.startsWith(d + path.sep));
  if (!ok) throw new Error(`refusing to write outside ${VIDEO_DIR} and ${CLIP_CACHE}: ${abs}`);
  return abs;
}

/** Paths of a video's files. */
export function paths(slug, dir = VIDEO_DIR) {
  if (!SLUG_RE.test(slug)) throw new Error(`bad slug "${slug}"`);
  const b = path.join(dir, slug);
  return { script: `${b}.captions.json`, srt: `${b}.en.srt`, vtt: `${b}.en.vtt`, voice: `${b}.voice.opus`, video: `${b}.webm`, voiced: `${b}.voice.webm`, mixed: `${b}.mixed.webm`, musicBase: `${b}.music` };
}

/** The music file the owner dropped next to the video (`<slug>.music.<ext>`), or null. */
export const findMusic = (slug, dir = VIDEO_DIR) => {
  const { musicBase } = paths(slug, dir);
  const ext = MUSIC_EXT.find((e) => fs.existsSync(`${musicBase}.${e}`));
  return ext ? `${musicBase}.${ext}` : null;
};

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** Subtle paralinguistics, proposed deterministically (fixed seed) for lines that have no `para` of their own (an explicit
 * `para`, even `[]`, is kept). A quiet breath before the greeting and before roughly every 3rd-4th long (>= 90 characters)
 * non-technical line, never two lines in a row, and one light chuckle at most, after the greeting or the sign-off. Tokens:
 * `breath_before`, `chuckle_after` (spoken only by a model with tags, Chatterbox-Turbo), `pause_ms:N`. */
export function proposePara(lines, seed = 1) {
  const rnd = mulberry(seed);
  const technical = /[`/]|\b[A-Z]{2,}-\d+\b|\.(tsx?|json)\b/;
  let target = 3 + Math.floor(rnd() * 2), longs = 0, prev = false;
  const chuckleAt = rnd() < 0.5 ? 0 : lines.length - 1;
  return lines.map((l, i) => {
    if (l.para) { prev = l.para.length > 0; return l; }
    const para = [];
    if (i === 0) para.push('breath_before');
    else if (l.text.length >= 90 && !technical.test(l.text) && !prev && ++longs >= target) { para.push('breath_before'); longs = 0; target = 3 + Math.floor(rnd() * 2); }
    if (i === chuckleAt) para.push('chuckle_after');
    prev = para.length > 0;
    return para.length ? { ...l, para } : l;
  });
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
const DELTAS = {
  more_expression: { exaggeration: 0.1, cfg_weight: -0.05 },
  less_expression: { exaggeration: -0.1, cfg_weight: 0.05 },
  slower: { pause_ms: 150, cfg_weight: -0.05 },
  faster: { pause_ms: -100, cfg_weight: 0.05 },
  warmer: { exaggeration: 0.05, temperature: -0.1 },
  clearer: { temperature: -0.1, cfg_weight: 0.05 },
};

/** Turn the owner's feedback ({ lineId: { pick, tags, note } }) into per-line overrides, from a fixed base each time (the picked
 * variant's parameters, else the script defaults), so applying the same feedback twice gives the same script. Returns
 * [{ index, id, set }] for the lines to change. `variants` is the lab manifest's variants; `defaults` the script defaults. */
export function feedbackOverrides(lines, feedback, variants = [], defaults = {}) {
  const out = [];
  lines.forEach((l, index) => {
    const f = feedback[l.id];
    if (!f) return;
    const picked = variants.find((v) => v.id === f.pick);
    const base = { exaggeration: 0.5, cfg_weight: 0.5, temperature: 0.8, pause_ms: 280, ...defaults, ...(picked ? picked.params : {}) };
    const set = {};
    for (const k of ['exaggeration', 'cfg_weight', 'temperature', 'pause_ms']) set[k] = base[k];
    for (const t of f.tags || []) for (const [k, d] of Object.entries(DELTAS[t] || {})) set[k] += d;
    set.exaggeration = clamp(set.exaggeration, 0.25, 1.2);
    set.cfg_weight = clamp(set.cfg_weight, 0.1, 0.9);
    set.temperature = clamp(set.temperature, 0.3, 1.2);
    set.pause_ms = clamp(set.pause_ms, 100, 900);
    out.push({ index, id: l.id, set });
  });
  return out;
}
