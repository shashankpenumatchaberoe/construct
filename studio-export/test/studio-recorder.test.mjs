import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { RECORDER_ERR, RecorderError, createTimeline, recordStoryboard } from '../src/recorder.mjs';
import { loadPlaywright, mediaDir } from '../src/resolve.mjs';
import { validateStoryboard } from '../src/storyboard.mjs';
import { fakePlaywright, staticSite } from './studio-helpers.mjs';

const BASE = 'https://shop.example.com/';
const storyboard = () => validateStoryboard({
  title: 'Tour',
  scenes: [
    { caption: 'This is the shop.', steps: [{ action: 'goto', url: BASE }, { action: 'wait', ms: 200 }] },
    { caption: 'Fill in a name and say hello.', steps: [{ action: 'fill', selector: '#name', text: 'Ada' }, { action: 'click', selector: '#go' }, { action: 'hover', selector: '#go' }, { action: 'press', key: 'Tab' }, { action: 'highlight', selector: '#out', label: 'The greeting', ms: 300 }] },
    { caption: 'Scroll down.', steps: [{ action: 'scroll', dy: 500 }, { action: 'scroll', to: 'bottom' }, { action: 'scroll', selector: 'h2' }, { action: 'caption', text: 'An extra line.' }, { action: 'card', title: 'The end', subtitle: 'Thanks' }] },
  ],
}, { baseUrl: BASE }).storyboard;

const CONFIG = { allowPrivateNetwork: false, recording: { width: 800, height: 600, pace: 1, burnCaptions: true } };
const actions = (calls) => calls.filter((c) => ['goto', 'fill', 'click', 'hover', 'press', 'scrollIntoView'].includes(c[0])).map((c) => c.slice(0, 3).join(' ').trim());

test('actions run in order, one context per run, recordVideo on, everything closed', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright();
  const events = [];
  const r = await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fake.playwright, onEvent: (e) => events.push(e), slug: 'tour', now: () => fake.clock.t });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(actions(fake.calls), ['goto https://shop.example.com/', 'fill #name Ada', 'click #go', 'hover #go', 'press Tab', 'scrollIntoView h2']);
  assert.equal(fake.calls.filter((c) => c[0] === 'newContext').length, 1);
  const ctx = fake.calls.find((c) => c[0] === 'newContext')[1];
  assert.deepEqual(ctx.viewport, { width: 800, height: 600 });
  assert.equal(ctx.recordVideo.size.width, 800);
  assert.ok(ctx.recordVideo.dir.startsWith(dir));
  assert.deepEqual(fake.calls.filter((c) => /close/.test(c[0])).map((c) => c[0]), ['page.close', 'context.close', 'browser.close']);
  // the outputs
  assert.equal(path.basename(r.video), 'tour.webm');
  assert.equal(fs.readFileSync(r.video, 'utf8'), 'fake-webm');
  assert.equal(path.basename(r.captions), 'tour.captions.json');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['tour.captions.json', 'tour.webm'], 'the temp recording folder is gone');
  // the request guard is installed because private networks are off
  assert.ok(fake.calls.some((c) => c[0] === 'route'));
});

test('the captions timeline: every caption and card, in order, seconds from the start, the media pipeline shape', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright();
  const r = await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fake.playwright, slug: 'tour', now: () => fake.clock.t });
  const lines = JSON.parse(fs.readFileSync(r.captions, 'utf8'));
  assert.deepEqual(lines.map((l) => l.text), ['This is the shop.', 'Fill in a name and say hello.', 'Scroll down.', 'An extra line.', 'The end. Thanks']);
  assert.deepEqual(lines.map((l) => l.id), ['l01', 'l02', 'l03', 'l04', 'l05']);
  for (const l of lines) assert.ok(Number.isFinite(l.start) && l.start >= 0 && l.end > l.start, JSON.stringify(l));
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start > lines[i - 1].start, 'strictly increasing starts');
  assert.ok(lines[1].start >= 3.3, `the first caption is held for its reading time (3 s minimum), got ${lines[1].start}`);
  // the file is exactly what packages/tools/media reads: normalize() accepts it and keeps ids and times
  const media = mediaDir();
  assert.ok(media, 'the media tools are found (vendor/media or packages/tools/media)');
  const { normalize } = await import(pathToFileURL(path.join(media, 'lib.mjs')).href);
  const norm = normalize(lines);
  assert.deepEqual(norm.map((l) => [l.id, l.text, l.start]), lines.map((l) => [l.id, l.text, l.start]));
});

