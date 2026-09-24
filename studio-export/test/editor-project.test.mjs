// The editor's timeline model: validation (every error code), building a project from a Studio job, workspace containment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import {
  ERR, EditorError, blankProject, isBareName, listMedia, openWorkspace, overlaps, probeDurationMs, projectDuration, projectFromJob, resolveMedia, subtitleClipsFromCaptions, validateProject,
} from '../src/editor/project.mjs';
import { sampleProject, writeSampleWorkspace } from '../src/editor/sample.mjs';

const codes = (p) => validateProject(p).errors?.map((e) => e.code) ?? [];
const mutate = (fn) => { const p = sampleProject(); fn(p); return p; };

test('a good project validates; the frozen ERR map holds every code as its own name', () => {
  assert.deepEqual(validateProject(sampleProject()), { ok: true });
  assert.deepEqual(validateProject(blankProject()), { ok: true });
  assert.ok(Object.isFrozen(ERR));
  for (const [k, v] of Object.entries(ERR)) assert.equal(k, v);
  assert.throws(() => { ERR.NEW = 'x'; }, TypeError);
});

const CASES = [
  [ERR.BAD_VERSION, (p) => { p.version = 2; }],
  [ERR.BAD_FPS, (p) => { p.fps = 0; }],
  [ERR.BAD_FPS, (p) => { p.fps = 29.97; }],
  [ERR.BAD_SIZE, (p) => { p.width = 4; }],
  [ERR.BAD_NAME, (p) => { p.name = 5; }],
  [ERR.BAD_NAME, (p) => { p.layers[0].name = 'x'.repeat(81); }],
  [ERR.BAD_REV, (p) => { p.rev = -1; }],
  [ERR.BAD_LAYERS, (p) => { p.layers = {}; }],
  [ERR.BAD_LAYERS, (p) => { p.layers[0] = 4; }],
  [ERR.BAD_KIND, (p) => { p.layers[0].kind = 'image'; }],
  [ERR.BAD_FLAG, (p) => { p.layers[0].muted = 'yes'; }],
  [ERR.BAD_FLAG, (p) => { delete p.layers[0].locked; }],
  [ERR.BAD_CLIPS, (p) => { p.layers[0].clips = 'none'; }],
  [ERR.BAD_CLIPS, (p) => { p.layers[0].clips[0] = null; }],
  [ERR.BAD_ID, (p) => { p.layers[0].clips[0].id = '../x'; }],
  [ERR.BAD_ID, (p) => { p.layers[0].id = ''; }],
  [ERR.DUP_ID, (p) => { p.layers[1].clips[0].id = 'c1'; }],
  [ERR.DUP_ID, (p) => { p.layers[1].id = 'video'; }],
  [ERR.BAD_TIME, (p) => { p.layers[0].clips[0].start = -1; }],
  [ERR.BAD_TIME, (p) => { p.layers[0].clips[0].start = 1.5; }],
  [ERR.BAD_TIME, (p) => { p.layers[0].clips[0].duration = 0; }],
  [ERR.BAD_TIME, (p) => { p.layers[3].clips[0].in = 10; }],
  [ERR.BAD_SRC, (p) => { p.layers[0].clips[0].src = '../demo.webm'; }],
  [ERR.BAD_SRC, (p) => { p.layers[0].clips[0].src = '/etc/passwd'; }],
  [ERR.BAD_SRC, (p) => { p.layers[0].clips[0].src = 'C:\\x.webm'; }],
  [ERR.BAD_SRC, (p) => { p.layers[0].clips[0].src = 'videos/demo.webm'; }],
  [ERR.BAD_SRC, (p) => { p.layers[0].clips[0].src = 'notes.txt'; }],
  [ERR.BAD_SRC, (p) => { delete p.layers[1].clips[0].src; }],
  [ERR.BAD_SRC, (p) => { p.layers[3].clips[0].src = 'demo.webm'; }],
  [ERR.BAD_TEXT, (p) => { p.layers[3].clips[0].text = '  '; }],
  [ERR.BAD_TEXT, (p) => { p.layers[3].clips[0].text = 'x'.repeat(501); }],
  [ERR.BAD_TEXT, (p) => { p.layers[0].clips[0].text = 'hi'; }],
  [ERR.BAD_GAIN, (p) => { p.layers[1].clips[0].gain = 5; }],
  [ERR.BAD_GAIN, (p) => { p.layers[0].clips[0].gain = 1; }],
  [ERR.OVERLAP, (p) => { p.layers[3].clips[1].start = 3000; }],
  [ERR.OVERLAP, (p) => { p.layers[0].clips.push({ id: 'c9', start: 9000, duration: 5000, in: 0, src: 'demo.webm' }); }],
  [ERR.UNKNOWN_FIELD, (p) => { p.evil = 1; }],
  [ERR.UNKNOWN_FIELD, (p) => { p.layers[0].clips[0].path = '/tmp/x'; }],
  [ERR.UNKNOWN_FIELD, (p) => { p.layers[0].dir = 'x'; }],
];
for (const [code, fn] of CASES) {
  test(`validateProject reports ${code}`, () => {
    const p = mutate(fn);
    assert.ok(codes(p).includes(code), `${code} in ${JSON.stringify(codes(p))}`);
  });
}

