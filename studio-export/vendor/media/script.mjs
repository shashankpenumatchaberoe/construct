#!/usr/bin/env node
// The narration script of a video, as plain files you can edit with any text editor, and the tracks built from it.
//
//   node packages/tools/media/script.mjs <slug> build           # srt + vtt + voice + muxed variants (whatever the files allow)
//   node packages/tools/media/script.mjs <slug> srt|vtt         # site/assets/video/<slug>.en.srt / .en.vtt   (no model)
//   node packages/tools/media/script.mjs <slug> voice           # <slug>.voice.opus, the narration alone (+ <slug>.voice.webm if the video exists)
//   node packages/tools/media/script.mjs <slug> mix             # <slug>.mixed.webm: video + narration + <slug>.music.<ext>, music ducked under speech
//   node packages/tools/media/script.mjs <slug> status          # which lines are cached, which would be generated, where paralinguistics land
//   node packages/tools/media/script.mjs <slug> timing          # measure each line's narration and write `dur` (seconds) into the script; the recording holds each caption for dur + 0.9 s
//   node packages/tools/media/script.mjs <slug> apply-feedback  # owner feedback (--feedback ~/voice/voice-feedback.json) -> per-line overrides
//
// Voice: --voice af_heart (Kokoro, default) | --voice-sample <wav of your own voice> (Chatterbox clone; more flags below)
//   --exaggeration 0.5 --cfg-weight 0.5 --temperature 0.8 --pause-ms 280 --seed 1   expressiveness of the clone
//   --ref best | --ref-start S --ref-end E    reference window of the sample (best = the most expressive clean 10-20 s)
//   --model turbo                             Chatterbox-Turbo (MIT), understands [chuckle] and similar tags
//   --tts-cmd "my-tts --in {text_file} --out {out} --ref {voice_ref}"   plug in another voice model (contract in docs/MEDIA.md); also `ttsCmd` in <slug>.voice.json
//   --tempo 0.9                               slow the speech down (ffmpeg atempo, keeps the pitch); 0.9 is 10% slower. Applied at mix time, so no re-speaking
//   --no-para                                 no proposed breaths / chuckle (explicit `para` in the script still applies)
//   --music-volume / --music-start / --card-db -14 / --bed-db -28   for `mix`
// Defaults for a video can also live in <slug>.voice.json ({ "exaggeration": 0.6, "cfg_weight": 0.35, ... }); flags win.
//
// Source of truth: site/assets/video/<slug>.captions.json, [{ id, text, say?, start, end?, exaggeration?, cfg_weight?, pause_ms?,
// para? }], seconds from the video start; edit it by hand. `say` is what is spoken (defaults to `text`, which is what the subtitles
// show), so wording can be made speakable (contractions, commas) without changing them. `para`: ["breath_before", "chuckle_after",
// "pause_ms:350"]. Separate tracks stay separate files: <slug>.voice.opus, <slug>.music.<mp3|wav|ogg|m4a|opus|flac> (music you
// supply, or generate with make-music.mjs), <slug>.en.srt/.vtt. Generated clips are cached per line in .media-cache/ (git-ignored)
// by a hash of spoken text + voice + reference + model + every parameter, so only edited lines are spoken again. Writes stay inside
// site/assets/video and .media-cache. Needs ffmpeg (or FFMPEG=/path/to/ffmpeg).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VIDEO_DIR, assertWritable, feedbackOverrides, findMusic, normalize, paths, proposePara, toSrt, toVtt } from './lib.mjs';
import { addAudio, breathSnippet, mixVoice, mixWithMusic, plan, resolveRef, synthesize } from './synth.mjs';

const args = process.argv.slice(2);
const OPTS_WITH_VALUE = ['--tts-cmd', '--tempo', '--voice', '--voice-sample', '--speed', '--music-volume', '--music-start', '--exaggeration', '--cfg-weight', '--temperature', '--pause-ms', '--seed', '--ref', '--ref-start', '--ref-end', '--model', '--feedback', '--card-db', '--bed-db'];
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [slug, cmd = 'build'] = args.filter((a, i) => !a.startsWith('--') && !OPTS_WITH_VALUE.includes(args[i - 1]));
const fail = (m) => { console.error(m); process.exit(1); };
const COMMANDS = ['timing', 'build', 'srt', 'vtt', 'voice', 'mix', 'status', 'apply-feedback'];
if (!slug || !COMMANDS.includes(cmd)) fail(`usage: script.mjs <slug> ${COMMANDS.join('|')}  (see the header of this file)`);

