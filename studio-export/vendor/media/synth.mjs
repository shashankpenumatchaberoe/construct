// Text to speech for the caption script, with a per-line clip cache (only edited lines are generated again), and the
// mix of the clips into one narration track. Two backends: Kokoro (default, Apache-2.0, node) and, with a voice sample its
// speaker supplied, Chatterbox (MIT, Python venv; packages/tools/media/clone_voice.py). Everything runs locally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLIP_CACHE, assertWritable, clipKey, sampleFingerprint, spoken } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_CACHE = process.env.CONSTRUCT_MEDIA_CACHE || path.join(os.homedir(), '.cache', 'construct-media');
export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const KOKORO_MODEL = 'kokoro-82m-v1.0-q8';
const CLONE_MODEL = 'chatterbox-0.1.7+v2'; // v2: sentence chunks, trimmed, levelled to -20 LUFS

async function loadKokoro() {
  try {
    const req = createRequire(path.join(MEDIA_CACHE, 'noop.js'));
    const kokoro = await import(pathToFileURL(req.resolve('kokoro-js')).href);
    return await kokoro.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  } catch {
    throw new Error(`kokoro-js is not installed in ${MEDIA_CACHE}.\n  mkdir -p ${MEDIA_CACHE} && cd ${MEDIA_CACHE} && npm init -y && npm i kokoro-js`);
  }
}

/** The Kokoro stock voices: { id: { gender, language, name } }. */
export const kokoroVoices = async () => (await loadKokoro()).voices;

const sidecar = (key) => path.join(CLIP_CACHE, `${key}.json`);
export const clipFile = (key) => path.join(CLIP_CACHE, `${key}.wav`);

/** The reference audio for the cloned voice: the whole sample, the best 10-20 s window (`ref: 'best'`) or a chosen window
 * (`refStart`/`refEnd`, seconds). Excerpts are written outside the repo (MEDIA_CACHE/ref), never inside it. */
export function resolveRef(sample, { ref, refStart, refEnd } = {}) {
  if (!sample || (!ref && refStart === undefined)) return sample;
  if (ref && ref !== 'best') return ref; // an already resolved excerpt
  const py = process.env.CONSTRUCT_MEDIA_PYTHON || path.join(MEDIA_CACHE, 'venv', 'bin', 'python');
  const a = [path.join(HERE, 'pick_reference.py'), sample, '--out-dir', path.join(MEDIA_CACHE, 'ref')];
  if (refStart !== undefined) a.push('--start', String(refStart), '--end', String(refEnd));
  else a.push('--top', '1');
  const out = execFileSync(py, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out.slice(out.indexOf('{')));
  return j.path || j.top[0].path;
}

/** Parameters of the cloned voice for one line: the line's own values over the script defaults over the model defaults. */
export const cloneParams = (l, o = {}) => ({
  exaggeration: l.exaggeration ?? o.exaggeration ?? 0.5,
  cfg_weight: l.cfg_weight ?? o.cfgWeight ?? 0.5,
  temperature: l.temperature ?? o.temperature ?? 0.8,
  pause_ms: Number((l.para || []).find((t) => t.startsWith('pause_ms:'))?.slice(9)) || (l.pause_ms ?? o.pauseMs ?? 280),
  seed: o.seed ?? 1,
  ...(o.model && o.model !== 'std' ? { model: o.model } : {}), // only when not the default, so existing cache keys stay valid
});

/** The text sent to the voice: the spoken wording, plus a [chuckle] tag when the line asks for one and the model has tags (Turbo). */
export const said = (l, o = {}) => (o.model === 'turbo' && (l.para || []).some((t) => /^(chuckle|soft_laugh)_after$/.test(t)) ? `${spoken(l)} [chuckle]` : spoken(l));

/** Which cache key each line would use, and whether its clip exists. `sample` selects the cloned voice (`ref` is the
 * resolved reference file, defaulting to the sample). The key covers the spoken text, the reference, the model and every
 * parameter, so changing any of them regenerates exactly the lines it affects. */
export function plan(lines, { voice = 'af_heart', sample, ref, speed = 0.95, ttsCmd, ...rest } = {}) {
  if (ttsCmd) { // a plug-in backend: the command string is part of the key (a new model means new clips)
    const voiceId = sample ? sampleFingerprint(ref || sample) : 'none';
    return lines.map((l) => {
      const key = clipKey({ text: spoken(l), voice: voiceId, model: `cmd:${ttsCmd}`, speed: cloneParams(l, rest) });
      return { ...l, key, cached: fs.existsSync(clipFile(key)) && fs.existsSync(sidecar(key)) };
    });
  }
  const voiceId = sample ? sampleFingerprint(ref || sample) : voice;
  const model = sample ? CLONE_MODEL : KOKORO_MODEL;
  return lines.map((l) => {
    const key = clipKey({ text: said(l, rest), voice: voiceId, model: sample && rest.model === 'turbo' ? 'chatterbox-turbo+v2' : model, speed: sample ? cloneParams(l, rest) : speed });
    return { ...l, key, cached: fs.existsSync(clipFile(key)) && fs.existsSync(sidecar(key)) };
  });
}