test('validateProject reports BAD_PROJECT for a non-object', () => {
  for (const v of [null, 4, 'x', []]) assert.deepEqual(codes(v), [ERR.BAD_PROJECT]);
});

test('voice and music clips may overlap inside a layer; video and subtitle clips may not', () => {
  const p = sampleProject();
  p.layers.find((l) => l.kind === 'voice').clips.push({ id: 'c8', start: 2000, duration: 3000, in: 0, src: 'x.opus' });
  p.layers.find((l) => l.kind === 'music').clips.push({ id: 'c9', start: 2000, duration: 3000, in: 0, src: 'x.mp3' });
  assert.equal(validateProject(p).ok, true);
  assert.deepEqual(overlaps(p.layers.find((l) => l.kind === 'voice')), []);
  const q = sampleProject();
  q.layers[3].clips[1].start = 3400;
  assert.deepEqual(overlaps(q.layers[3]), [['c4', 'c5']]);
  assert.equal(projectDuration(sampleProject()), 10000);
});

test('containment: names are bare, resolution stays inside the workspace and refuses a symlink that leaves it', () => {
  for (const bad of ['../x.webm', '/abs.webm', 'a/b.webm', '..', '.hidden.webm', 'a\\b.webm', '', `${'x'.repeat(200)}.webm`, 'a..b/../c']) assert.equal(isBareName(bad), false, bad);
  assert.equal(isBareName('demo.voice.opus'), true);
  const ws = openWorkspace(makeTempDir('studio-editor-ws-'));
  const outside = makeTempDir('studio-editor-out-');
  fs.writeFileSync(path.join(outside, 'secret.webm'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.webm'), path.join(ws, 'link.webm'));
  fs.mkdirSync(path.join(ws, 'videos'));
  fs.writeFileSync(path.join(ws, 'videos', 'in.webm'), 'ok');
  assert.equal(resolveMedia(ws, 'link.webm'), null, 'a link out of the workspace is refused');
  assert.equal(resolveMedia(ws, '../secret.webm'), null);
  assert.equal(resolveMedia(ws, 'in.webm'), path.join(ws, 'videos', 'in.webm'), 'videos/ is searched');
  assert.deepEqual(listMedia(ws), ['in.webm'], 'the listing shows plain files by name only, never a link');
});

test('subtitleClipsFromCaptions: ends from the next start or the reading time, no overlap, ids and order', () => {
  const clips = subtitleClipsFromCaptions([
    { id: 'l02', text: 'second', start: 5 },
    { text: 'first line', start: 1, end: 6 },
    { text: '   ', start: 2 },
    { text: 'last', start: 9 },
  ]);
  assert.deepEqual(clips.map((c) => [c.id, c.start, c.duration, c.text]), [['c1', 1000, 4000, 'first line'], ['c2', 5000, 3000, 'second'], ['c3', 9000, 3000, 'last']]);
  assert.throws(() => subtitleClipsFromCaptions({}), (e) => e instanceof EditorError && e.code === ERR.CORRUPT);
});

const fakeProbe = (table) => (cmd, args, _o, cb) => {
  const file = args.find((a) => /\.(webm|opus|mp3)$/.test(a));
  const ms = table[file];
  if (cmd === 'ffprobe') return cb(ms ? null : new Error('x'), ms ? `${ms / 1000}\n` : '', '');
  return cb(new Error('no ffmpeg'), '', '');
};

test('projectFromJob builds video, voice, music and a subtitle layer from workspace-relative names', async () => {
  const ws = openWorkspace(makeTempDir('studio-editor-job-'));
  writeSampleWorkspace(ws, { withProject: false });
  fs.writeFileSync(path.join(ws, 'demo.captions.json'), JSON.stringify([{ text: 'Hello', start: 0.5 }, { text: 'World', start: 4, end: 6 }]));
  const p = await projectFromJob(ws, 'demo', { execFile: fakeProbe({ [path.join(ws, 'demo.webm')]: 12000, [path.join(ws, 'demo.voice.opus')]: 9000, [path.join(ws, 'demo.music.mp3')]: 30000 }) });
  assert.equal(validateProject(p).ok, true);
  const by = Object.fromEntries(p.layers.map((l) => [l.kind, l.clips]));
  assert.deepEqual(by.video, [{ id: 'c1', start: 0, duration: 12000, in: 0, src: 'demo.webm' }]);
  assert.deepEqual(by.voice.map((c) => [c.src, c.duration]), [['demo.voice.opus', 9000]]);
  assert.deepEqual(by.music.map((c) => [c.src, c.duration]), [['demo.music.mp3', 12000]], 'music is cut to the video length');
  assert.deepEqual(by.subtitle.map((c) => [c.text, c.start, c.duration]), [['Hello', 500, 3000], ['World', 4000, 2000]]);
  assert.ok(!JSON.stringify(p).includes(ws), 'no absolute path in the project');
});

test('projectFromJob: only the recording is required; a missing recording, a bad slug and an unknown length are typed errors', async () => {
  const ws = openWorkspace(makeTempDir('studio-editor-job2-'));
  await assert.rejects(projectFromJob(ws, 'nope'), (e) => e.code === ERR.NO_VIDEO);
  await assert.rejects(projectFromJob(ws, '../etc'), (e) => e.code === ERR.BAD_SLUG);
  fs.writeFileSync(path.join(ws, 'a.webm'), 'x');
  const none = (c, a, o, cb) => cb(new Error('none'), '', '');
  await assert.rejects(projectFromJob(ws, 'a', { execFile: none }), (e) => e.code === ERR.NO_DURATION);
  fs.writeFileSync(path.join(ws, 'a.captions.json'), JSON.stringify([{ text: 'x', start: 2 }]));
  const p = await projectFromJob(ws, 'a', { execFile: none });
  assert.equal(p.layers[0].clips[0].duration, 6000, 'estimated from the captions: last end + 1 s');
  assert.equal(p.layers[1].clips.length + p.layers[2].clips.length, 0);
});

test('probeDurationMs falls back from ffprobe to the ffmpeg banner to a stream-copy pass', async () => {
  const seq = [];
  const exec = (cmd, args, _o, cb) => {
    seq.push(cmd + (args.includes('-c') ? ':copy' : ''));
    if (cmd === 'ffprobe') return cb(null, 'N/A\n', '');
    if (args.includes('-c')) return cb(null, '', 'frame=1 time=00:00:03.50 bitrate=1\nframe=9 time=00:00:07.25 bitrate=1');
    return cb(new Error('banner'), '', 'Duration: N/A');
  };
  assert.equal(await probeDurationMs('f.webm', { execFile: exec }), 7250);
  assert.deepEqual(seq, ['ffprobe', 'ffmpeg', 'ffmpeg:copy']);
  assert.equal(await probeDurationMs('f.webm', { execFile: (c, a, o, cb) => cb(null, '', 'Duration: 00:01:02.50, start') }), 62500);
});
