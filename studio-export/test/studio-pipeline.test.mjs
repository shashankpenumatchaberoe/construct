import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { ContainmentError, assertInside, runPipeline, voiceAvailability } from '../src/pipeline.mjs';
import { validateConfig } from '../src/models.mjs';
import { findFfmpeg, mediaDir } from '../src/resolve.mjs';
import { validateStoryboard } from '../src/storyboard.mjs';
import { fakePlaywright } from './studio-helpers.mjs';

const BASE = 'https://shop.example.com/';
const sb = () => validateStoryboard({ title: 'Tour', scenes: [{ caption: 'This is the shop.', steps: [{ action: 'goto', url: BASE }, { action: 'wait', ms: 100 }] }, { caption: 'And the end.', steps: [] }] }, { baseUrl: BASE }).storyboard;
const cfg = (extra = {}) => validateConfig(extra).config;
const workspace = () => makeTempDir('studio-ws-');

/** A stand-in for the media tools: records each run and writes the files the real tool would. */
function fakeTool() {
  const runs = [];
  const run = async (script, args, { env }) => {
    runs.push({ script: path.basename(script), args, env: { STUDIO_ROOT: env.STUDIO_ROOT, STUDIO_VIDEO_DIR: env.STUDIO_VIDEO_DIR } });
    const [slug, cmd] = args;
    const out = (name) => fs.writeFileSync(path.join(env.STUDIO_VIDEO_DIR, `${slug}${name}`), cmd);
    if (cmd === 'srt') out('.en.srt'); else if (cmd === 'vtt') out('.en.vtt'); else if (cmd === 'voice') { out('.voice.opus'); out('.voice.webm'); } else if (cmd === 'mix') out('.mixed.webm');
    return '';
  };
  return { runs, run };
}
const AVAILABLE = () => ({ available: true });

test('assertInside: inside is fine, .. and symlinks that leave are refused, missing children are judged by their parent', () => {
  const ws = workspace();
  const outside = makeTempDir('studio-outside-');
  fs.mkdirSync(path.join(ws, 'videos'));
  assert.equal(assertInside(ws, path.join(ws, 'videos', 'a.webm')), path.join(fs.realpathSync(ws), 'videos', 'a.webm'));
  assert.equal(assertInside(ws, ws), fs.realpathSync(ws));
  assert.throws(() => assertInside(ws, path.join(ws, '..', 'x')), ContainmentError);
  assert.throws(() => assertInside(ws, '/etc/passwd'), (e) => e.code === 'PATH_OUTSIDE_WORKSPACE');
  assert.throws(() => assertInside(ws, path.join(ws, 'videos', '..', '..', 'x')), ContainmentError);
  fs.symlinkSync(outside, path.join(ws, 'link'));
  assert.throws(() => assertInside(ws, path.join(ws, 'link', 'stolen.webm')), ContainmentError);
  fs.symlinkSync(path.join(outside, 'not-there'), path.join(ws, 'dangling'));
  assert.throws(() => assertInside(ws, path.join(ws, 'dangling')), /dangling/);
  // a sibling folder whose name starts with the workspace's name is not inside it
  const sibling = `${fs.realpathSync(ws)}-other`;
  assert.throws(() => assertInside(ws, path.join(sibling, 'x')), ContainmentError);
});

