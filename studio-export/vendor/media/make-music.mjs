#!/usr/bin/env node
// A gentle instrumental bed, generated with ffmpeg only: no tracks, no downloads, no licence to worry about.
//
//   node packages/tools/media/make-music.mjs <slug> [--key 1] [--seconds 150] [--out site/assets/video/<slug>.music.opus]
//
// Four sine-partial chords (root, third, fifth, octave, each with a slightly detuned twin) in a slow diatonic progression
// picked from --key (an integer; the same key always gives the same music), cross-faded, looped to --seconds, then softened
// with a low-pass, a slow tremolo, chorus and a short echo that stands in for reverb. 48 kHz stereo Opus, about 0.75 MB for
// 2.5 minutes, levelled to -12 LUFS so that the mix levels (script.mjs mix: -14 dB over cards, -28 dB bed) are relative to a loud bed. Try other keys for other moods, then `script.mjs <slug> mix`. Needs ffmpeg (or FFMPEG=/path/to/ffmpeg).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { VIDEO_DIR, assertWritable } from './lib.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const slug = args[0];
if (!slug || slug.startsWith('--')) { console.error('usage: make-music.mjs <slug> [--key 1] [--seconds 150] [--out file]'); process.exit(2); }
const key = Number(flag('--key', 1));
const seconds = Number(flag('--seconds', 150));
const out = assertWritable(flag('--out', path.join(VIDEO_DIR, `${slug}.music.opus`)));

// Deterministic choices from the key.
const rand = ((a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; })(key * 2654435761);
const ROOTS = [48, 50, 52, 53, 55, 57]; // C3 .. A3 as the tonic
const tonic = ROOTS[Math.floor(rand() * ROOTS.length)];
const PROGRESSIONS = [[0, 5, 3, 4], [0, 3, 5, 4], [0, 4, 5, 3], [5, 3, 0, 4]]; // scale degrees of a major scale
const prog = PROGRESSIONS[Math.floor(rand() * PROGRESSIONS.length)];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const degree = (d) => tonic + MAJOR[d % 7] + 12 * Math.floor(d / 7);
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

const CHORD = 10, FADE = 2.5;
const inputs = []; const filters = [];
prog.forEach((d, c) => {
  const notes = [degree(d), degree(d + 2), degree(d + 4), degree(d) + 12];
  const labels = [];
  notes.forEach((m, n) => {
    for (const detune of [0, 0.35]) {
      const i = inputs.length / 4;
      inputs.push('-f', 'lavfi', '-i', `sine=frequency=${(hz(m) + detune).toFixed(3)}:sample_rate=48000:duration=${CHORD}`);
      filters.push(`[${i}:a]volume=${n === 0 ? 0.32 : 0.2}[s${i}]`);
      labels.push(`[s${i}]`);
    }
  });
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0[c${c}]`);
});
let acc = 'c0';
for (let c = 1; c < prog.length; c++) { filters.push(`[${acc}][c${c}]acrossfade=d=${FADE}:c1=tri:c2=tri[x${c}]`); acc = `x${c}`; }
const loopLen = prog.length * CHORD - (prog.length - 1) * FADE;
const loops = Math.ceil(seconds / loopLen);
filters.push(`[${acc}]aloop=loop=${loops - 1}:size=${Math.round(loopLen * 48000)},atrim=0:${seconds},asetpts=N/SR/TB,`
  + `lowpass=f=1500,tremolo=f=0.12:d=0.3,chorus=0.6:0.9:55|70:0.4|0.32:0.25|0.4:2|1.3,aecho=0.8:0.88:70|130:0.35|0.25,`
  + `loudnorm=I=-12:TP=-1.5:LRA=7,afade=t=in:d=1.5,afade=t=out:st=${seconds - 1.5}:d=1.5[m]`);
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[m]', '-ac', '2', '-c:a', 'libopus', '-b:a', '40k', out]);
console.log(`wrote ${out} (key ${key}, tonic MIDI ${tonic}, degrees ${prog.join('-')}, ${seconds} s)`);
