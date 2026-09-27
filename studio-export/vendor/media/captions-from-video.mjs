#!/usr/bin/env node
// Rebuild a caption timeline from an already recorded take, without re-recording (deterministic, no model).
//
//   node packages/tools/media/captions-from-video.mjs site/assets/video/01-ticket-to-story.webm \
//        ui/e2e/tests/media/01-ticket-to-story.spec.js [--out <slug>.captions.json] [--fps 10]
//
// The recording burns each caption into a dark bar at the bottom of the frame. This decodes the video (ffmpeg, gray,
// half size), finds the moments the white text in that bar changes, and pairs them in order with the captions the spec
// says (`CAPTIONS.<key>` in call order, plus the intro and outro cards). It refuses to write if the counts differ.
// New recordings write the same file themselves (support.mjs writeTimeline); this is for takes made before that.
// Needs ffmpeg (or FFMPEG=/path/to/ffmpeg).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [video, specFile] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!video || !specFile) { console.error('usage: captions-from-video.mjs <video.webm> <spec.js> [--out file] [--fps 10]'); process.exit(2); }
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FPS = Number(flag('--fps', 10));
const W = 640, H = 360;
const out = flag('--out', video.replace(/\.webm$/, '.captions.json'));

// Texts in the order the spec shows them.
const src = fs.readFileSync(specFile, 'utf8');
const obj = src.match(/export const CAPTIONS = (\{[\s\S]*?\n\});/);
if (!obj) { console.error('no `export const CAPTIONS = {...}` in the spec'); process.exit(1); }
const TEXT = new Function(`return ${obj[1]}`)();
const body = src.slice(src.indexOf("test('"));
const order = [];
for (const m of body.matchAll(/CAPTIONS\.(\w+)/g)) if (!order.includes(m[1]) || /^added/.test(m[1])) order.push(m[1]);
const texts = [];
for (const k of order) {
  if (k === 'introTitle' || k === 'outroTitle') texts.push({ card: true, id: k.replace('Title', ''), text: k === 'introTitle' && TEXT.greeting ? TEXT.greeting : k === 'outroTitle' && TEXT.signOff ? TEXT.signOff : `${TEXT[k]}. ${TEXT[k.replace('Title', 'Sub')]}` });
  else if (k.endsWith('Sub') || k === 'greeting' || k === 'signOff') continue;
  else texts.push({ card: false, id: k, text: TEXT[k] });
}
const captionsOnly = texts.filter((t) => !t.card);

// White text pixels in the bottom bar region, per frame, as a set of packed indices.
const X0 = 60, X1 = 580, Y0 = 285, Y1 = 348;
const frames = [];
await new Promise((resolve, reject) => {
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `fps=${FPS},scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= W * H) {
      const f = buf.subarray(0, W * H); buf = buf.subarray(W * H);
      // Caption text: bright pixels with a dark one within 3 px on the same row (white on the bar; a white page behind
      // has no dark neighbours, so full-screen scenes do not confuse it).
      const set = new Set();
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
        if (f[y * W + x] <= 225) continue;
        const r = y * W + x;
        if (f[r - 3] < 60 || f[r + 3] < 60 || f[r - 2] < 60 || f[r + 2] < 60) set.add(r);
      }
      frames.push({ set, bar: set.size > 120 });
    }
  });
  ff.on('error', reject);
  ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`))));
});

const jaccard = (a, b) => { let i = 0; for (const p of a) if (b.has(p)) i++; return 1 - i / (a.size + b.size - i || 1); };
const starts = [];
let prev = null, lastBar = 0;
for (const [i, f] of frames.entries()) {
  if (f.bar) lastBar = (i + 1) / FPS;
  if (f.bar && (!prev || jaccard(prev.set, f.set) > 0.6)) starts.push(i / FPS);
  if (f.bar) prev = f; else prev = null;
}
console.log(`${frames.length} frames, ${starts.length} caption starts found, ${captionsOnly.length} captions in the spec`);
if (starts.length !== captionsOnly.length) { console.error('counts differ; not writing. Starts at (s): ' + starts.map((s) => s.toFixed(1)).join(' ')); process.exit(1); }

// Cards: the intro card holds 7.5 s (5 s x the default pace) right before the first caption; the outro starts when the
// last caption bar goes away.
const result = [];
let ci = 0;
for (const t of texts) {
  if (t.card) result.push({ id: t.id, text: t.text, start: result.length === 0 ? Math.max(0.3, starts[0] - 7.5) : lastBar });
  else result.push({ id: t.id, text: t.text, start: starts[ci++] });
}
fs.writeFileSync(out, JSON.stringify(result.map((r) => ({ id: r.id, text: r.text, start: Math.round(r.start * 100) / 100 })), null, 2) + '\n');
console.log(`wrote ${out} (${result.length} entries)`);
