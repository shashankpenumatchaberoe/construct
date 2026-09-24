// The pipeline: record -> captions -> voice-over -> mix. Each stage is optional, each emits events, and every output lives
// inside the workspace (checked with realpath before anything is written or read). Stages after `record` run the media
// tools (packages/tools/media, found by resolve.mjs) as child processes with the workspace as their root (STUDIO_ROOT) and video folder (STUDIO_VIDEO_DIR); none of them is a model call. A stage that cannot run is skipped with a reason, not faked.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { recordStoryboard, SLUG_RE } from './recorder.mjs';
import { findFfmpeg, mediaCache, mediaDir } from './resolve.mjs';

export const OUTPUTS = 'videos'; // <workspace>/videos, the STUDIO_VIDEO_DIR the package's bin sets
export const CLIP_CACHE_DIR = '.media-cache'; // where the vendored media tools keep clips when STUDIO_ROOT is the workspace
const MUSIC_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'opus', 'flac'];
const TOOL_TIMEOUT_MS = 30 * 60 * 1000;

export class ContainmentError extends Error {
  constructor(message) { super(message); this.name = 'ContainmentError'; this.code = 'PATH_OUTSIDE_WORKSPACE'; }
}

/**
 * Resolve `target` and throw unless it lies inside `root`, following symlinks: a target that does not exist yet is judged by
 * its deepest existing ancestor, and a dangling symlink is refused. Returns the real absolute path.
 */
export function assertInside(root, target) {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(target);
  let probe = abs;
  const rest = [];
  for (;;) {
    try { probe = fs.realpathSync(probe); break; } catch (e) {
      if (e.code !== 'ENOENT') throw new ContainmentError(`cannot resolve ${path.basename(abs)}: ${e.code}`);
      let dangling = false;
      try { fs.lstatSync(probe); dangling = true; } catch { /* really missing */ }
      if (dangling) throw new ContainmentError(`${path.basename(probe)} is a dangling link; refusing to use it`);
      const up = path.dirname(probe);
      if (up === probe) throw new ContainmentError(`${path.basename(abs)} has no existing parent`);
      rest.unshift(path.basename(probe));
      probe = up;
    }
  }
  const real = path.join(probe, ...rest);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new ContainmentError(`${path.basename(abs)} is outside the workspace`);
  return real;
}

/** Whether the configured voice can run here, and if not, why (checked without running anything). */
export function voiceAvailability(config, { env = process.env, tools = mediaDir() } = {}) {
  if (!tools) return { available: false, reason: 'the media tools were not found (vendor/media or packages/tools/media)' };
  if (!findFfmpeg(env)) return { available: false, reason: 'ffmpeg was not found (install it, or set FFMPEG=/path/to/ffmpeg)' };
  const tts = config?.tts || {};
  if (tts.backend === 'cmd') return tts.ttsCmd ? { available: true } : { available: false, reason: 'tts.backend is "cmd" but tts.ttsCmd is empty' };
  if (tts.backend === 'chatterbox') {
    if (!tts.voiceSample || !fs.existsSync(tts.voiceSample)) return { available: false, reason: 'Chatterbox needs tts.voiceSample (a recording of your own voice) in studio.config.json' };
    const py = env.CONSTRUCT_MEDIA_PYTHON || path.join(mediaCache(env), 'venv', 'bin', 'python');
    return fs.existsSync(py) ? { available: true } : { available: false, reason: `the Chatterbox environment was not found at ${py} (see docs/MEDIA.md, Voice cloning)` };
  }
  const kokoro = path.join(mediaCache(env), 'node_modules', 'kokoro-js', 'package.json');
  return fs.existsSync(kokoro) ? { available: true } : { available: false, reason: `kokoro-js is not installed in ${mediaCache(env)} (mkdir -p there, npm init -y, npm i kokoro-js)` };
}

function runTool(script, args, { env, cwd, signal, timeoutMs = TOOL_TIMEOUT_MS, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const take = (b) => { const s = b.toString('utf8'); tail = (tail + s).slice(-4000); if (onLine) for (const l of s.split('\n')) if (l.trim()) onLine(l.trim().slice(0, 300)); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      code === 0 ? resolve(tail) : reject(new Error(`${path.basename(script)} ${args.slice(0, 2).join(' ')} exited ${code}: ${tail.trim().split('\n').slice(-2).join(' | ')}`));
    });
  });
}

/**
 * Run the pipeline for one storyboard.
 *   { storyboard, workspace, config, playwright, onEvent, stages, slug, signal, deps }
 * stages: { record, captions, voice, mix } booleans, all true by default. record:false reuses `slug`'s existing files.
 * deps: { runTool, mediaDir, voiceAvailability } are injectable for tests.
 * Returns { ok, slug, files: { video, captions, srt, vtt, voice, voiced, mixed }, final, stages: { name: { status, reason? } } };
 * file values are bare file names inside <workspace>/videos.
 */