try {
  const P = paths(slug);
  if (!fs.existsSync(P.script)) fail(`no script at ${P.script}`);
  const raw = JSON.parse(fs.readFileSync(P.script, 'utf8'));
  const fileDefaults = fs.existsSync(`${P.script.replace('.captions.json', '')}.voice.json`) ? JSON.parse(fs.readFileSync(`${P.script.replace('.captions.json', '')}.voice.json`, 'utf8')) : {};
  const num = (n, k) => (flag(n) !== undefined ? Number(flag(n)) : fileDefaults[k]);
  const opts = {
    voice: flag('--voice', 'af_heart'), sample: flag('--voice-sample'), speed: Number(flag('--speed', 0.95)),
    exaggeration: num('--exaggeration', 'exaggeration'), cfgWeight: num('--cfg-weight', 'cfg_weight'), temperature: num('--temperature', 'temperature'),
    ttsCmd: flag('--tts-cmd', fileDefaults.ttsCmd), tempo: num('--tempo', 'tempo') ?? 1, pauseMs: num('--pause-ms', 'pause_ms'), seed: num('--seed', 'seed'), model: flag('--model', fileDefaults.model),
    ref: flag('--ref', fileDefaults.ref), refStart: num('--ref-start', 'ref_start'), refEnd: num('--ref-end', 'ref_end'),
  };
  const write = (file, text) => { fs.writeFileSync(assertWritable(file), text); console.log(`wrote ${file}`); };
  const scriptLines = () => (args.includes('--no-para') ? normalize(raw) : proposePara(normalize(raw), opts.seed ?? 1));

  if (cmd === 'apply-feedback') {
    const fbFile = flag('--feedback', path.join(os.homedir(), 'voice', 'voice-feedback.json'));
    if (!fs.existsSync(fbFile)) fail(`no feedback file at ${fbFile}`);
    const feedback = JSON.parse(fs.readFileSync(fbFile, 'utf8'));
    const manifestFile = path.join(VIDEO_DIR, 'voice-tests', 'manifest.json');
    const variants = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')).variants || [] : [];
    const defaults = { exaggeration: opts.exaggeration, cfg_weight: opts.cfgWeight, temperature: opts.temperature, pause_ms: opts.pauseMs };
    for (const k of Object.keys(defaults)) if (defaults[k] === undefined) delete defaults[k];
    const changes = feedbackOverrides(normalize(raw), feedback, variants, defaults);
    for (const c of changes) Object.assign(raw[c.index], c.set);
    write(P.script, JSON.stringify(raw, null, 2) + '\n');
    console.log(`${changes.length} line(s) updated: ${changes.map((c) => c.id).join(', ') || 'none'}. Run "build" to re-speak only the changed lines.`);
    process.exit(0);
  }

  const lines = scriptLines();
  const doSubs = (which) => {
    if (which !== 'vtt') write(P.srt, toSrt(lines));
    if (which !== 'srt') write(P.vtt, toVtt(lines));
  };
  const doVoice = async () => {
    const o = { ...opts, ref: opts.sample ? resolveRef(opts.sample, opts) : undefined };
    const clips = (await synthesize(lines, o, (m) => console.log(m))).map((c) => ({ ...c, seconds: c.seconds / opts.tempo }));
    clips.forEach((c, i) => {
      const next = clips[i + 1];
      if (next && c.start + c.seconds > next.start) console.warn(`warning: "${c.text.slice(0, 40)}" runs ${(c.start + c.seconds - next.start).toFixed(1)} s into the next line; move the next start later or shorten the text`);
    });
    const breath = opts.sample && !args.includes('--no-para') ? breathSnippet(opts.sample) : null;
    const placed = mixVoice(clips, P.voice, { breath, tempo: opts.tempo });
    const asked = clips.filter((c) => (c.para || []).includes('breath_before')).map((c) => c.id);
    console.log(`wrote ${P.voice} (${clips.length} lines, ${clips.filter((c) => !c.cached).length} generated, ${clips.filter((c) => c.cached).length} from cache; ${placed} breath(s)${asked.length ? ` before ${asked.join(', ')}` : ''}${asked.length && !breath ? ' (skipped: no snippet)' : ''})`);
    if (fs.existsSync(P.video)) addAudio(P.video, [`${P.voice}@0:1:0.05`], P.voiced);
  };
  const doMix = () => {
    const music = findMusic(slug);
    if (!music) fail(`no music file: make one with "node packages/tools/media/make-music.mjs ${slug}" or drop your own as ${VIDEO_DIR}/${slug}.music.<mp3|wav|ogg|m4a|opus|flac>`);
    if (!fs.existsSync(P.voice)) fail(`no narration yet: run "script.mjs ${slug} voice" first`);
    if (!fs.existsSync(P.video)) fail(`no video at ${P.video}`);
    const a = mixWithMusic({
      video: P.video, voice: P.voice, music, out: P.mixed, musicStart: Number(flag('--music-start', 0)),
      introEnd: lines[1] ? lines[1].start : 0, outroStart: lines[lines.length - 1].start,
      cardDb: Number(flag('--card-db', -14)), bedDb: Number(flag('--bed-db', flag('--music-volume', -28))),
    });
    console.log(`wrote ${P.mixed}\nffmpeg ${a.map((x) => (/[\s;'()|]/.test(x) ? `'${x}'` : x)).join(' ')}`);
  };

  if (cmd === 'timing') {
    const o = { ...opts, ref: opts.sample ? resolveRef(opts.sample, opts) : undefined };
    const clips = await synthesize(lines, o, (m) => console.log(m));
    clips.forEach((c, i) => { raw[i].dur = Math.round((c.seconds / opts.tempo) * 100) / 100; });
    write(P.script, JSON.stringify(raw, null, 2) + '\n');
    const words = lines.reduce((n, l) => n + (l.say || l.text).split(/\s+/).length, 0);
    const total = clips.reduce((n, c) => n + c.seconds / opts.tempo, 0);
    console.log(`${clips.length} lines, ${words} words, ${total.toFixed(0)} s of speech, ${(words / (total / 60)).toFixed(0)} words per minute`);
  } else if (cmd === 'srt' || cmd === 'vtt') doSubs(cmd);
  else if (cmd === 'status') {
    for (const l of plan(lines, { ...opts, ref: opts.sample ? resolveRef(opts.sample, opts) : undefined })) console.log(`${l.cached ? 'cached ' : 'missing'}  ${String(l.start).padStart(7)} s  ${(l.para || []).join(',').padEnd(28)} ${l.text.slice(0, 50)}`);
  } else if (cmd === 'voice') await doVoice();
  else if (cmd === 'mix') doMix();
  else { doSubs(); await doVoice(); if (findMusic(slug)) doMix(); }
} catch (e) {
  fail(e.message);
}
