#!/usr/bin/env node
// Voice lab: speak a few representative lines of a script with several settings of the cloned voice, score each variant
// objectively and write small .ogg files plus a manifest to compare them. No listening is needed to rank them.
//
//   node packages/tools/media/voice-lab.mjs <slug> --voice-sample ~/voice/sample.wav [--lines intro,signIn,...] [--variants file.json] [--score-only]
//
// Output, all inside site/assets/video/voice-tests/: <variantId>--<lineId>.ogg (Opus in Ogg, 24 kbps) and manifest.json:
//   { lines:[{id,text,say}], variants:[{id,label,params:{exaggeration,cfg_weight,temperature,ref},scores:{similarity,wer,f0std}}],
//     files:{variantId:{lineId:path}}, reference:{f0std}, progress:{done,total,current,updated} }
// `progress` is rewritten after every clip so a viewer can show it. Scores come from packages/tools/media/eval_voice.py: speaker
// similarity to the real sample (Resemblyzer cosine), word error rate (faster-whisper) and pitch spread in semitones (F0 std).
// Clips share the per-line cache with script.mjs (same key = same parameters), so a variant that wins is already cached.
// Lines use their spoken wording (`say`) without per-line overrides, so variants differ only in the settings under test.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIP_CACHE, VIDEO_DIR, assertWritable, normalize, paths, proposePara, spoken } from './lib.mjs';
import { FFMPEG, MEDIA_CACHE, breathSnippet, clipFile, plan, resolveRef, synthesize } from './synth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const slug = args[0];
const fail = (m) => { console.error(m); process.exit(1); };
if (!slug || slug.startsWith('--')) fail('usage: voice-lab.mjs <slug> --voice-sample <wav> [--lines a,b] [--variants file.json] [--score-only]');
const sample = flag('--voice-sample');
if (!sample || !fs.existsSync(sample)) fail('give --voice-sample <your own voice recording>');

const DIR = path.join(VIDEO_DIR, 'voice-tests');
const MANIFEST = path.join(DIR, 'manifest.json');
const LINE_IDS = (flag('--lines', 'intro,signIn,impact,fillCheck,validate,outro')).split(',');
const VARIANTS = flag('--variants') ? JSON.parse(fs.readFileSync(flag('--variants'), 'utf8')) : [
  { id: 'default', label: 'Defaults (exaggeration 0.5, cfg 0.5), whole sample', params: { exaggeration: 0.5, cfg_weight: 0.5, temperature: 0.8, ref: 'full' } },
  { id: 'expressive', label: 'More expressive (0.7, cfg 0.3), whole sample', params: { exaggeration: 0.7, cfg_weight: 0.3, temperature: 0.8, ref: 'full' } },
  { id: 'best-ref', label: 'Defaults, best 10-20 s reference window', params: { exaggeration: 0.5, cfg_weight: 0.5, temperature: 0.8, ref: 'best' } },
  { id: 'expressive-best-ref', label: 'More expressive (0.7, cfg 0.3), best reference window', params: { exaggeration: 0.7, cfg_weight: 0.3, temperature: 0.8, ref: 'best' } },
];

const all = normalize(JSON.parse(fs.readFileSync(paths(slug).script, 'utf8')));
const lines = LINE_IDS.map((id) => all.find((l) => l.id === id) || fail(`no line "${id}" in the script`))
  .map((l) => ({ id: l.id, text: l.text, say: spoken(l), start: l.start }));

fs.mkdirSync(assertWritable(DIR), { recursive: true });
const manifest = fs.existsSync(MANIFEST) && (args.includes('--score-only') || args.includes('--add')) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { lines: lines.map(({ id, text, say }) => ({ id, text, say })), variants: [], files: {}, reference: {}, progress: {} };
const total = (args.includes('--score-only') ? 0 : VARIANTS.length * lines.length) + 1;
let done = 0;
const save = (current) => {
  manifest.progress = { done, total, current, updated: new Date().toISOString() };
  fs.writeFileSync(assertWritable(MANIFEST), JSON.stringify(manifest, null, 1) + '\n');
};
const ogg = (wav, out) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', assertWritable(out)]);
const py = process.env.CONSTRUCT_MEDIA_PYTHON || path.join(MEDIA_CACHE, 'venv', 'bin', 'python');
const clipsOf = {};