/** Generate the clips that are not cached yet (one model process, one line at a time) and return every line with its
 * clip file and length in seconds. `log(line)` reports each generated line. */
export async function synthesize(lines, opts = {}, log = () => {}) {
  const { voice = 'af_heart', sample, speed = 0.95 } = opts;
  const ref = sample ? resolveRef(sample, opts) : undefined;
  const planned = plan(lines, { ...opts, ref });
  const todo = planned.filter((l) => !l.cached);
  fs.mkdirSync(assertWritable(CLIP_CACHE), { recursive: true });
  if (todo.length && opts.ttsCmd) {
    // Plug-in backend contract (docs/MEDIA.md): the command gets {text_file} (UTF-8 text), {out} (write a wav or ogg there),
    // {voice_ref} (the sample or reference excerpt, when given); exit 0 on success. We then trim and level every clip like the built-ins.
    for (const l of todo) {
      const txt = assertWritable(path.join(CLIP_CACHE, `${l.key}.txt`)), raw = assertWritable(path.join(CLIP_CACHE, `${l.key}.raw.wav`));
      fs.writeFileSync(txt, spoken(l));
      const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
      const cmd = opts.ttsCmd.replaceAll('{text_file}', q(txt)).replaceAll('{out}', q(raw)).replaceAll('{voice_ref}', q(ref || sample || ''));
      execFileSync('sh', ['-c', cmd], { stdio: ['ignore', 'inherit', 'inherit'] });
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,loudnorm=I=-20:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', assertWritable(clipFile(l.key))]);
      fs.rmSync(txt, { force: true }); fs.rmSync(raw, { force: true });
      const seconds = duration(clipFile(l.key));
      fs.writeFileSync(sidecar(l.key), JSON.stringify({ seconds }));
      log(`generated ${seconds.toFixed(1)} s (tts-cmd): ${spoken(l).slice(0, 50)}`);
    }
  } else if (todo.length && sample) {
    if (!fs.existsSync(sample)) throw new Error(`no such sample: ${sample}`);
    const py = process.env.CONSTRUCT_MEDIA_PYTHON || path.join(MEDIA_CACHE, 'venv', 'bin', 'python');
    if (!fs.existsSync(py)) throw new Error(`voice-cloning venv not found at ${py}; see docs/MEDIA.md (Voice cloning).`);
    const job = assertWritable(path.join(CLIP_CACHE, `job-${process.pid}.json`));
    fs.writeFileSync(job, JSON.stringify(todo.map((l) => ({ text: said(l, opts), file: l.key, ...cloneParams(l, opts) }))));
    try {
      // Streamed, so `log` (and any progress display) sees each clip as soon as it is done.
      await new Promise((resolve, reject) => {
        const child = spawn(py, [path.join(HERE, 'clone_voice.py'), ref, job, CLIP_CACHE], { stdio: ['ignore', 'pipe', 'inherit'] });
        readline.createInterface({ input: child.stdout }).on('line', (x) => {
          if (!x.startsWith('{')) return;
          const row = JSON.parse(x);
          fs.writeFileSync(sidecar(todo[row.i].key), JSON.stringify({ seconds: row.seconds }));
          log(`generated ${row.seconds.toFixed(1)} s in ${row.compute} s: ${spoken(todo[row.i]).slice(0, 50)}`, { key: todo[row.i].key, row });
        });
        child.on('error', reject);
        child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`clone_voice.py exited ${c}`))));
      });
    } finally {
      fs.rmSync(job, { force: true });
    }
  } else if (todo.length) {
    const tts = await loadKokoro();
    if (!tts.voices[voice]) throw new Error(`unknown voice "${voice}"; run: node packages/tools/media/voiceover.mjs --list-voices`);
    for (const l of todo) {
      const clip = await tts.generate(spoken(l), { voice, speed });
      await clip.save(assertWritable(clipFile(l.key)));
      const seconds = clip.audio.length / clip.sampling_rate;
      fs.writeFileSync(sidecar(l.key), JSON.stringify({ seconds }));
      log(`generated ${seconds.toFixed(1)} s: ${spoken(l).slice(0, 50)}`);
    }
  }
  return planned.map((l) => ({ ...l, wav: clipFile(l.key), seconds: JSON.parse(fs.readFileSync(sidecar(l.key), 'utf8')).seconds }));
}