test('every stage runs in order, each emits events, outputs are bare names inside <workspace>/videos', async () => {
  const ws = workspace();
  const tool = fakeTool();
  const events = [];
  const r = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug: 'tour', onEvent: (e) => events.push(e), deps: { runTool: tool.run, mediaDir: '/fake/media', voiceAvailability: AVAILABLE } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(tool.runs.map((x) => `${x.script} ${x.args.slice(0, 2).join(' ')}`), ['script.mjs tour srt', 'script.mjs tour vtt', 'script.mjs tour voice']);
  assert.deepEqual(tool.runs[2].args, ['tour', 'voice', '--voice', 'af_heart']);
  const real = fs.realpathSync(ws);
  for (const x of tool.runs) assert.deepEqual(x.env, { STUDIO_ROOT: real, STUDIO_VIDEO_DIR: path.join(real, 'videos') });
  assert.deepEqual(r.stages, { record: { status: 'done' }, captions: { status: 'done' }, voice: { status: 'done' }, mix: { status: 'skipped', reason: 'no music file next to the video; the narrated video is the result' } });
  assert.deepEqual(r.files, { video: 'tour.webm', captions: 'tour.captions.json', srt: 'tour.en.srt', vtt: 'tour.en.vtt', voice: 'tour.voice.opus', voiced: 'tour.voice.webm' });
  assert.equal(r.final, 'tour.voice.webm');
  for (const name of Object.values(r.files)) assert.ok(fs.existsSync(path.join(real, 'videos', name)), name);
  assert.ok(fs.existsSync(path.join(real, 'videos', 'tour.storyboard.json')));
  const stages = events.map((e) => `${e.stage}:${e.type}`);
  for (const want of ['record:start', 'record:done', 'captions:start', 'captions:done', 'voice:start', 'voice:done', 'mix:skipped']) assert.ok(stages.includes(want), `${want} in ${stages.join(' ')}`);
  assert.ok(stages.indexOf('record:done') < stages.indexOf('captions:start') && stages.indexOf('captions:done') < stages.indexOf('voice:start'));
});

test('with a music file next to the video the mix stage runs and the mixed file is the result', async () => {
  const ws = workspace();
  const tool = fakeTool();
  const pre = async (script, args, opts) => { if (args[1] === 'voice') fs.writeFileSync(path.join(opts.env.STUDIO_VIDEO_DIR, `${args[0]}.music.mp3`), 'm'); return tool.run(script, args, opts); };
  const r = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug: 'tour', deps: { runTool: pre, mediaDir: '/fake/media', voiceAvailability: AVAILABLE } });
  assert.equal(r.stages.mix.status, 'done');
  assert.equal(r.final, 'tour.mixed.webm');
  assert.equal(tool.runs.at(-1).args[1], 'mix');
});

test('voice-over is skipped with a reason when TTS is not available; the video is still the result', async () => {
  const ws = workspace();
  const tool = fakeTool();
  const events = [];
  const r = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug: 'tour', onEvent: (e) => events.push(e), deps: { runTool: tool.run, mediaDir: '/fake/media', voiceAvailability: () => ({ available: false, reason: 'ffmpeg was not found' }) } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.stages.voice, { status: 'skipped', reason: 'ffmpeg was not found' });
  assert.deepEqual(r.stages.mix, { status: 'skipped', reason: 'there is no narration to mix' });
  assert.equal(r.final, 'tour.webm');
  assert.ok(events.some((e) => e.stage === 'voice' && e.type === 'skipped' && e.reason === 'ffmpeg was not found'));
  assert.equal(tool.runs.some((x) => x.args[1] === 'voice'), false);
});

test('each stage is optional', async () => {
  const ws = workspace();
  const tool = fakeTool();
  const r = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug: 'tour', stages: { captions: false, voice: false, mix: false }, deps: { runTool: tool.run, mediaDir: '/fake/media', voiceAvailability: AVAILABLE } });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.fromEntries(Object.entries(r.stages).map(([k, v]) => [k, v.status])), { record: 'done', captions: 'skipped', voice: 'skipped', mix: 'skipped' });
  assert.equal(tool.runs.length, 0);
  // record:false re-runs later stages on an existing recording, and fails clearly when there is none
  const later = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: null, slug: 'tour', stages: { record: false, voice: false }, deps: { runTool: tool.run, mediaDir: '/fake/media' } });
  assert.equal(later.ok, true);
  assert.equal(later.stages.captions.status, 'done');
  const none = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: null, slug: 'ghost', stages: { record: false }, deps: { runTool: tool.run, mediaDir: '/fake/media' } });
  assert.equal(none.ok, false);
  assert.equal(none.stages.record.status, 'failed');
});

test('a failing tool fails its stage, not the whole run', async () => {
  const ws = workspace();
  const r = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug: 'tour', deps: { mediaDir: '/fake/media', voiceAvailability: AVAILABLE, runTool: async (s, args) => { if (args[1] === 'voice') throw new Error('script.mjs voice exited 1: kokoro-js is not installed'); return ''; } } });
  assert.equal(r.ok, true);
  assert.equal(r.stages.voice.status, 'failed');
  assert.match(r.stages.voice.reason, /kokoro-js/);
  assert.equal(r.final, 'tour.webm');
});