test('the event stream: start, scene, step start/done pairs, captions, done', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright();
  const events = [];
  await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fake.playwright, onEvent: (e) => events.push(e), slug: 'tour', now: () => fake.clock.t });
  assert.ok(events.every((e) => e.stage === 'record'));
  assert.equal(events[0].type, 'start');
  assert.deepEqual({ scenes: events[0].scenes, steps: events[0].steps }, { scenes: 3, steps: 12 });
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).video, 'tour.webm');
  assert.equal(events.filter((e) => e.type === 'scene').length, 3);
  const steps = events.filter((e) => e.type === 'step');
  assert.equal(steps.length, 24, 'a start and a done for each of the 12 steps');
  assert.deepEqual(steps.filter((e) => e.done).map((e) => e.index), [...Array(12).keys()].map((i) => i + 1));
  assert.equal(events.filter((e) => e.type === 'caption').length, 5);
  // an observer that throws does not break the recording
  const r = await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fakePlaywright().playwright, onEvent: () => { throw new Error('observer bug'); }, slug: 'again', now: () => 0 });
  assert.equal(r.ok, true);
});

test('a failing step stops the run, keeps the video so far, names the step and closes the browser', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright({ failOn: 'click' });
  const events = [];
  const r = await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fake.playwright, onEvent: (e) => events.push(e), slug: 'broken', now: () => fake.clock.t });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, RECORDER_ERR.STEP_FAILED);
  assert.deepEqual(r.error.step, { index: 4, action: 'click' });
  assert.match(r.error.message, /step 4 \(click\) failed: Timeout/);
  assert.equal(r.error.message.includes('\n'), false, 'only the first line of a Playwright error');
  assert.ok(fs.existsSync(path.join(dir, 'broken.webm')));
  assert.ok(fs.existsSync(path.join(dir, 'broken.captions.json')));
  assert.ok(fake.calls.some((c) => c[0] === 'browser.close'));
  assert.equal(events.at(-1).type, 'error');
});

test('an unvalidated storyboard is never recorded', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright();
  const bad = { title: 'x', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: 'file:///etc/passwd' }] }] };
  await assert.rejects(recordStoryboard({ storyboard: bad, outDir: dir, config: CONFIG, playwright: fake.playwright }), (e) => e instanceof RecorderError && e.code === RECORDER_ERR.INVALID_STORYBOARD && e.errors[0].code === 'URL_SCHEME');
  const evil = { title: 'x', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: BASE }, { action: 'eval', code: 'process.exit()' }] }] };
  await assert.rejects(recordStoryboard({ storyboard: evil, outDir: dir, config: CONFIG, playwright: fake.playwright }), (e) => e.code === RECORDER_ERR.INVALID_STORYBOARD);
  await assert.rejects(recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fake.playwright, slug: '../escape' }), (e) => e.code === RECORDER_ERR.BAD_SLUG);
  assert.equal(fake.calls.length, 0, 'the browser was never started');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the request guard aborts local and private requests unless allowPrivateNetwork is on', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright();
  await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fake.playwright, slug: 'g1', now: () => 0 });
  const verdict = (url) => { let out = null; fake.routeHandler({ request: () => ({ url: () => url }), abort: (why) => { out = `abort:${why}`; }, continue: () => { out = 'continue'; } }); return out; };
  assert.equal(verdict('https://cdn.example.com/a.js'), 'continue');
  assert.equal(verdict('http://169.254.169.254/latest/meta-data/'), 'abort:blockedbyclient');
  assert.equal(verdict('http://localhost:3000/admin'), 'abort:blockedbyclient');
  assert.equal(verdict('http://192.168.1.10/'), 'abort:blockedbyclient');
  assert.equal(verdict('data:image/png;base64,AAAA'), 'continue');
  const open = fakePlaywright();
  const sb = validateStoryboard({ title: 't', scenes: [{ caption: 'c', steps: [{ action: 'goto', url: 'http://127.0.0.1:9/' }] }] }, { allowPrivateNetwork: true }).storyboard;
  await recordStoryboard({ storyboard: sb, outDir: dir, config: { ...CONFIG, allowPrivateNetwork: true }, playwright: open.playwright, slug: 'g2', now: () => 0 });
  assert.equal(open.calls.some((c) => c[0] === 'route'), false);
});

