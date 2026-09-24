#!/usr/bin/env node
// Voice-over from a caption timeline, spoken locally (no cloud). For a video with a script under site/assets/video, prefer
// `node packages/tools/media/script.mjs <slug> build` (also writes subtitles); this is the same engine for an arbitrary file.
//
//   node packages/tools/media/voiceover.mjs site/assets/video/01-ticket-to-story.captions.json \
//        [--voice af_heart] [--speed 0.95] [--out site/assets/video/01-ticket-to-story.voice.opus] \
//        [--video site/assets/video/01-ticket-to-story.webm] [--voice-sample ~/voice/sample.wav]
//   node packages/tools/media/voiceover.mjs --list-voices
//
// The captions file is a JSON array of { "text": "...", "start": <seconds from the video start> } (see script.mjs).
// Default voice: Kokoro af_heart (Apache-2.0, CPU, offline once cached; setup: docs/MEDIA.md). With --video, also writes
// <video>.voice.webm through add-audio.sh. --voice-sample <wav>: speak in the voice of a recording its speaker supplied of
// their own voice (Chatterbox, MIT code and weights, CPU, about 5 GB RAM, roughly 7 s of compute per second of speech; run
// nothing else heavy meanwhile). The sample is only read; nothing derived from it is written. Kokoro stays the default
// and the fallback. Clips are cached per line in .media-cache (git-ignored). The narration is synthetic: say so on the page.
// Never imitate a real person's voice; a clone is only ever made from a sample its speaker supplies of their own voice (#462).
import fs from 'node:fs';
import { normalize } from './lib.mjs';
import { addAudio, kokoroVoices, mixVoice, overruns, synthesize } from './synth.mjs';

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const fail = (msg) => { console.error(msg); process.exit(1); };
try {
  if (args.includes('--list-voices')) {
    for (const [id, v] of Object.entries(await kokoroVoices())) console.log(`${id.padEnd(12)} ${v.gender.padEnd(7)} ${v.language.padEnd(6)} ${v.name}`);
    process.exit(0);
  }
  const file = args.find((a) => a.endsWith('.json'));
  if (!file || !fs.existsSync(file)) fail('give a captions file (JSON array of {text, start}); see the header of this script.');
  const lines = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  const out = flag('--out', file.replace(/\.captions\.json$|\.json$/, '.voice.opus'));
  const clips = await synthesize(lines, { voice: flag('--voice', 'af_heart'), sample: flag('--voice-sample'), speed: Number(flag('--speed', 0.95)) }, console.log);
  for (const c of clips) console.log(`${String(c.start).padStart(6)} s  ${c.seconds.toFixed(1)} s  ${c.cached ? 'cached' : 'new   '}  ${c.text.slice(0, 50)}`);
  for (const c of overruns(clips)) console.warn(`warning: "${c.text.slice(0, 40)}" runs into the next caption`);
  mixVoice(clips, out);
  console.log(`wrote ${out} (${clips.length} clips)`);
  const video = flag('--video');
  if (video) addAudio(video, [`${out}@0:1:0.05`], video.replace(/\.webm$/, '.voice.webm'));
} catch (e) {
  fail(e.message);
}