test('a failed recording fails the run and still reports the partial video', async () => {
  const ws = workspace();
  const clicky = validateStoryboard({ title: 'T', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: BASE }, { action: 'click', selector: '#nope' }] }] }, { baseUrl: BASE }).storyboard;
  const tool = fakeTool();
  const r = await runPipeline({ storyboard: clicky, workspace: ws, config: cfg(), playwright: fakePlaywright({ failOn: 'click' }).playwright, slug: 'tour', deps: { mediaDir: '/fake/media', runTool: tool.run, voiceAvailability: AVAILABLE } });
  assert.equal(r.ok, false);
  assert.equal(r.stages.record.status, 'failed');
  assert.equal(r.error.code, 'RECORD_STEP_FAILED');
  assert.equal(r.final, 'tour.webm', 'the partial video is kept');
  assert.equal(tool.runs.length, 0, 'no later stage runs after a failed recording');
});

test('containment: a videos folder that is a symlink out of the workspace is refused before anything is written', async () => {
  const ws = workspace();
  const outside = makeTempDir('studio-outside-');
  fs.symlinkSync(outside, path.join(ws, 'videos'));
  await assert.rejects(runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug: 'tour', deps: { mediaDir: null } }), ContainmentError);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a bad slug never reaches a path', async () => {
  const ws = workspace();
  for (const slug of ['../x', 'a/b', '', 'A B', '-x']) {
    if (slug === '') continue;
    await assert.rejects(runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug, deps: { mediaDir: null } }), /bad slug/);
  }
});

test('voiceAvailability names what is missing, without running anything', () => {
  const tools = '/fake/media';
  const ffmpegless = { PATH: '', HOME: os.homedir() };
  assert.match(voiceAvailability(cfg(), { env: ffmpegless, tools }).reason, /ffmpeg was not found/);
  assert.match(voiceAvailability(cfg(), { env: ffmpegless, tools: null }).reason, /media tools were not found/);
  const dir = makeTempDir('studio-bin-');
  const ff = path.join(dir, 'ffmpeg');
  fs.writeFileSync(ff, '#!/bin/sh\n', { mode: 0o755 });
  const env = { PATH: dir, CONSTRUCT_MEDIA_CACHE: path.join(dir, 'cache') };
  assert.equal(findFfmpeg(env), ff);
  assert.match(voiceAvailability(cfg(), { env, tools }).reason, /kokoro-js is not installed/);
  fs.mkdirSync(path.join(dir, 'cache', 'node_modules', 'kokoro-js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cache', 'node_modules', 'kokoro-js', 'package.json'), '{}');
  assert.equal(voiceAvailability(cfg(), { env, tools }).available, true);
  assert.match(voiceAvailability(cfg({ tts: { backend: 'chatterbox' } }), { env, tools }).reason, /voiceSample/);
  assert.equal(voiceAvailability(cfg({ tts: { backend: 'cmd', ttsCmd: 'x {out}' } }), { env, tools }).available, true);
});

test('the real media tool builds subtitles inside the workspace (STUDIO_ROOT / STUDIO_VIDEO_DIR), nothing outside', { skip: mediaDir() ? false : 'media tools not found' }, async () => {
  const ws = workspace();
  const repoVideos = path.resolve(mediaDir(), '..', '..', '..', 'site', 'assets', 'video');
  const list = () => (fs.existsSync(repoVideos) ? fs.readdirSync(repoVideos) : []);
  const before = new Set(list());
  const r = await runPipeline({ storyboard: sb(), workspace: ws, config: cfg(), playwright: fakePlaywright().playwright, slug: 'tour', stages: { voice: false, mix: false } });
  assert.equal(r.ok, true, JSON.stringify(r.stages));
  assert.equal(r.stages.captions.status, 'done', r.stages.captions.reason);
  const srt = fs.readFileSync(path.join(fs.realpathSync(ws), 'videos', 'tour.en.srt'), 'utf8');
  assert.match(srt, /This is the shop\./);
  assert.match(fs.readFileSync(path.join(fs.realpathSync(ws), 'videos', 'tour.en.vtt'), 'utf8'), /^WEBVTT/);
  const after = new Set(list());
  assert.deepEqual([...after].filter((x) => !before.has(x)), [], 'nothing was written into the repository');
});
