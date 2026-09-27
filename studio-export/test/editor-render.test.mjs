// Render plan (a deterministic ffmpeg argument array), subtitle export, containment of outputs, the run with an injected execFile,
// and one real ffmpeg render when ffmpeg exists on this machine (FFMPEG=/path or `ffmpeg` on the PATH), skipped with a message otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as realExecFile, execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './support/tmpdir.mjs';
import { ERR, blankProject } from '../src/editor/project.mjs';
import { balance, buildRenderPlan, exportSubtitles, lineExpr, paintOrder, renderProject, zoomExpr } from '../src/editor/render.mjs';
import { ZOOM_DEFAULT, audioMixAt, laneValueAt, opacityAt, zoomAt } from '../src/editor/ui/effects.mjs';
import { evalExpr, maxDepth } from './support/expr.mjs';
import { sampleProject, writeSampleWorkspace } from '../src/editor/sample.mjs';

/** The sample with a gap in the video (4000-6000) and a quieter voice. */
function gapProject() {
  const p = sampleProject();
  p.layers[0].clips = [{ id: 'c1', start: 0, duration: 4000, in: 1000, src: 'demo.webm' }, { id: 'c6', start: 6000, duration: 3000, in: 5000, src: 'demo.webm' }];
  p.layers[1].clips[0].gain = 0.8;
  return p;
}

test('render plan snapshot: trimmed clips over black with a gap, voice gain, music bed under a ducking compressor, soft subtitles', () => {
  const plan = buildRenderPlan(gapProject(), { slug: 'demo' });
  assert.deepEqual(plan.args, [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-ss', '1.000', '-t', '4.000', '-i', 'demo.webm',
    '-ss', '5.000', '-t', '3.000', '-i', 'demo.webm',
    '-ss', '0.000', '-t', '10.000', '-i', 'demo.voice.opus',
    '-ss', '0.000', '-t', '10.000', '-i', 'demo.music.mp3',
    '-i', 'demo.vtt',
    '-filter_complex', [
      'color=c=black:s=1280x720:r=30:d=10.000[b0]',
      '[0:v]setpts=PTS-STARTPTS+0.000/TB,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v0]',
      '[b0][v0]overlay=eof_action=pass[b1]',
      '[1:v]setpts=PTS-STARTPTS+6.000/TB,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v1]',
      '[b1][v1]overlay=eof_action=pass[b2]',
      '[b2]null[vout]',
      '[2:a]asetpts=PTS-STARTPTS,adelay=0:all=1,volume=0.8[vc0]',
      '[vc0]anull[voice]',
      '[3:a]asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.500,afade=t=out:st=8.500:d=1.500,adelay=0:all=1,volume=0.0398[mc0]',
      '[mc0]anull[mus]',
      '[voice]apad=whole_dur=10.000,asplit=2[vsc][vmix]',
      '[mus][vsc]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=500:makeup=1[duck]',
      '[vmix][duck]amix=inputs=2:normalize=0:duration=longest[aout]',
    ].join(';'),
    '-map', '[vout]', '-map', '[aout]', '-map', '4:0',
    '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus', '-b:a', '96k', '-ac', '2',
    '-c:s', 'webvtt', '-metadata:s:s:0', 'language=eng',
    '-t', '10.000', 'demo.export.tmp.webm',
  ]);
  assert.deepEqual(plan.outputs, [{ kind: 'video', name: 'demo.export.webm' }, { kind: 'srt', name: 'demo.srt' }, { kind: 'vtt', name: 'demo.vtt' }]);
  assert.ok(plan.args.every((a) => typeof a === 'string'), 'an argument array, never a shell string');
  assert.deepEqual(buildRenderPlan(gapProject(), { slug: 'demo' }), plan, 'deterministic');
});

test('muted layers are left out completely; a muted video layer with nothing else is nothing to render', () => {
  const p = gapProject();
  p.layers[0].muted = true;
  p.layers[2].muted = true;
  p.layers[3].muted = true;
  const plan = buildRenderPlan(p, { slug: 'demo' });
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.ok(!plan.args.includes('demo.webm') && !plan.args.includes('demo.music.mp3'), 'muted media is not an input');
  assert.ok(!graph.includes('overlay') && !graph.includes('sidechaincompress'));
  assert.ok(!plan.args.includes('-c:s') && !plan.args.includes('demo.vtt'), 'a muted subtitle layer gives no track');
  assert.deepEqual(plan.outputs, [{ kind: 'video', name: 'demo.export.webm' }]);
  assert.equal(plan.durationMs, 10000, 'the voice still sets the length');
  p.layers[1].muted = true;
  assert.throws(() => buildRenderPlan(p, { slug: 'demo' }), (e) => e.code === ERR.NOTHING_TO_RENDER);
});

test('burn-in draws the subtitles into the picture and adds no subtitle stream; the srt and vtt are still exported', () => {
  const plan = buildRenderPlan(gapProject(), { slug: 'demo', burnSubtitles: true });
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[b2\]subtitles=demo\.srt\[vout\]/);
  assert.ok(!plan.args.includes('-c:s') && !plan.args.includes('demo.vtt'));
  assert.equal(plan.burnSubtitles, true);
  assert.deepEqual(plan.subtitleFiles.map((f) => f.name), ['demo.srt', 'demo.vtt']);
  const soft = buildRenderPlan(gapProject(), { slug: 'demo' });
  assert.ok(!soft.args.join(' ').includes('subtitles='), 'soft is the default');
});

test('gain and layout: music own gain, several voice clips are mixed, overlapping voice clips are delayed to their start, video layers stack (first on top)', () => {
  const p = blankProject({ width: 640, height: 360, fps: 25 });
  const L = (id) => p.layers.find((l) => l.id === id);
  L('video').clips.push({ id: 'c1', start: 0, duration: 2000, in: 0, src: 'top.webm' });
  p.layers.push({ id: 'v2', kind: 'video', name: 'Under', muted: false, locked: false, clips: [{ id: 'c2', start: 0, duration: 3000, in: 0, src: 'under.webm' }] });
  L('voice').clips.push({ id: 'c3', start: 1000, duration: 2000, in: 250, src: 'a.opus' }, { id: 'c4', start: 2000, duration: 2000, in: 0, src: 'b.opus', gain: 1.5 });
  L('music').clips.push({ id: 'c5', start: 0, duration: 1000, in: 0, src: 'm.mp3', gain: 0.2 });
  const plan = buildRenderPlan(p, { slug: 'x' });
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1];
  assert.deepEqual(plan.inputs, ['under.webm', 'top.webm', 'a.opus', 'b.opus', 'm.mp3']);
  assert.match(graph, /color=c=black:s=640x360:r=25:d=4\.000/);
  assert.match(graph, /\[2:a\]asetpts=PTS-STARTPTS,adelay=1000:all=1,volume=1\[vc0\]/);
  assert.match(graph, /\[3:a\]asetpts=PTS-STARTPTS,adelay=2000:all=1,volume=1\.5\[vc1\]/);
  assert.match(graph, /\[vc0\]\[vc1\]amix=inputs=2:normalize=0:duration=longest\[voice\]/);
  assert.match(graph, /afade=t=in:st=0:d=0\.500,afade=t=out:st=0\.500:d=0\.500,adelay=0:all=1,volume=0\.2\[mc0\]/, 'fades never exceed half a short clip');
  assert.ok(plan.args.join(' ').includes('-ss 0.250 -t 2.000 -i a.opus'), 'the source offset is the input seek');
  assert.ok(!plan.args.includes('-c:s'), 'no subtitle clips, no subtitle track');
});

