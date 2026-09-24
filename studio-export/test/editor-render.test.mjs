// Render plan (a deterministic ffmpeg argument array), subtitle export, containment of outputs, the run with an injected execFile,
// and one real ffmpeg render when ffmpeg exists on this machine (FFMPEG=/path or `ffmpeg` on the PATH), skipped with a message otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as realExecFile, execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { ERR, blankProject } from '../src/editor/project.mjs';
import { buildRenderPlan, exportSubtitles, renderProject } from '../src/editor/render.mjs';
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
