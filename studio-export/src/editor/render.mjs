// Render a Studio project with ffmpeg, exactly as the timeline shows it.
//
// buildRenderPlan(project, opts) is pure and deterministic: it returns `{ args, outputs, subtitleFiles, durationMs }`, where `args`
// is an argument ARRAY for execFile (never a shell string). Every file it names is a bare workspace name (validated by
// validateProject), so the plan carries no client path; renderProject runs it with `cwd` = the workspace.
//
// Picture: a black canvas the length of the project, each video clip trimmed (`-ss in -t duration`), moved to its timeline start
// and overlaid; gaps stay black. A layer listed first is on top. Sound: voice clips are delayed and mixed; the voice tracks Studio
// makes are already levelled to -20 LUFS by the media tools (synth.mjs), and gain 1 leaves that level untouched (a per-clip
// loudnorm would re-level a trimmed slice and undo the user's gain). Music clips are delayed, faded and set to the bed level, then
// ducked by the voice with the same sidechain compressor script.mjs `mix` uses. A muted layer is left out completely.
// Subtitles: the subtitle layer is exported as `<slug>.srt` and `<slug>.vtt` (the `subtitle` package, as the media tools do) and
// muxed as a soft track; only `burnSubtitles: true` draws them into the picture (needs an ffmpeg with libass).
import fs from 'node:fs';
import path from 'node:path';
import { stringifySync } from 'subtitle';
import { EditorError, ERR, SLUG_RE, assertProject, isBareName, isInside, openWorkspace, resolveMedia } from './project.mjs';
import { slugify } from './store.mjs';

/** Voice level Studio's narration is made at (media tools: loudnorm I=-20). */
export const VOICE_LUFS = -20;
/** Music bed level in dB under the narration, the default of `script.mjs mix` (--bed-db). */
export const MUSIC_BED_DB = -28;
export const MUSIC_FADE_MS = 1500;
const DUCK = 'sidechaincompress=threshold=0.02:ratio=6:attack=30:release=500:makeup=1';

const sec = (ms) => (ms / 1000).toFixed(3);
const num = (v) => String(Math.round(v * 10000) / 10000);
/** Linear gain a music clip plays at: its own `gain`, else the bed level. */
export const musicGain = (clip) => (clip.gain !== undefined ? clip.gain : Math.round(10 ** (MUSIC_BED_DB / 20) * 10000) / 10000);
export const voiceGain = (clip) => (clip.gain !== undefined ? clip.gain : 1);

/** `{ srt, vtt }` text of the (unmuted) subtitle layers, or null when there is nothing to show. */
export function exportSubtitles(project) {
  const clips = project.layers.filter((l) => l.kind === 'subtitle' && !l.muted).flatMap((l) => l.clips).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  if (!clips.length) return null;
  const cues = clips.map((c) => ({ type: 'cue', data: { start: c.start, end: c.start + c.duration, text: c.text } }));
  return { srt: stringifySync(cues, { format: 'SRT' }), vtt: stringifySync(cues, { format: 'WebVTT' }) };
}

/**
 * The ffmpeg run for a project. `slug` names the outputs (`<slug>.export.webm`, `<slug>.srt`, `<slug>.vtt`); `locate(name)` maps a
 * media name to the path ffmpeg opens relative to the workspace (default: the name itself); `burnSubtitles` draws the subtitles
 * into the picture instead of adding a soft track.
 */