test('subtitles export as srt and vtt from the subtitle layer, in time order, with the library the media tools use', () => {
  const p = sampleProject();
  p.layers[3].clips.push({ id: 'c9', start: 8000, duration: 1234, in: 0, text: 'Last\nlines' });
  const s = exportSubtitles(p);
  assert.equal(s.srt, '1\n00:00:00,500 --> 00:00:03,500\nHello there, this is Studio\n\n2\n00:00:04,000 --> 00:00:07,000\nA second line of text\n\n3\n00:00:08,000 --> 00:00:09,234\nLast\nlines\n');
  assert.ok(s.vtt.startsWith('WEBVTT\n\n1\n00:00:00.500 --> 00:00:03.500\nHello there, this is Studio\n'));
  assert.equal(exportSubtitles(blankProject()), null);
});

test('containment: a project or clip that names ../ or an absolute path never reaches ffmpeg', async () => {
  const ws = makeTempDir('studio-editor-render-');
  writeSampleWorkspace(ws, { withProject: false });
  const calls = [];
  const execFile = (...a) => { calls.push(a); a.at(-1)(null, '', ''); };
  for (const bad of ['../demo.webm', '/etc/passwd', 'a/../../b.webm', 'C:\\x.webm', 'videos/demo.webm']) {
    const p = sampleProject();
    p.layers[0].clips[0].src = bad;
    assert.throws(() => buildRenderPlan(p, { slug: 'demo' }), (e) => e.code === ERR.BAD_SRC, bad);
    await assert.rejects(renderProject({ project: p, workspace: ws, slug: 'demo', execFile }), (e) => e.code === ERR.BAD_SRC, bad);
  }
  for (const slug of ['../x', 'a/b', '/abs', '', 'x y']) assert.throws(() => buildRenderPlan(sampleProject(), { slug }), (e) => e.code === ERR.BAD_SLUG, slug);
  assert.equal(calls.length, 0, 'ffmpeg was never started');
  const outside = makeTempDir('studio-editor-render-out-');
  fs.writeFileSync(path.join(outside, 'x.webm'), 'x');
  fs.symlinkSync(path.join(outside, 'x.webm'), path.join(ws, 'link.webm'));
  const p = sampleProject();
  p.layers[0].clips[0].src = 'link.webm';
  await assert.rejects(renderProject({ project: p, workspace: ws, slug: 'demo', execFile }), (e) => e.code === ERR.NOT_FOUND, 'a link out of the workspace is not an input');
  await assert.rejects(renderProject({ project: sampleProject(), workspace: ws, slug: 'demo', execFile }).then(() => { throw new Error('unexpected'); }), /ffmpeg finished but wrote no file/);
});

function fakeFfmpeg({ write = true, fail = false, progress = ['out_time_us=2500000', 'progress=continue', 'out_time_us=9900000', 'progress=end'] } = {}) {
  const calls = [];
  const execFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const child = { stdout: new EventEmitter() };
    setImmediate(() => {
      child.stdout.emit('data', `${progress.join('\n')}\n`);
      if (write) fs.writeFileSync(path.join(opts.cwd, args.at(-1)), 'video');
      cb(fail ? Object.assign(new Error('exit 1'), { code: 1 }) : null, '', fail ? 'Error opening input\nsecond line' : '');
    });
    return child;
  };
  return { execFile, calls };
}

test('renderProject runs the plan with cwd = the workspace, writes subtitles and the export inside it, and emits progress', async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-render2-'));
  fs.mkdirSync(path.join(ws, 'videos'));
  writeSampleWorkspace(ws, { withProject: false });
  fs.renameSync(path.join(ws, 'demo.webm'), path.join(ws, 'videos', 'demo.webm'));
  const { execFile, calls } = fakeFfmpeg();
  const events = [];
  const out = await renderProject({ project: gapProject(), workspace: ws, slug: 'demo', execFile, onEvent: (e) => events.push(e), ffmpeg: 'ffmpeg-test' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'ffmpeg-test');
  assert.equal(calls[0].opts.cwd, ws);
  assert.ok(Array.isArray(calls[0].args));
  assert.ok(calls[0].args.includes('videos/demo.webm'), 'inputs are workspace-relative, found in videos/');
  assert.ok(calls[0].args.every((a) => !a.startsWith('/') && !a.includes('..')), 'no absolute or parent path in any argument');
  assert.deepEqual(out.outputs, ['demo.export.webm', 'demo.srt', 'demo.vtt']);
  assert.deepEqual(fs.readdirSync(ws).sort(), ['demo.export.webm', 'demo.music.mp3', 'demo.srt', 'demo.voice.opus', 'demo.vtt', 'videos']);
  assert.match(fs.readFileSync(path.join(ws, 'demo.srt'), 'utf8'), /Hello there, this is Studio/);
  assert.deepEqual(events.map((e) => e.type), ['start', 'progress', 'progress', 'done']);
  assert.deepEqual(events.filter((e) => e.type === 'progress').map((e) => e.pct), [25, 99]);
  assert.equal(events[0].durationMs, 10000);
});

test('a failing ffmpeg is a RENDER_FAILED error event with the tail of its message, and leaves no half-written export', async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-render3-'));
  writeSampleWorkspace(ws, { withProject: false });
  const { execFile } = fakeFfmpeg({ fail: true });
  const events = [];
  await assert.rejects(renderProject({ project: sampleProject(), workspace: ws, slug: 'demo', execFile, onEvent: (e) => events.push(e) }), (e) => e.code === ERR.RENDER_FAILED && /Error opening input/.test(e.message));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).code, ERR.RENDER_FAILED);
  assert.ok(!fs.existsSync(path.join(ws, 'demo.export.webm')));
  await assert.rejects(renderProject({ project: sampleProject(), workspace: ws, slug: 'demo', execFile: () => { throw new Error('spawn ENOENT'); } }), (e) => e.code === ERR.RENDER_FAILED);
});

test('renderProject without a slug names the outputs after the project (made file-safe)', async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-render4-'));
  writeSampleWorkspace(ws, { withProject: false });
  const p = sampleProject();
  p.name = 'My Demo, take 2!';
  const out = await renderProject({ project: p, workspace: ws, execFile: fakeFfmpeg().execFile });
  assert.deepEqual(out.outputs, ['my-demo-take-2.export.webm', 'my-demo-take-2.srt', 'my-demo-take-2.vtt']);
});