export async function runPipeline({ storyboard, workspace, config, playwright, onEvent = () => {}, stages = {}, slug, signal, deps = {} }) {
  const want = { record: true, captions: true, voice: true, mix: true, ...stages };
  const emit = (stage, type, data = {}) => { try { onEvent({ stage, type, ...data }); } catch { /* observers must not break the run */ } };
  const outDir = path.join(fs.realpathSync(workspace), OUTPUTS);
  fs.mkdirSync(outDir, { recursive: true });
  assertInside(workspace, outDir);
  const cacheDir = path.join(fs.realpathSync(workspace), CLIP_CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });
  assertInside(workspace, cacheDir);
  if (slug !== undefined && !SLUG_RE.test(slug)) throw new Error(`bad slug "${slug}"`);
  slug = slug || `video-${Date.now().toString(36)}`;
  const inOut = (name) => assertInside(workspace, path.join(outDir, name));
  const run = deps.runTool || runTool;
  const tools = deps.mediaDir === undefined ? mediaDir() : deps.mediaDir;
  const result = { ok: false, slug, files: {}, final: null, stages: {} };
  const setStage = (name, status, reason) => { result.stages[name] = { status, ...(reason ? { reason } : {}) }; };
  const skip = (name, reason) => { setStage(name, 'skipped', reason); emit(name, 'skipped', { reason }); };
  const exists = (name) => fs.existsSync(inOut(name));

  // record -------------------------------------------------------------------------------------------------------------
  if (want.record) {
    const r = await recordStoryboard({ storyboard, outDir, config, playwright, onEvent, slug, signal });
    if (r.video) result.files.video = path.basename(r.video);
    if (r.captions) result.files.captions = path.basename(r.captions);
    fs.writeFileSync(inOut(`${slug}.storyboard.json`), JSON.stringify(storyboard, null, 2) + '\n');
    if (!r.ok) { setStage('record', 'failed', r.error.message); result.error = r.error; return finish(result, inOut); }
    setStage('record', 'done');
  } else {
    if (!exists(`${slug}.webm`) || !exists(`${slug}.captions.json`)) { setStage('record', 'failed', 'nothing recorded for this slug yet'); return finish(result, inOut); }
    result.files.video = `${slug}.webm`;
    result.files.captions = `${slug}.captions.json`;
    skip('record', 'not requested; using the existing recording');
  }

  const script = tools ? path.join(tools, 'script.mjs') : null;
  const env = { ...process.env, STUDIO_ROOT: fs.realpathSync(workspace), STUDIO_VIDEO_DIR: outDir };
  const tool = (cmd, extra = []) => run(script, [slug, cmd, ...extra], { env, cwd: outDir, signal, onLine: (l) => emit(cmd, 'log', { line: l }) });

  // captions -----------------------------------------------------------------------------------------------------------
  if (!want.captions) skip('captions', 'not requested');
  else if (!script) skip('captions', 'the media tools were not found');
  else {
    emit('captions', 'start');
    try {
      await tool('srt');
      await tool('vtt');
      result.files.srt = `${slug}.en.srt`;
      result.files.vtt = `${slug}.en.vtt`;
      setStage('captions', 'done');
      emit('captions', 'done', { files: [result.files.srt, result.files.vtt] });
    } catch (e) { setStage('captions', 'failed', e.message); emit('captions', 'error', { message: e.message }); }
  }

  // voice-over ---------------------------------------------------------------------------------------------------------
  if (!want.voice) skip('voice', 'not requested');
  else {
    const avail = (deps.voiceAvailability || voiceAvailability)(config, { tools });
    if (!avail.available) skip('voice', avail.reason);
    else {
      emit('voice', 'start', { backend: config.tts.backend });
      const t = config.tts;
      const extra = t.backend === 'cmd' ? ['--tts-cmd', t.ttsCmd] : t.backend === 'chatterbox' ? ['--voice-sample', t.voiceSample] : ['--voice', t.voice];
      try {
        await tool('voice', extra);
        result.files.voice = `${slug}.voice.opus`;
        if (exists(`${slug}.voice.webm`)) result.files.voiced = `${slug}.voice.webm`;
        setStage('voice', 'done');
        emit('voice', 'done', { files: [result.files.voice, result.files.voiced].filter(Boolean) });
      } catch (e) { setStage('voice', 'failed', e.message); emit('voice', 'error', { message: e.message }); }
    }
  }

  // mix ----------------------------------------------------------------------------------------------------------------
  // The voice step already muxes the narration into <slug>.voice.webm; this step adds music the user dropped next to the
  // video (<slug>.music.<ext>) and settles which file is the result. Nothing generates or downloads music.
  if (!want.mix) skip('mix', 'not requested');
  else if (!result.files.voiced) skip('mix', 'there is no narration to mix');
  else {
    const music = MUSIC_EXT.find((e) => exists(`${slug}.music.${e}`));
    if (!music) skip('mix', 'no music file next to the video; the narrated video is the result');
    else if (!script) skip('mix', 'the media tools were not found');
    else {
      emit('mix', 'start');
      try {
        await tool('mix');
        result.files.mixed = `${slug}.mixed.webm`;
        setStage('mix', 'done');
        emit('mix', 'done', { files: [result.files.mixed] });
      } catch (e) { setStage('mix', 'failed', e.message); emit('mix', 'error', { message: e.message }); }
    }
  }
  return finish(result, inOut);
}

function finish(result, inOut) {
  const f = result.files;
  const present = (name) => name && fs.existsSync(inOut(name));
  result.final = [f.mixed, f.voiced, f.video].find(present) || null;
  result.ok = result.stages.record?.status !== 'failed' && Boolean(result.final);
  return result;
}