export function buildRenderPlan(project, { slug, burnSubtitles = false, locate = (n) => n } = {}) {
  assertProject(project);
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new EditorError(ERR.BAD_SLUG, 'A render needs a project name of letters, digits, . _ -.', 400);
  const live = project.layers.filter((l) => !l.muted);
  const of = (kind) => live.filter((l) => l.kind === kind).flatMap((l) => l.clips.map((c) => ({ ...c, layer: l.id })));
  const videos = [];
  // A layer listed first is on top, so overlay the last layer first.
  for (const l of [...live].reverse()) if (l.kind === 'video') videos.push(...[...l.clips].sort((a, b) => a.start - b.start));
  const voices = of('voice').sort((a, b) => a.start - b.start);
  const musics = of('music').sort((a, b) => a.start - b.start);
  const mediaEnd = [...videos, ...voices, ...musics].reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  if (mediaEnd <= 0) throw new EditorError(ERR.NOTHING_TO_RENDER, 'There is no unmuted video or audio to render.', 422);
  const durationMs = mediaEnd;
  const W = project.width || 1280;
  const H = project.height || 720;
  const subs = exportSubtitles(project);

  const inputs = [];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
  const input = (c) => { args.push('-ss', sec(c.in), '-t', sec(c.duration), '-i', locate(c.src)); inputs.push(c.src); return inputs.length - 1; };
  const graph = [`color=c=black:s=${W}x${H}:r=${project.fps}:d=${sec(durationMs)}[b0]`];
  videos.forEach((c, k) => {
    const i = input(c);
    graph.push(`[${i}:v]setpts=PTS-STARTPTS+${sec(c.start)}/TB,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${project.fps},format=yuv420p[v${k}]`);
    graph.push(`[b${k}][v${k}]overlay=eof_action=pass[b${k + 1}]`);
  });
  const last = `b${videos.length}`;
  const subInputName = subs ? `${slug}.vtt` : null;
  const softSubs = subs && !burnSubtitles;
  graph.push(subs && burnSubtitles ? `[${last}]subtitles=${slug}.srt[vout]` : `[${last}]null[vout]`);

  const bus = (clips, tag, gainOf, fade) => clips.map((c, k) => {
    const i = input(c);
    const f = fade ? Math.min(MUSIC_FADE_MS, Math.floor(c.duration / 2)) : 0;
    const chain = [`[${i}:a]asetpts=PTS-STARTPTS`];
    if (f > 0) chain.push(`afade=t=in:st=0:d=${sec(f)}`, `afade=t=out:st=${sec(c.duration - f)}:d=${sec(f)}`);
    chain.push(`adelay=${c.start}:all=1`, `volume=${num(gainOf(c))}[${tag}${k}]`);
    graph.push(chain.join(','));
    return `[${tag}${k}]`;
  });
  const mix = (labels, out) => graph.push(labels.length === 1 ? `${labels[0]}anull[${out}]` : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[${out}]`);
  const hasAudio = voices.length + musics.length > 0;
  if (voices.length) mix(bus(voices, 'vc', voiceGain, false), 'voice');
  if (musics.length) mix(bus(musics, 'mc', musicGain, true), 'mus');
  if (voices.length && musics.length) {
    graph.push(`[voice]apad=whole_dur=${sec(durationMs)},asplit=2[vsc][vmix]`, `[mus][vsc]${DUCK}[duck]`, '[vmix][duck]amix=inputs=2:normalize=0:duration=longest[aout]');
  } else if (voices.length) graph.push('[voice]anull[aout]');
  else if (musics.length) graph.push('[mus]anull[aout]');

  if (softSubs) { args.push('-i', subInputName); inputs.push(subInputName); }
  const outName = `${slug}.export.webm`;
  const tmpName = `${slug}.export.tmp.webm`;
  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (hasAudio) args.push('-map', '[aout]');
  if (softSubs) args.push('-map', `${inputs.length - 1}:0`);
  args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p');
  if (hasAudio) args.push('-c:a', 'libopus', '-b:a', '96k', '-ac', '2'); else args.push('-an');
  if (softSubs) args.push('-c:s', 'webvtt', '-metadata:s:s:0', 'language=eng');
  args.push('-t', sec(durationMs), tmpName);

  const subtitleFiles = subs ? [{ kind: 'srt', name: `${slug}.srt`, text: subs.srt }, { kind: 'vtt', name: `${slug}.vtt`, text: subs.vtt }] : [];
  return {
    slug, durationMs, args, inputs, burnSubtitles: Boolean(subs && burnSubtitles),
    tempName: tmpName,
    outputs: [{ kind: 'video', name: outName }, ...subtitleFiles.map((f) => ({ kind: f.kind, name: f.name }))],
    subtitleFiles,
  };
}

/** Write `text` to a workspace file by bare name: a temp file, then a rename, so a link at the target is replaced, never followed. */
function writeAtomic(workspace, name, data) {
  if (!isBareName(name)) throw new EditorError(ERR.BAD_FILE, 'Refusing an output name that is not a bare file name.', 400);
  const target = path.join(workspace, name);
  const tmp = path.join(workspace, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, { flag: 'w' });
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Render a project into the workspace. `execFile` is `child_process.execFile` (injected in tests); `onEvent` receives
 * `{ type: 'start' | 'progress' | 'done' | 'error', ... }`. Writes only inside the workspace (its real path), never outside; the
 * input files are looked up by bare name in the workspace and its `videos/` folder. `slug` names the outputs (default: the
 * project's name made file-safe). Resolves with `{ outputs, plan }`.
 */
export async function renderProject({ project, workspace, slug = slugify(project?.name), execFile, onEvent = () => {}, burnSubtitles = false, ffmpeg = process.env.FFMPEG || 'ffmpeg' }) {
  const emit = (e) => { try { onEvent(e); } catch { /* a listener must not break a render */ } };
  try {
    const root = openWorkspace(workspace);
    assertProject(project);
    const rel = new Map();
    const locate = (name) => {
      if (!rel.has(name)) {
        const real = resolveMedia(root, name);
        if (!real || !isInside(root, real)) throw new EditorError(ERR.NOT_FOUND, `The file ${name} is not in the workspace.`, 422);
        rel.set(name, path.relative(root, real));
      }
      return rel.get(name);
    };
    for (const l of project.layers) for (const c of l.clips) if (c.src && !l.muted) locate(c.src);
    const plan = buildRenderPlan(project, { slug, burnSubtitles, locate });
    emit({ type: 'start', durationMs: plan.durationMs, outputs: plan.outputs.map((o) => o.name) });
    for (const f of plan.subtitleFiles) writeAtomic(root, f.name, f.text);
    const tmp = path.join(root, plan.tempName);
    fs.rmSync(tmp, { force: true });
    await new Promise((resolve, reject) => {
      let stderr = '';
      const child = execFile(ffmpeg, plan.args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (error, _out, err) => {
        stderr = String(err || '');
        if (error) reject(new EditorError(ERR.RENDER_FAILED, `ffmpeg failed: ${(stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`, 500));
        else resolve();
      });
      let buf = '';
      child?.stdout?.on?.('data', (chunk) => {
        buf += String(chunk);
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) { const ms = Math.round(Number(m[1]) / 1000); emit({ type: 'progress', pct: Math.max(0, Math.min(99, Math.round((ms / plan.durationMs) * 100))), ms }); }
        }
      });
    });
    if (!fs.existsSync(tmp)) throw new EditorError(ERR.RENDER_FAILED, 'ffmpeg finished but wrote no file.', 500);
    fs.renameSync(tmp, path.join(root, plan.outputs[0].name));
    const outputs = plan.outputs.map((o) => o.name);
    emit({ type: 'done', pct: 100, outputs });
    return { outputs, plan };
  } catch (e) {
    const error = e instanceof EditorError ? e : new EditorError(ERR.RENDER_FAILED, String(e?.message || e), 500);
    emit({ type: 'error', code: error.code, message: error.message });
    throw error;
  }
}