// ---- one real render, when ffmpeg is here

const FFMPEG = process.env.FFMPEG || (spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null);
const real = { skip: FFMPEG ? false : 'ffmpeg is not installed here (set FFMPEG=/path/to/ffmpeg); the real render was skipped and only the plan and the fake-execFile runs were checked' };

test('a real ffmpeg render of a tiny generated clip: gap is black, subtitles are a soft track, burn-in works, audio is mixed', real, async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-real-'));
  const run = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: ws });
  run('-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=4', '-c:v', 'libvpx', 'demo.webm');
  run('-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libopus', 'demo.voice.opus');
  run('-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'libmp3lame', 'demo.music.mp3');
  const p = blankProject({ name: 'x', width: 320, height: 180, fps: 15 });
  const L = (id) => p.layers.find((l) => l.id === id);
  L('video').clips.push({ id: 'c1', start: 0, duration: 1500, in: 0, src: 'demo.webm' }, { id: 'c2', start: 2500, duration: 1500, in: 2000, src: 'demo.webm' });
  L('voice').clips.push({ id: 'c3', start: 500, duration: 2500, in: 0, src: 'demo.voice.opus', gain: 0.9 });
  L('music').clips.push({ id: 'c4', start: 0, duration: 4000, in: 0, src: 'demo.music.mp3' });
  L('subs').clips.push({ id: 'c5', start: 200, duration: 1500, in: 0, text: 'Hello' });
  const events = [];
  const info = () => spawnSync(FFMPEG, ['-hide_banner', '-i', path.join(ws, 'demo.export.webm')], { encoding: 'utf8' }).stderr;
  const brightness = (t) => {
    const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', path.join(ws, 'demo.export.webm'), '-frames:v', '1', '-vf', 'scale=32:18', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
    return raw.reduce((a, b) => a + b, 0) / raw.length;
  };
  await renderProject({ project: p, workspace: ws, slug: 'demo', execFile: realExecFile, ffmpeg: FFMPEG, onEvent: (e) => events.push(e.type) });
  let banner = info();
  assert.match(banner, /Duration: 00:00:04/);
  assert.match(banner, /Video: vp9.*320x180/);
  assert.match(banner, /Audio: opus/);
  assert.match(banner, /Subtitle: webvtt/, 'a soft subtitle track');
  assert.ok(brightness(0.8) > 60, 'the first clip shows the test pattern');
  assert.ok(brightness(2.0) < 25, 'the gap is black');
  assert.ok(brightness(3.0) > 60, 'the second clip shows the pattern again');
  assert.equal(events[0], 'start');
  assert.equal(events.at(-1), 'done');
  assert.match(fs.readFileSync(path.join(ws, 'demo.vtt'), 'utf8'), /^WEBVTT/);
  await renderProject({ project: p, workspace: ws, slug: 'demo', execFile: realExecFile, ffmpeg: FFMPEG, burnSubtitles: true });
  banner = info();
  assert.ok(!/Subtitle:/.test(banner), 'burn-in adds no subtitle stream');
  assert.match(banner, /Audio: opus/);
  assert.deepEqual(fs.readdirSync(ws).filter((f) => f.includes('tmp')), [], 'no temp file is left behind');
});

const vc = (id, start, duration) => ({ id, start, duration, in: 0, src: 'demo.webm' });

test('paintOrder: no overlap keeps start order; an overlapping later clip goes under the earlier one; ties go to the lower id', () => {
  const ids = (clips) => paintOrder(clips).map((c) => c.id);
  assert.deepEqual(ids([vc('b', 5000, 1000), vc('a', 0, 1000), vc('c', 9000, 500)]), ['a', 'b', 'c'], 'no overlap: plain start order, whatever the input order');
  assert.deepEqual(ids([vc('a', 0, 10000), vc('b', 5000, 10000)]), ['b', 'a'], 'the later clip is painted first, so it is under');
  assert.deepEqual(ids([vc('b', 5000, 10000), vc('a', 0, 10000)]), ['b', 'a'], 'input order does not matter');
  assert.deepEqual(ids([vc('a', 0, 10000), vc('b', 2000, 10000), vc('c', 4000, 10000)]), ['c', 'b', 'a'], 'a chain: the first is on top of all');
  assert.deepEqual(ids([vc('a', 0, 10000), vc('b', 2000, 500), vc('c', 8000, 4000)]), ['b', 'c', 'a'], 'every overlapping pair has the earlier clip later in the list');
  assert.deepEqual(ids([vc('c1', 1000, 5000), vc('c2', 1000, 5000)]), ['c2', 'c1'], 'the same start: the lower id is on top');
  assert.deepEqual(ids([vc('a', 0, 1000), vc('b', 1000, 1000)]), ['a', 'b'], 'touching is not overlapping');
});

test('overlapping video clips render with the earlier one on top, and the picture is only overlaid once per clip', () => {
  const p = blankProject({ name: 'Stack' });
  p.layers[0].clips.push(vc('c1', 0, 6000), vc('c2', 4000, 6000));
  const plan = buildRenderPlan(p, { slug: 'stack' });
  const graph = plan.args[plan.args.indexOf('-filter_complex') + 1].split(';');
  const overlays = graph.filter((g) => g.includes('overlay=')).length;
  assert.equal(overlays, 2);
  assert.equal(plan.inputs.filter((n) => n === 'demo.webm').length, 2);
  // input 0 is the clip painted first (the later one, c2, at 4 s), input 1 is painted last and so is on top (c1)
  assert.match(graph.find((g) => g.startsWith('[0:v]')), /PTS-STARTPTS\+4\.000\/TB/, 'c2 (starts at 4 s) is painted first');
  assert.match(graph.find((g) => g.startsWith('[1:v]')), /PTS-STARTPTS\+0\.000\/TB/, 'c1 (starts at 0 s) is painted last, on top');
  assert.equal(plan.durationMs, 10000);
});

test('a lower layer sits under an upper one, and inside a layer the earlier clip sits on top', () => {
  const p = blankProject({ name: 'Two' });
  p.layers.splice(1, 0, { id: 'v2', kind: 'video', name: 'Video 2', muted: false, locked: false, clips: [vc('d1', 0, 5000)] });
  p.layers[0].clips.push(vc('c1', 0, 4000), vc('c2', 2000, 4000));
  const plan = buildRenderPlan(p, { slug: 'two' });
  const order = plan.args.reduce((a, x, i) => (x === '-ss' ? [...a, plan.args[i + 5]] : a), []);
  assert.deepEqual(plan.inputs, ['demo.webm', 'demo.webm', 'demo.webm']);
  const starts = plan.args[plan.args.indexOf('-filter_complex') + 1].split(';').filter((g) => /^\[\d:v\]/.test(g)).map((g) => /PTS-STARTPTS\+([\d.]+)/.exec(g)[1]);
  assert.deepEqual(starts, ['0.000', '2.000', '0.000'], 'the lower layer d1 first, then the top layer: c2 under c1');
  assert.equal(order.length, 3);
});