/** Lines whose clip is longer than the room before the next line starts (or its own end). */
export const overruns = (clips) => clips.filter((c, i) => {
  const next = clips[i + 1];
  return next && c.start + c.seconds > next.start;
});

/** The breath snippet cut from the speaker's own sample (outside the repo), or null when the sample has none. */
export function breathSnippet(sample) {
  const py = process.env.CONSTRUCT_MEDIA_PYTHON || path.join(MEDIA_CACHE, 'venv', 'bin', 'python');
  try {
    const out = execFileSync(py, [path.join(HERE, 'extract_breath.py'), sample, '--out-dir', path.join(MEDIA_CACHE, 'para')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.slice(out.indexOf('{'))).path;
  } catch { return null; }
}

/** Mix the clips, each delayed to its start, into one opus file (ffmpeg). A line with `breath_before` gets `breath` (a wav,
 * about 220 ms) laid just before it at -22 dB with 30 ms fades; without a snippet the tag is skipped. */
export function mixVoice(clips, out, { breath, tempo = 1 } = {}) {
  assertWritable(out);
  const inputs = clips.flatMap((c) => ['-i', c.wav]);
  const stretch = tempo === 1 ? '' : `atempo=${tempo},`; // ffmpeg atempo: pitch-preserving; 0.9 = 10% slower
  const filters = clips.map((c, i) => `[${i}:a]${stretch}adelay=${Math.round(c.start * 1000)}:all=1[a${i}]`);
  const labels = clips.map((_, i) => `[a${i}]`);
  let n = clips.length;
  if (breath) {
    for (const c of clips.filter((x) => (x.para || []).includes('breath_before'))) {
      inputs.push('-i', breath);
      filters.push(`[${n}:a]afade=t=in:d=0.03,afade=t=out:st=0.19:d=0.03,volume=-22dB,adelay=${Math.max(0, Math.round((c.start - 0.28) * 1000))}:all=1[b${n}]`);
      labels.push(`[b${n}]`);
      n++;
    }
  }
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[mix]`);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[mix]', '-c:a', 'libopus', '-b:a', '64k', out]);
  return n - clips.length; // breaths placed
}

/** Video + narration + music into one file (video copied). The music sits at `cardDb` (default -14 dB) while a card is on
 * screen (before `introEnd` and after `outroStart`) and at `bedDb` (-28 dB) otherwise, ramping over 1.5 s, and is ducked
 * further under the voice with sidechaincompress. 1.5 s fade in and out. Returns the ffmpeg arguments used. */
export function mixWithMusic({ video, voice, music, out, introEnd, outroStart, cardDb = -14, bedDb = -28, musicStart = 0 }) {
  assertWritable(out);
  const dur = duration(video);
  const R = 1.5;
  const env = `${bedDb}+${cardDb - bedDb}*(clip((${introEnd + R / 2}-t)/${R},0,1)+clip((t-${outroStart - R / 2})/${R},0,1))`;
  const filter = [
    '[1:a]asplit=2[vsc][vmix]',
    `[2:a]atrim=0:${dur},asetpts=PTS-STARTPTS,adelay=${Math.round(musicStart * 1000)}:all=1,volume='pow(10,(${env})/20)':eval=frame,afade=t=in:d=${R},afade=t=out:st=${Math.max(0, dur - R)}:d=${R}[mus]`,
    '[mus][vsc]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=500:makeup=1[duck]',
    `[vmix][duck]amix=inputs=2:normalize=0:duration=longest,atrim=0:${dur}[mix]`,
  ].join(';');
  const a = ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', voice, '-stream_loop', '-1', '-i', music, '-filter_complex', filter,
    '-map', '0:v', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '64k', '-t', String(dur), out];
  execFileSync(FFMPEG, a);
  return a;
}

/** Length of a media file in seconds (from ffmpeg's banner, no ffprobe needed). */
export function duration(file) {
  let banner = '';
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }); } catch (e) { banner = String(e.stderr); }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(banner);
  if (!m) throw new Error(`could not read the length of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Mux audio tracks into a video with add-audio.sh (video stream copied). Each track is "FILE@SECONDS:VOLUME:FADE". */
export function addAudio(video, tracks, out) {
  assertWritable(out);
  execFileSync(path.join(HERE, 'add-audio.sh'), [video, ...tracks.flatMap((t) => ['--track', t]), '--out', out], { stdio: 'inherit', env: { ...process.env, AUDIO_BITRATE: process.env.AUDIO_BITRATE || '48k' } });
}