if (!args.includes('--score-only')) {
  save('starting');
  manifest.lines = lines.map(({ id, text, say }) => ({ id, text, say }));
  for (const v of VARIANTS) {
    const refPath = resolveRef(sample, { ref: v.params.ref === 'best' ? 'best' : undefined });
    const opts = { sample, ref: refPath, exaggeration: v.params.exaggeration, cfgWeight: v.params.cfg_weight, temperature: v.params.temperature, model: v.params.model };
    const p = plan(lines, opts);
    done += p.filter((l) => l.cached).length; // cached clips count as done
    const clips = await synthesize(lines, opts, (m) => { done++; save(`${v.id}: ${m.replace(/^generated /, '')}`); });
    clipsOf[v.id] = clips;
    manifest.files[v.id] = {};
    for (const c of clips) { const rel = `voice-tests/${v.id}--${c.id}.ogg`; ogg(c.wav, path.join(VIDEO_DIR, rel)); manifest.files[v.id][c.id] = rel; }
    const label = v.params.ref === 'best' ? `${v.label}` : v.label;
    manifest.variants = manifest.variants.filter((x) => x.id !== v.id).concat({ id: v.id, label, params: { ...v.params, ref_file: path.basename(refPath) }, scores: {} });
    save(`${v.id}: done`);
  }
} else {
  for (const v of manifest.variants.filter((x) => x.id !== 'para')) {
    const refPath = resolveRef(sample, { ref: v.params.ref === 'best' ? 'best' : undefined });
    clipsOf[v.id] = plan(lines, { sample, ref: refPath, exaggeration: v.params.exaggeration, cfgWeight: v.params.cfg_weight, temperature: v.params.temperature, model: v.params.model }).map((l) => ({ ...l, wav: clipFile(l.key) }));
  }
}

// Paralinguistics A/B: the same clips as --para-of <variantId>, with the proposed breath laid before the lines that get one.
if (flag('--para-of')) {
  const base = manifest.variants.find((x) => x.id === flag('--para-of')) || fail('unknown --para-of variant');
  const refPath = resolveRef(sample, { ref: base.params.ref === 'best' ? 'best' : undefined });
  const breath = breathSnippet(sample);
  const placed = proposePara(normalize(JSON.parse(fs.readFileSync(paths(slug).script, 'utf8'))), 1);
  const clips = plan(lines, { sample, ref: refPath, exaggeration: base.params.exaggeration, cfgWeight: base.params.cfg_weight, temperature: base.params.temperature, model: base.params.model });
  manifest.files.para = {};
  const marked = [];
  for (const c of clips) {
    const rel = `voice-tests/para--${c.id}.ogg`;
    const withBreath = breath && (placed.find((l) => l.id === c.id)?.para || []).includes('breath_before');
    if (withBreath) {
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', clipFile(c.key), '-i', breath, '-filter_complex', '[0:a]adelay=300:all=1[a];[1:a]afade=t=in:d=0.03,afade=t=out:st=0.19:d=0.03,volume=-22dB[b];[a][b]amix=inputs=2:normalize=0:duration=longest', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', assertWritable(path.join(VIDEO_DIR, rel))]);
      marked.push(c.id);
    } else ogg(clipFile(c.key), path.join(VIDEO_DIR, rel));
    manifest.files.para[c.id] = rel;
  }
  manifest.variants = manifest.variants.filter((x) => x.id !== 'para').concat({ id: 'para', label: `${base.label}, plus a quiet breath before ${marked.join(', ') || 'no line'} (from your own sample)`, params: { ...base.params, para: marked }, scores: { ...base.scores } });
}

save('scoring');
const items = Object.entries(clipsOf).flatMap(([vid, clips]) => clips.map((c) => ({ id: `${vid}|${c.id}`, wav: c.wav, text: c.say })));
const itemsFile = assertWritable(path.join(CLIP_CACHE, 'lab-items.json'));
fs.mkdirSync(path.dirname(itemsFile), { recursive: true });
fs.writeFileSync(itemsFile, JSON.stringify(items));
const res = JSON.parse(execFileSync(py, [path.join(HERE, 'eval_voice.py'), sample, itemsFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).split('\n').filter((x) => x.startsWith('{')).pop());
fs.rmSync(itemsFile, { force: true });
manifest.reference = res.reference;
manifest.perLine = {};
for (const v of manifest.variants.filter((x) => x.id !== 'para')) {
  const rows = res.items.filter((r) => r.id.startsWith(`${v.id}|`));
  if (!rows.length) continue;
  const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  const errors = rows.reduce((s, r) => s + r.wer_errors, 0), words = rows.reduce((s, r) => s + r.wer_words, 0);
  v.scores = { similarity: Math.round(mean('similarity') * 1000) / 1000, wer: Math.round((errors / words) * 1000) / 1000, f0std: Math.round(mean('f0std') * 100) / 100 };
  manifest.perLine[v.id] = Object.fromEntries(rows.map((r) => [r.id.split('|')[1], { similarity: r.similarity, wer_errors: r.wer_errors, wer_words: r.wer_words, f0std: r.f0std }]));
}
done = total;
save('finished');
for (const v of manifest.variants) console.log(`${v.id.padEnd(22)} similarity ${v.scores.similarity}  WER ${(v.scores.wer * 100).toFixed(1)}%  F0 std ${v.scores.f0std} st`);
console.log(`real sample F0 std ${manifest.reference.f0std} st; manifest ${MANIFEST}`);