test('a real render of overlapping video clips: the one that starts first is on top, the later one shows only where it is alone', real, async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-stack-'));
  const run = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: ws });
  run('-f', 'lavfi', '-i', 'color=c=red:size=64x36:rate=15:duration=4', '-c:v', 'libvpx', 'red.webm');
  run('-f', 'lavfi', '-i', 'color=c=blue:size=64x36:rate=15:duration=4', '-c:v', 'libvpx', 'blue.webm');
  const p = blankProject({ name: 'stack', width: 64, height: 36, fps: 15 });
  // the blue clip is listed FIRST in the file but starts later (1.5 s), so it must still go under the red one (0-3 s)
  p.layers[0].clips.push({ id: 'c1', start: 1500, duration: 3000, in: 0, src: 'blue.webm' }, { id: 'c2', start: 0, duration: 3000, in: 0, src: 'red.webm' });
  await renderProject({ project: p, workspace: ws, slug: 'stack', execFile: realExecFile, ffmpeg: FFMPEG });
  const rgb = (t) => {
    const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', path.join(ws, 'stack.export.webm'), '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
    return [raw[0], raw[1], raw[2]];
  };
  const isRed = ([r, , b]) => r > 150 && b < 100;
  const isBlue = ([r, , b]) => b > 150 && r < 100;
  assert.ok(isRed(rgb(0.5)), `0.5 s: only red, got ${rgb(0.5)}`);
  assert.ok(isRed(rgb(2.2)), `2.2 s: both overlap, the earlier (red) is on top, got ${rgb(2.2)}`);
  assert.ok(isBlue(rgb(3.6)), `3.6 s: only blue is left, got ${rgb(3.6)}`);
});

const graphOf = (p) => { const plan = buildRenderPlan(p, { slug: 'g' }); return plan.args[plan.args.indexOf('-filter_complex') + 1].split(';'); };

test('render volumes: a clip plays at its gain times its layer volume; the master scales the whole mix; unity adds nothing', () => {
  const p = sampleProject();
  p.layers[1].clips[0].gain = 0.8;
  const base = graphOf(p);
  assert.ok(base.some((g) => g.includes('volume=0.8[vc0]')), 'clip gain alone');
  assert.ok(!base.some((g) => g.includes('amaster') || g.includes('alimiter')), 'no master, no extra stage');
  p.layers[1].gain = 0.5;
  assert.ok(graphOf(p).some((g) => g.includes('volume=0.4[vc0]')), 'gain 0.8 x layer 0.5');
  p.layers[2].gain = 2;
  assert.ok(graphOf(p).some((g) => g.includes('volume=0.0796[mc0]')), 'the music bed level (0.0398) x layer 2');
  p.master = 0.5;
  const q = graphOf(p);
  assert.ok(q.some((g) => g === '[vmix][duck]amix=inputs=2:normalize=0:duration=longest[amaster]'), 'the mix goes to the master stage');
  assert.ok(q.includes('[amaster]volume=0.5[aout]'), 'and out through the master volume, with no limiter below 1');
  assert.equal(q.filter((g) => g.includes('[aout]')).length, 1, 'exactly one final output');
  p.master = 2;
  assert.ok(graphOf(p).includes('[amaster]volume=2,alimiter=limit=0.97[aout]'), 'above unity a limiter follows');
  p.master = 0;
  assert.ok(graphOf(p).includes('[amaster]volume=0[aout]'), 'silence');
});

test('master volume works with only voice, only music, and no audio at all', () => {
  const only = (kind) => { const p = sampleProject(); p.master = 0.5; for (const l of p.layers) if ((l.kind === 'voice' || l.kind === 'music') && l.kind !== kind) l.clips = []; return graphOf(p); };
  assert.ok(only('voice').includes('[voice]anull[amaster]') && only('voice').includes('[amaster]volume=0.5[aout]'));
  assert.ok(only('music').includes('[mus]anull[amaster]') && only('music').includes('[amaster]volume=0.5[aout]'));
  const silent = sampleProject();
  silent.master = 0.5;
  for (const l of silent.layers) if (l.kind === 'voice' || l.kind === 'music') l.clips = [];
  const g = graphOf(silent);
  assert.ok(!g.some((x) => x.includes('amaster')), 'a video-only project has no audio stage for the master to scale');
});

test('a real render: the master volume and a layer volume change the level of the export by the right number of decibels', real, async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-vol-'));
  const run = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: ws });
  run('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', 'tone.opus');
  const level = async (master, layerGain) => {
    const p = blankProject({ name: 'vol', width: 64, height: 36, fps: 10 });
    p.layers[1].clips.push({ id: 'c1', start: 0, duration: 1500, in: 0, src: 'tone.opus', gain: 1 });
    if (master !== undefined) p.master = master;
    if (layerGain !== undefined) p.layers[1].gain = layerGain;
    await renderProject({ project: p, workspace: ws, slug: 'vol', execFile: realExecFile, ffmpeg: FFMPEG });
    const out = spawnSync(FFMPEG, ['-hide_banner', '-i', path.join(ws, 'vol.export.webm'), '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    return Number(/mean_volume: (-?[\d.]+) dB/.exec(out)[1]);
  };
  const unity = await level();
  const half = await level(0.5);
  const quarterLayer = await level(undefined, 0.25);
  const both = await level(0.5, 0.5);
  assert.ok(Math.abs(unity - half - 6.02) < 0.7, `master 0.5 is 6 dB down: ${unity} -> ${half}`);
  assert.ok(Math.abs(unity - quarterLayer - 12.04) < 0.9, `layer 0.25 is 12 dB down: ${unity} -> ${quarterLayer}`);
  assert.ok(Math.abs(unity - both - 12.04) < 0.9, `they multiply (0.5 x 0.5): ${unity} -> ${both}`);
});

// ---- automation lines in the render

const P = (t, v, curve = 'linear') => ({ t, v, curve });
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