test('no Chromium: a typed error that says how to install it', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright({ launchError: "browserType.launch: Executable doesn't exist at /x/chrome\nRun playwright install" });
  const r = await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fake.playwright, slug: 'nob', now: () => 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, RECORDER_ERR.NO_BROWSER);
  assert.match(r.error.message, /npx playwright install chromium/);
});

test('burnCaptions off draws no caption bar; a cancelled signal stops the run', async () => {
  const dir = makeTempDir('studio-rec-');
  const fake = fakePlaywright();
  await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: { ...CONFIG, recording: { ...CONFIG.recording, burnCaptions: false } }, playwright: fake.playwright, slug: 'quiet', now: () => fake.clock.t });
  assert.equal(fake.calls.filter((c) => c[0] === 'evaluate' && Array.isArray(c[2]) && c[2][0] === 'This is the shop.').length, 0);
  const ac = new AbortController();
  ac.abort();
  const cancelled = await recordStoryboard({ storyboard: storyboard(), outDir: dir, config: CONFIG, playwright: fakePlaywright().playwright, slug: 'stop', signal: ac.signal, now: () => 0 });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, RECORDER_ERR.ABORTED);
});

test('createTimeline: ids, ends capped at reading time and before the next start', () => {
  let t = 0;
  const tl = createTimeline(() => t);
  tl.stamp('one'); t = 1500; tl.stamp('two'); t = 9000; tl.stamp('three');
  const out = tl.toJSON(12);
  assert.deepEqual(out.map((l) => [l.id, l.start, l.end]), [['l01', 0, 1.4], ['l02', 1.5, 4.5], ['l03', 9, 12]]);
});

// ---------------------------------------------------------------------------------------------- one real run
let realPlaywright = null;
let skipReason = '';
try {
  realPlaywright = await loadPlaywright();
  const b = await realPlaywright.chromium.launch({ headless: true });
  await b.close();
} catch (e) {
  skipReason = `no Chromium available (${String(e.message).split('\n')[0]}); install with: npx playwright install chromium`;
}

test('REAL browser: records a local static page to .webm with a captions timeline', { skip: skipReason || false, timeout: 120000 }, async () => {
  const site = await staticSite();
  const dir = makeTempDir('studio-real-');
  try {
    const sb = validateStoryboard({
      title: 'Real run',
      scenes: [
        { caption: 'This is the test shop.', steps: [{ action: 'goto', url: site.url }, { action: 'wait', ms: 300 }] },
        { caption: 'Type a name and say hello.', steps: [{ action: 'fill', selector: '#name', text: 'Ada' }, { action: 'click', selector: '#go' }, { action: 'highlight', selector: '#out', label: 'The greeting', ms: 500 }] },
        { caption: 'Now the about page.', steps: [{ action: 'click', selector: 'a[href="/about"]' }, { action: 'wait', ms: 300 }, { action: 'card', title: 'The end', subtitle: 'Thanks', ms: 800 }] },
      ],
    }, { baseUrl: site.url, allowPrivateNetwork: true }).storyboard;
    const events = [];
    const r = await recordStoryboard({ storyboard: sb, outDir: dir, config: { allowPrivateNetwork: true, recording: { width: 640, height: 400, pace: 0.25, burnCaptions: true } }, playwright: realPlaywright, onEvent: (e) => events.push(e), slug: 'real' });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const head = fs.readFileSync(r.video).subarray(0, 4);
    assert.deepEqual([...head], [0x1a, 0x45, 0xdf, 0xa3], 'a WebM (EBML) file');
    assert.ok(fs.statSync(r.video).size > 2000);
    const lines = JSON.parse(fs.readFileSync(r.captions, 'utf8'));
    assert.deepEqual(lines.map((l) => l.text), ['This is the test shop.', 'Type a name and say hello.', 'Now the about page.', 'The end. Thanks']);
    assert.ok(lines.every((l, i) => i === 0 || l.start > lines[i - 1].start));
    assert.ok(site.hits.includes('/about'), 'the click really navigated');
    assert.equal(events.at(-1).type, 'done');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['real.captions.json', 'real.webm']);
  } finally { await site.close(); }
});