test('lineExpr agrees with the curve function the preview uses, at and between every point, for every curve', () => {
  const rnd = seeded(7);
  const check = (points, label) => {
    const expr = lineExpr(points);
    const times = [0, 1, ...points.flatMap((p) => [p.t - 1, p.t, p.t + 1, p.t + 137]), points.at(-1).t + 5000];
    for (let k = 0; k < 40; k++) times.push(Math.floor(rnd() * (points.at(-1).t + 2000)));
    for (const ms of times.filter((x) => x >= 0)) {
      const got = evalExpr(expr, { t: ms / 1000 });
      const want = laneValueAt(points, ms);
      assert.ok(Math.abs(got - want) < 0.002 + Math.abs(want) * 0.001, `${label} at ${ms} ms: expression ${got} vs curve ${want}`);
    }
  };
  check([P(0, 1)], 'one point');
  check([P(500, 0.3)], 'one point, late');
  check([P(0, 0), P(1000, 1)], 'a ramp');
  check([P(0, 1, 'hold'), P(1000, 0, 'hold'), P(2000, 1)], 'steps');
  for (const curve of CURVES_UNDER_TEST) check([P(200, 0.2, curve), P(1700, 3.5, curve), P(2500, 0.1, curve)], curve);
  check([P(0, 1, 'ease-in'), P(400, 0, 'linear'), P(900, 0.5, 'hold'), P(1200, 2, 'ease-out'), P(3000, 1, 'ease-in-out'), P(3100, 4)], 'a mix');
  const many = Array.from({ length: 300 }, (_, i) => P(i * 37 + 5, (Math.sin(i / 5) + 1) / 2 * 4, CURVES_UNDER_TEST[i % 5]));
  check(many, '300 points');
  assert.ok(maxDepth(lineExpr(many)) < 60, `a 300-point line is a shallow tree: depth ${maxDepth(lineExpr(many))}`);
  const five = Array.from({ length: 500 }, (_, i) => P(i * 10, i % 2 ? 1 : 0));
  assert.ok(maxDepth(lineExpr(five)) < 80, `a 500-point line: depth ${maxDepth(lineExpr(five))}`);
  assert.ok(!/[:;]/.test(lineExpr(many)), 'nothing in it can end a filter option or a chain');
  assert.equal(lineExpr([P(0, 0.5)]), '0.5', 'a single point is just its value');
  assert.match(lineExpr([P(0, 0), P(1000, 1)], '(T-2)'), /clip\(\(\(T-2\)-0\.000\)\/1\.000,0,1\)/, 'the time variable is the caller\'s');
});
const CURVES_UNDER_TEST = ['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out'];

test('balance pan: the far side fades, the near side stays full, centre changes nothing', () => {
  assert.deepEqual(balance(0), [1, 1]);
  assert.deepEqual(balance(-1), [1, 0]);
  assert.deepEqual(balance(1), [0, 1]);
  assert.deepEqual(balance(-0.25), [1, 0.75]);
  assert.deepEqual(balance(0.5), [0.5, 1]);
});

const lineProject = (fn) => { const p = sampleProject(); fn(p); return p; };
const addLine = (p, clipId, param, points, at) => { p.layers.splice(at ?? p.layers.length, 0, { id: `L${param}${clipId}`, kind: 'automation', name: 'line', muted: false, locked: false, clips: [], link: { clipId, param }, points }); };

test('render plan: volume, mute and pan lines and static pan become filters; a muted line layer is bypassed; without them the graph is unchanged', () => {
  const plain = graphOf(sampleProject());
  const g = graphOf(lineProject((p) => addLine(p, 'c2', 'gain', [P(0, 1), P(2000, 0.2)])));
  const vc = g.find((x) => x.includes('[vc0]'));
  assert.ok(vc.includes("volume='(if(lt(t,2.000),(1+(-0.8)*(clip((t-0.000)/2.000,0,1))),0.2))':eval=frame"), 'a per-frame volume expression: the ramp, then the last value');
  assert.ok(vc.includes(":eval=frame,adelay=0:all=1[vc0]"), 'applied from the clip\'s own start, before it is delayed onto the timeline');
  assert.ok(!/volume=0\.\d+\[vc0\]|volume=1\[vc0\]/.test(vc), 'no second, constant volume after it');
  // layer volume multiplies the line
  const withLayer = graphOf(lineProject((p) => { addLine(p, 'c2', 'gain', [P(0, 1)]); p.layers.find((l) => l.id === 'voice').gain = 0.5; }));
  assert.match(withLayer.find((x) => x.includes('[vc0]')), /volume='1\*0\.5':eval=frame|volume='\(1\)\*0\.5':eval=frame|volume='1\*0\.5'/);
  // mute
  const mu = graphOf(lineProject((p) => addLine(p, 'c2', 'mute', [P(0, 0, 'hold'), P(1000, 1, 'hold')]))).find((x) => x.includes('[vc0]'));
  assert.match(mu, /volume='1\*\(1-clip\(/, 'the clip\'s gain times (1 - mute)');
  // pan line: split, one expression per channel, join
  const pl = graphOf(lineProject((p) => addLine(p, 'c2', 'pan', [P(0, -1), P(1000, 1)])));
  assert.ok(pl.some((x) => /channelsplit=channel_layout=stereo\[vc0L\]\[vc0R\]/.test(x)), 'stereo, then split');
  assert.ok(pl.some((x) => /^\[vc0L\]volume='min\(1,1-\(/.test(x)) && pl.some((x) => /^\[vc0R\]volume='min\(1,1\+\(/.test(x)), 'a gain expression per side');
  assert.ok(pl.some((x) => x.startsWith('[vc0l][vc0r]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR,adelay=0:all=1')), 'joined back before the clip is delayed');
  // static pan of a clip and of its layer
  const sp = graphOf(lineProject((p) => { p.layers.find((l) => l.id === 'voice').clips[0].pan = -0.5; p.layers.find((l) => l.id === 'voice').pan = 0.5; })).find((x) => x.includes('[vc0]'));
  assert.match(sp, /aformat=channel_layouts=stereo,pan=stereo\|c0=0\.5\*c0\|c1=0\.5\*c1/, 'clip pan -0.5 (right x0.5) times layer pan +0.5 (left x0.5)');
  // bypassed when the line layer is muted, and absent lines change nothing
  const bypass = graphOf(lineProject((p) => { addLine(p, 'c2', 'gain', [P(0, 0.1)]); p.layers.find((l) => l.kind === 'automation').muted = true; }));
  assert.deepEqual(bypass, plain, 'a muted line layer is ignored');
  assert.deepEqual(graphOf(lineProject((p) => addLine(p, 'c1', 'opacity', [P(0, 1)]))).filter((x) => !x.includes('[v0]')), plain.filter((x) => !x.includes('[v0]')), 'a video line touches only the video chain');
});

test('render plan: opacity, constant and drawn', () => {
  const plain = graphOf(sampleProject()).find((x) => x.includes('[v0]'));
  assert.ok(!/yuva|geq|colorchannelmixer/.test(plain), 'full opacity adds nothing');
  const half = graphOf(lineProject((p) => { p.layers[0].clips[0].opacity = 0.5; })).find((x) => x.includes('[v0]'));
  assert.match(half, /format=yuv420p,format=yuva420p,colorchannelmixer=aa=0\.5\[v0\]/);
  const drawn = graphOf(lineProject((p) => { p.layers[0].clips[0].start = 1500; p.layers[0].clips.push({ id: 'c9', start: 20000, duration: 1000, in: 0, src: 'demo.webm' }); addLine(p, 'c1', 'opacity', [P(0, 0), P(2000, 1)]); })).find((x) => x.includes('[v'));
  assert.match(drawn, /format=yuva420p,geq=lum='lum\(X,Y\)':cb='cb\(X,Y\)':cr='cr\(X,Y\)':a='255\*clip\(/);
  assert.match(drawn, /\(T-1\.500\)/, 'the line runs from the clip\'s own start (the clip begins at 1.5 s)');
  assert.ok(drawn.endsWith(",0,1)'[v0]") || drawn.endsWith(",0,1)'[v1]") || /\[v\d\]$/.test(drawn));
});

const rms = (file, { from = 0, len = 0.4, af = '' } = {}) => {
  const out = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(from), '-t', String(len), '-i', file, '-af', `${af}${af ? ',' : ''}volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = /mean_volume: (-?[\d.]+) dB/.exec(out);
  return m ? Number(m[1]) : -Infinity;
};

test('real renders: volume, mute and pan lines change the sound over time exactly as drawn', real, async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-lines-'));
  const run = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: ws });
  run('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libopus', 'tone.opus');
  const render = async (fn) => {
    const p = blankProject({ name: 'ln', width: 64, height: 36, fps: 10 });
    p.layers[1].clips.push({ id: 'c1', start: 0, duration: 2000, in: 0, src: 'tone.opus', gain: 1 });
    fn(p);
    await renderProject({ project: p, workspace: ws, slug: 'ln', execFile: realExecFile, ffmpeg: FFMPEG });
    return path.join(ws, 'ln.export.webm');
  };
  const flat = rms(await render(() => {}), { from: 0.2, len: 0.3 });
  // volume line 1 -> 0 over 2 s: loud at the start, about 19 dB down near the end (0.9 vs 0.1)
  const fade = await render((p) => addLine(p, 'c1', 'gain', [P(0, 1), P(2000, 0)]));
  const early = rms(fade, { from: 0.1, len: 0.3 });
  const late = rms(fade, { from: 1.6, len: 0.3 });
  assert.ok(Math.abs(early - flat) < 2.5, `early on the line the level is close to unity: ${early} vs ${flat}`);
  assert.ok(early - late > 12 && early - late < 26, `the level fell by about 19 dB along the line: ${early} -> ${late}`);
  // a hold line: full for a second, then a quarter (12 dB down)
  const steps = await render((p) => addLine(p, 'c1', 'gain', [P(0, 1, 'hold'), P(1000, 0.25)]));
  assert.ok(Math.abs(rms(steps, { from: 0.2, len: 0.4 }) - flat) < 1.5 && Math.abs(rms(steps, { from: 1.3, len: 0.5 }) - (flat - 12.04)) < 1.5, 'a step down of 12 dB at 1 s');
  // mute line: silence from 1 s
  const muted = await render((p) => addLine(p, 'c1', 'mute', [P(0, 0, 'hold'), P(1000, 1, 'hold')]));
  assert.ok(rms(muted, { from: 0.2, len: 0.4 }) > flat - 2, 'sound before the mute');
  assert.ok(rms(muted, { from: 1.2, len: 0.5 }) < -50, `silence after it: ${rms(muted, { from: 1.2, len: 0.5 })}`);
  // static pan hard left: the right channel is silent, the left is not
  const left = await render((p) => { p.layers[1].clips[0].pan = -1; });
  assert.ok(rms(left, { from: 0.2, len: 0.5, af: 'pan=mono|c0=c0' }) > flat - 2, 'left channel at full level');
  assert.ok(rms(left, { from: 0.2, len: 0.5, af: 'pan=mono|c0=c1' }) < -50, 'right channel silent');
  // pan line from left to right: left first, right last
  const sweep = await render((p) => addLine(p, 'c1', 'pan', [P(0, -1), P(2000, 1)]));
  const L = (from) => rms(sweep, { from, len: 0.3, af: 'pan=mono|c0=c0' });
  const R = (from) => rms(sweep, { from, len: 0.3, af: 'pan=mono|c0=c1' });
  assert.ok(L(0.05) - R(0.05) > 12, `at the start it is on the left: L ${L(0.05)} R ${R(0.05)}`);
  assert.ok(R(1.65) - L(1.65) > 12, `at the end it is on the right: L ${L(1.65)} R ${R(1.65)}`);
  assert.ok(Math.abs(L(0.85) - R(0.85)) < 3, `in the middle it is centred: L ${L(0.85)} R ${R(0.85)}`);
  // layer volume and a line together: layer 0.5 halves a line that holds 1
  const both = await render((p) => { addLine(p, 'c1', 'gain', [P(0, 1)]); p.layers[1].gain = 0.5; });
  assert.ok(Math.abs(rms(both, { from: 0.2, len: 0.5 }) - (flat - 6.02)) < 1.2, 'layer 0.5 x line 1 = 6 dB down');
});

test('a real render: opacity, constant and drawn, and blended over another clip', real, async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-alpha-'));
  const run = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: ws });
  run('-f', 'lavfi', '-i', 'color=c=white:size=64x36:rate=10:duration=3', '-c:v', 'libvpx', 'white.webm');
  run('-f', 'lavfi', '-i', 'color=c=red:size=64x36:rate=10:duration=3', '-c:v', 'libvpx', 'red.webm');
  run('-f', 'lavfi', '-i', 'color=c=blue:size=64x36:rate=10:duration=3', '-c:v', 'libvpx', 'blue.webm');
  const px = (file, t) => { const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }); return [raw[0], raw[1], raw[2]]; };
  const render = async (fn) => {
    const p = blankProject({ name: 'al', width: 64, height: 36, fps: 10 });
    fn(p);
    await renderProject({ project: p, workspace: ws, slug: 'al', execFile: realExecFile, ffmpeg: FFMPEG });
    return path.join(ws, 'al.export.webm');
  };
  const white = [{ id: 'c1', start: 0, duration: 2000, in: 0, src: 'white.webm' }];
  const solid = px(await render((p) => p.layers[0].clips.push(...white)), 1);
  assert.ok(solid[0] > 220 && solid[1] > 220, `opaque white: ${solid}`);
  const half = px(await render((p) => p.layers[0].clips.push({ ...white[0], opacity: 0.5 })), 1);
  assert.ok(half[0] > 100 && half[0] < 160 && Math.abs(half[0] - half[2]) < 12, `half-opaque white over black is grey: ${half}`);
  const line = await render((p) => { p.layers[0].clips.push(...white); addLine(p, 'c1', 'opacity', [P(0, 0), P(2000, 1)]); });
  const dim = px(line, 0.2);
  const bright = px(line, 1.8);
  assert.ok(dim[0] < 70, `at 0.2 s along a 0 -> 1 line it is still dark: ${dim}`);
  assert.ok(bright[0] > 190, `at 1.8 s it is nearly opaque: ${bright}`);
  assert.ok(bright[0] - dim[0] > 120, 'and it got brighter along the line');
  // half-opaque blue over red: a mix of both, so the clip underneath shows through
  const mix = px(await render((p) => { p.layers[0].clips.push({ id: 'c1', start: 0, duration: 2000, in: 0, src: 'blue.webm', opacity: 0.5 }, { id: 'c2', start: 0, duration: 2000, in: 0, src: 'red.webm' }); }), 1);
  assert.ok(mix[0] > 80 && mix[2] > 80, `the top clip (starts first) is half blue over red: ${mix}`);
});

test('parity: the numbers the preview plays equal what the render\'s own expressions give, at many moments, with every kind of line together', () => {
  const rnd = seeded(11);
  const gain = [P(0, 1), P(700, 0.2, 'ease-in'), P(1500, 2.5, 'hold'), P(2600, 0.6, 'ease-in-out'), P(4000, 1)];
  const mute = [P(0, 0, 'hold'), P(1200, 1, 'hold'), P(1800, 0.3), P(3000, 0)];
  const pan = [P(0, -1), P(1000, 0.4, 'ease-out'), P(2500, -0.7, 'hold'), P(3500, 1)];
  const p = sampleProject();
  const voiceLayer = p.layers.find((l) => l.id === 'voice');
  voiceLayer.gain = 0.7;
  voiceLayer.pan = 0.3;
  voiceLayer.clips[0].gain = 1.5;
  addLine(p, 'c2', 'gain', gain);
  addLine(p, 'c2', 'mute', mute);
  addLine(p, 'c2', 'pan', pan);
  const g = graphOf(p);
  const expr = (re, where) => { const m = re.exec(g.find(where)); assert.ok(m, `found ${re}`); return m[1]; };
  const volume = expr(/volume='([^']+)':eval=frame,adelay/, (x) => x.includes('[vc0]'));
  const left = expr(/^\[vc0L\]volume='([^']+)':eval=frame/, (x) => x.startsWith('[vc0L]'));
  const right = expr(/^\[vc0R\]volume='([^']+)':eval=frame/, (x) => x.startsWith('[vc0R]'));
  const points = { gain, mute, pan };
  for (let k = 0; k < 120; k++) {
    const ms = k < 8 ? k * 500 : Math.floor(rnd() * 5000);
    const want = audioMixAt(voiceLayer.clips[0], 'voice', voiceLayer, (param) => points[param], ms);
    const vars = { t: ms / 1000 };
    const tol = (v) => 0.003 + Math.abs(v) * 0.002;
    assert.ok(Math.abs(evalExpr(volume, vars) - want.gain) < tol(want.gain), `gain at ${ms} ms: render ${evalExpr(volume, vars)} vs preview ${want.gain}`);
    assert.ok(Math.abs(evalExpr(left, vars) - want.left) < tol(want.left), `left at ${ms} ms: render ${evalExpr(left, vars)} vs preview ${want.left}`);
    assert.ok(Math.abs(evalExpr(right, vars) - want.right) < tol(want.right), `right at ${ms} ms: render ${evalExpr(right, vars)} vs preview ${want.right}`);
  }
  // opacity, too: the render's alpha expression is the preview's opacity
  const op = [P(0, 0), P(1000, 1, 'ease-in-out'), P(2000, 0.3)];
  const q = lineProject((pp) => { pp.layers[0].clips[0].start = 1500; pp.layers[0].clips.push({ id: 'c9', start: 20000, duration: 1000, in: 0, src: 'demo.webm' }); addLine(pp, 'c1', 'opacity', op); });
  const a = /a='255\*clip\((.+),0,1\)'/.exec(graphOf(q).find((x) => x.includes('geq=')))[1];
  for (const ms of [0, 100, 500, 999, 1000, 1500, 2000, 4000]) {
    const T = (1500 + ms) / 1000; // the render's T is the timeline time; the line runs from the clip's own start
    const want = opacityAt({ id: 'c1' }, (param) => (param === 'opacity' ? op : undefined), ms);
    assert.ok(Math.abs(evalExpr(a, { T }) / 1 - want) < 0.003, `opacity at ${ms} ms: render ${evalExpr(a, { T })} vs preview ${want}`);
  }
});

// ---- speed

test('render plan: a clip at speed s reads duration * s of its source and is retimed onto the timeline; video, voice and music all follow; speed 1 changes nothing', () => {
  const plain = graphOf(sampleProject());
  const p = lineProject((q) => { q.layers[0].clips[0].speed = 2; q.layers[0].clips[0].duration = 2000; q.layers[1].clips[0].speed = 0.5; q.layers[1].clips[0].duration = 8000; q.layers[2].clips[0].speed = 4; q.layers[2].clips[0].duration = 2500; });
  const plan = buildRenderPlan(p, { slug: 'g' });
  const g = plan.args[plan.args.indexOf('-filter_complex') + 1].split(';');
  const inputsOf = () => { const out = []; plan.args.forEach((a, i) => { if (a === '-i') out.push(plan.args.slice(i - 4, i + 2)); }); return out; };
  const [v, voice, music] = inputsOf();
  assert.deepEqual(v.slice(0, 4), ['-ss', '0.000', '-t', '4.000'], 'a 2 s slot at 2x plays 4 s of source');
  assert.deepEqual(voice.slice(0, 4), ['-ss', '0.000', '-t', '4.000'], 'an 8 s slot at half speed plays 4 s of source');
  assert.deepEqual(music.slice(0, 4), ['-ss', '0.000', '-t', '10.000'], 'a 2.5 s slot at 4x plays 10 s of source');
  assert.ok(g.some((x) => x.startsWith('[0:v]setpts=(PTS-STARTPTS)/2+0.000/TB,')), 'the picture is compressed onto the timeline');
  assert.ok(g.some((x) => x.startsWith('[1:a]asetpts=PTS-STARTPTS,atempo=0.5,')), 'the voice is slowed by atempo');
  assert.ok(g.some((x) => x.startsWith('[2:a]asetpts=PTS-STARTPTS,atempo=2,atempo=2,')), 'a factor above 2 is split into steps every ffmpeg accepts');
  assert.ok(g.some((x) => x.includes('afade=t=out:st=1.000:d=1.250') || x.includes('afade=t=out')), 'the music fade is on the timeline clock, after the tempo change');
  assert.deepEqual(graphOf(lineProject((q) => { q.layers[0].clips[0].speed = 1; })), plain, 'an explicit 1 is the same graph as none');
  assert.equal(plan.durationMs, 8000, 'the project length is the longest slot on the timeline, not the source\'s length');
});

test('a real render: at 2x a clip plays its source twice as fast, ends at the retimed time, and the sound keeps up', real, async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-speed-'));
  const run = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: ws });
  // a 4 s source: red for 2 s, then blue for 2 s, with a tone all the way through
  run('-f', 'lavfi', '-i', 'color=c=red:size=64x36:rate=10:duration=2', '-f', 'lavfi', '-i', 'color=c=blue:size=64x36:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libvpx', '-c:a', 'libopus', 'two.webm');
  run('-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libopus', 'tone.opus');
  const px = (file, t) => { const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }); return [raw[0], raw[1], raw[2]]; };
  const render = async (fn) => {
    const p = blankProject({ name: 'sp', width: 64, height: 36, fps: 10 });
    fn(p);
    await renderProject({ project: p, workspace: ws, slug: 'sp', execFile: realExecFile, ffmpeg: FFMPEG });
    return path.join(ws, 'sp.export.webm');
  };
  const voiceLayer = (p) => p.layers.find((l) => l.kind === 'voice');
  const file = await render((p) => { p.layers[0].clips.push({ id: 'c1', start: 0, duration: 2000, in: 0, src: 'two.webm', speed: 2 }); voiceLayer(p).clips.push({ id: 'c2', start: 0, duration: 2000, in: 0, src: 'tone.opus', speed: 2 }); });
  const red = px(file, 0.5);
  const blue = px(file, 1.5);
  assert.ok(red[0] > 150 && red[2] < 100, `at 0.5 s it is still the red half: ${red}`);
  assert.ok(blue[2] > 150 && blue[0] < 100, `at 1.5 s (3 s into the source) it is the blue half: ${blue}`);
  const info = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const secs = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  assert.ok(Math.abs(secs - 2) < 0.25, `the export is 2 s long, not 4: ${secs}`);
  assert.ok(rms(file, { from: 1.5, len: 0.3 }) > -30, 'the tone, sped up, is still playing near the end');
});

// ---- zoom

test('zoomExpr agrees with the curve the preview uses (zoomAt), before, during and after the ramp, with and without a hold and a ramp of 0', () => {
  const cases = [
    { ...ZOOM_DEFAULT },
    { scale: 3, x: 0.2, y: 0.8, at: 1000, ramp: 800, hold: null },
    { scale: 1.5, x: 0.5, y: 0.5, at: 500, ramp: 400, hold: 1200 },
    { scale: 4, x: 0.5, y: 0.5, at: 700, ramp: 0, hold: null },
    { scale: 2, x: 0.5, y: 0.5, at: 700, ramp: 0, hold: 900 },
    { scale: 2, x: 0.5, y: 0.5, at: -300, ramp: 600, hold: null },
  ];
  for (const z of cases) {
    const expr = zoomExpr(z);
    for (let ms = -100; ms <= 6000; ms += 37) {
      const want = zoomAt(z, ms);
      const got = evalExpr(expr, { t: ms / 1000 });
      assert.ok(Math.abs(got - want) < 0.002, `${JSON.stringify(z)} at ${ms} ms: render ${got} vs preview ${want}`);
    }
  }
});

test('render plan: a zoom becomes a supersample and a zoompan after the framing, on the clip\'s own frame count; without a zoom the graph is unchanged', () => {
  const plain = graphOf(sampleProject());
  const g = graphOf(lineProject((p) => { p.layers[0].clips[0].start = 1500; p.layers[0].clips[0].zoom = { scale: 2, x: 0.25, y: 0.75, at: 500, ramp: 600, hold: null }; })).find((x) => x.includes('[v0]'));
  assert.match(g, /pad=1280:720:\(ow-iw\)\/2:\(oh-ih\)\/2,fps=30,scale=2560:1440,zoompan=z='\(1\+1\*\(/, 'the framed picture is doubled, then zoomed');
  assert.match(g, /x='clip\(0\.25\*iw-iw\/zoom\/2,0,iw-iw\/zoom\)':y='clip\(0\.75\*ih-ih\/zoom\/2,0,ih-ih\/zoom\)':d=1:s=1280x720:fps=30,setsar=1,setpts=PTS\+1\.500\/TB,fps=30,format=yuv420p/, 'the window is centred on the point and kept inside the frame');
  assert.match(g, /\(on\/30\)/, 'the curve runs on the clip\'s own frame count');
  assert.deepEqual(graphOf(lineProject((p) => { p.layers[0].clips[0].zoom = undefined; })), plain);
});

test('a real render: a zoom into the right edge shows the right half of the picture across the whole frame, and before the zoom starts the picture is untouched', real, async () => {
  const ws = fs.realpathSync(makeTempDir('studio-editor-zoom-'));
  const run = (...a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: ws });
  // left half red, right half blue
  run('-f', 'lavfi', '-i', 'color=c=red:size=32x36:rate=10:duration=3', '-f', 'lavfi', '-i', 'color=c=blue:size=32x36:rate=10:duration=3', '-filter_complex', '[0:v][1:v]hstack[v]', '-map', '[v]', '-c:v', 'libvpx', 'halves.webm');
  const px = (file, t, x) => { const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=6:6:${x}:15,scale=1:1`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }); return [raw[0], raw[1], raw[2]]; };
  const render = async (zoom) => {
    const p = blankProject({ name: 'zm', width: 64, height: 36, fps: 10 });
    p.layers[0].clips.push({ id: 'c1', start: 0, duration: 3000, in: 0, src: 'halves.webm', ...(zoom ? { zoom } : {}) });
    await renderProject({ project: p, workspace: ws, slug: 'zm', execFile: realExecFile, ffmpeg: FFMPEG });
    return path.join(ws, 'zm.export.webm');
  };
  const plain = await render(null);
  assert.ok(px(plain, 2.5, 8)[0] > 150, 'without a zoom the left quarter is red');
  const zoomed = await render({ scale: 2, x: 1, y: 0.5, at: 1000, ramp: 500, hold: null });
  const early = px(zoomed, 0.5, 8);
  assert.ok(early[0] > 150 && early[2] < 100, `before the zoom starts (0.5 s) the left quarter is still red: ${early}`);
  const late = px(zoomed, 2.5, 8);
  assert.ok(late[2] > 150 && late[0] < 100, `zoomed 2x into the right edge, the left quarter of the frame is the blue half: ${late}`);
  assert.ok(px(zoomed, 2.5, 52)[2] > 150, 'and the right quarter is blue too');
  // a clip that starts late and plays at 2x: the zoom's times are the timeline's, counted from the clip's own start
  const p2 = blankProject({ name: 'zm', width: 64, height: 36, fps: 10 });
  p2.layers[0].clips.push({ id: 'c1', start: 1000, duration: 1500, in: 0, src: 'halves.webm', speed: 2, zoom: { scale: 2, x: 1, y: 0.5, at: 500, ramp: 200, hold: null } });
  await renderProject({ project: p2, workspace: ws, slug: 'zm', execFile: realExecFile, ffmpeg: FFMPEG });
  const out2 = path.join(ws, 'zm.export.webm');
  const soon = px(out2, 1.25, 8);
  assert.ok(soon[0] > 150 && soon[2] < 100, `0.25 s into the clip, before its zoom (at 0.5 s): still the red half: ${soon}`);
  const later = px(out2, 2.3, 8);
  assert.ok(later[2] > 150 && later[0] < 100, `1.3 s into the clip, zoomed: the blue half: ${later}`);
});
