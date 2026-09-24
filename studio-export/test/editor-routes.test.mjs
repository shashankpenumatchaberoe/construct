// The editor's HTTP routes on a throwaway port (48500-48599), behind a tiny server that does what server.mjs will: hand
// /editor and /api/editor/* to the default export.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { bundleModules } from '../src/editor/page.mjs';
import { ERR } from '../src/editor/project.mjs';
import defaultHandler, { createEditorHandler, revFromHeader } from '../src/editor/routes.mjs';
import { sampleProject, writeSampleWorkspace } from '../src/editor/sample.mjs';
import { VENDOR_DIR, sha256 } from '../src/editor/vendor-ui.mjs';

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

async function start(handler, workspace) {
  const server = http.createServer((req, res) => {
    handler(req, res, { workspace, url: new URL(req.url, 'http://localhost') }).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end('not the editor'); }
    }, () => { res.statusCode = 500; res.end('handler threw'); });
  });
  for (let port = 48500; port < 48600; port++) {
    const ok = await new Promise((resolve) => { server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => resolve(true)); });
    if (ok) { servers.push(server); return { base: `http://127.0.0.1:${port}`, port, server }; }
  }
  throw new Error('no free port in 48500-48599');
}

/** A workspace with the sample job and project, a handler (fake ffmpeg, fast autosave) and a server. */
async function setup({ withProject = true, execFile } = {}) {
  const ws = fs.realpathSync(makeTempDir('studio-editor-routes-'));
  writeSampleWorkspace(ws, { withProject });
  const calls = [];
  const fake = execFile || ((cmd, args, opts, cb) => {
    if (!opts?.cwd) { cb(new Error('no ffprobe here'), '', ''); return undefined; }
    calls.push({ cmd, args, opts });
    const child = { stdout: new EventEmitter() };
    setImmediate(() => {
      child.stdout.emit('data', 'out_time_us=5000000\nprogress=continue\n');
      fs.writeFileSync(path.join(opts.cwd, args.at(-1)), 'rendered');
      cb(null, '', '');
    });
    return child;
  });
  const handler = createEditorHandler({ execFile: fake, autosaveDelayMs: 20 });
  const srv = await start(handler, ws);
  const call = async (method, url, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] = init.headers['content-type'] || 'application/json'; }
    const res = await fetch(srv.base + url, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { ws, handler, calls, call, ...srv, start: (h) => start(h, ws) };
}
const api = '/api/editor';
const ops = (call, slug, op, args, rev) => call('POST', `${api}/project/${slug}/ops`, { op, args, rev });

test('the default export is a handler; a path that is not the editor is not handled', async () => {
  assert.equal(typeof defaultHandler, 'function');
  assert.equal(revFromHeader('3'), 3);
  assert.equal(revFromHeader('W/"12"'), 12);
  assert.equal(revFromHeader('x'), undefined);
  const { call } = await setup();
  const r = await call('GET', '/api/other');
  assert.equal(r.status, 404);
  assert.equal(r.text, 'not the editor');
  assert.equal((await call('GET', '/editorial')).text, 'not the editor');
});

test('GET /editor serves one self-contained page: modules and vendored script inlined, a CSP that allows exactly those scripts, nothing else under /api/editor/ui', async () => {
  const { call } = await setup();
  const page = await call('GET', '/editor');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /<title>[^<]+<\/title>/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp) && !/script-src[^;]*\*/.test(csp), 'no blanket script allowance');
  const scripts = [...page.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2, 'the vendored timeline script and the module bundle');
  assert.deepEqual(scripts.map((m) => /type="module"/.test(m[1])), [false, true]);
  for (const [, attrs, code] of scripts) {
    assert.ok(!/\bsrc=/.test(attrs), 'no script is fetched by URL (the access-token gate cannot serve a bare <script src>)');
    assert.ok(csp.includes(`'sha256-${crypto.createHash('sha256').update(code).digest('base64')}'`), 'each inline script is allowed by its hash');
  }
  const bundle = scripts[1][2];
  assert.match(bundle, /function createTimeline/);
  assert.ok(!/^import\s/m.test(bundle) && !/^export\s/m.test(bundle), 'imports and exports are resolved');
  assert.ok(!/<link[^>]+stylesheet|<script[^>]+src=/.test(page.text));
  assert.ok(Buffer.byteLength(page.text) < 800 * 1024, 'a light page');
  assert.equal((await call('GET', '/editor/')).status, 200);
  assert.equal((await call('HEAD', '/editor')).text, '');
  assert.equal((await call('POST', '/editor', {})).status, 405);
  for (const bad of ['app.mjs', 'vendor/vis-timeline.min.js', '..%2Froutes.mjs']) assert.notEqual((await call('GET', `${api}/ui/${bad}`)).status, 200, bad);
});

test('bundleModules joins modules in dependency order, drops imports and exports, and refuses forms it cannot resolve', () => {
  const dir = fs.realpathSync(makeTempDir('studio-editor-bundle-'));
  fs.writeFileSync(path.join(dir, 'a.mjs'), "import { b } from './b.mjs';\nexport const a = () => b();\nexport async function run() { return a(); }\n");
  fs.writeFileSync(path.join(dir, 'b.mjs'), "import { c } from './c.mjs';\nexport function b() { return c; }\n");
  fs.writeFileSync(path.join(dir, 'c.mjs'), 'export const c = 1;\n');
  const out = bundleModules(dir, 'a.mjs');
  assert.deepEqual([...out.matchAll(/\/\/ ---- (\w)\.mjs/g)].map((m) => m[1]), ['c', 'b', 'a']);
  assert.ok(!/\bimport\b|^export\b/m.test(out));
  assert.match(out, /const a = \(\) => b\(\);/);
  assert.match(out, /async function run/);
  fs.writeFileSync(path.join(dir, 'bad.mjs'), "import x from 'https://evil.example/x.mjs';\n");
  assert.throws(() => bundleModules(dir, 'bad.mjs'), /only single-line/);
  fs.writeFileSync(path.join(dir, 'bad2.mjs'), 'const q = 1;\nexport { q };\n');
  assert.throws(() => bundleModules(dir, 'bad2.mjs'), /unsupported export/);
  fs.writeFileSync(path.join(dir, 'bad3.mjs'), "import { z } from './../escape.mjs';\n");
  assert.throws(() => bundleModules(dir, 'bad3.mjs'), /only single-line/);
  assert.throws(() => bundleModules(dir, '../x.mjs'), /outside the ui folder/);
});

test('projects: list, create blank, create from a job, collision 409, bad names 400; sources list jobs and media', async () => {
  const { call } = await setup({ withProject: false });
  assert.deepEqual((await call('GET', `${api}/projects`)).json.projects, []);
  const src = (await call('GET', `${api}/sources`)).json;
  assert.deepEqual(src.jobs.map((j) => j.slug), ['demo']);
  assert.deepEqual(src.media, ['demo.music.mp3', 'demo.voice.opus', 'demo.webm']);
  const made = await call('POST', `${api}/projects`, { name: 'Quick demo' });
  assert.equal(made.status, 201);
  assert.deepEqual([made.json.slug, made.json.rev], ['quick-demo', 1]);
  assert.equal((await call('POST', `${api}/projects`, { name: 'Quick demo' })).json.code, ERR.EXISTS);
  assert.equal((await call('POST', `${api}/projects`, { name: 'x', from: '../demo' })).status, 400);
  assert.equal((await call('POST', `${api}/projects`, { name: 'x', from: 'gone' })).json.code, ERR.NO_VIDEO);
  assert.equal((await call('POST', `${api}/projects`, { slug: '../../etc/x' })).json.code, ERR.BAD_SLUG);
  const list = (await call('GET', `${api}/projects`)).json.projects;
  assert.deepEqual(list.map((p) => [p.slug, p.name, p.counts.video]), [['quick-demo', 'Quick demo', 0]]);
  assert.equal((await call('GET', `${api}/method`, undefined)).status, 404);
  assert.equal((await call('DELETE', `${api}/projects`)).status, 405);
});

test('GET project loads it; with only a job of that name it builds the project from the job (no ffprobe: length from the captions)', async () => {
  const { call, ws } = await setup({ withProject: false });
  fs.writeFileSync(path.join(ws, 'demo.captions.json'), JSON.stringify([{ text: 'Hello', start: 1 }]));
  const r = await call('GET', `${api}/project/demo`);
  assert.equal(r.status, 200);
  assert.equal(r.json.project.layers[3].clips[0].text, 'Hello');
  assert.deepEqual([r.json.rev, r.json.dirty, r.json.canUndo, r.json.canRedo], [1, false, false, false]);
  assert.ok(fs.existsSync(path.join(ws, 'demo.studio.json')));
  assert.equal((await call('GET', `${api}/project/nothing`)).status, 404);
});

test('PUT saves with the rev; a stale rev is 409 with the current copy; If-Match works; invalid is 422; a missing rev is 400', async () => {
  const { call } = await setup();
  const loaded = (await call('GET', `${api}/project/demo`)).json;
  const edited = structuredClone(loaded.project);
  edited.layers[3].clips[0].text = 'saved text';
  const ok = await call('PUT', `${api}/project/demo`, { project: edited, rev: loaded.rev });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.rev, 2);
  assert.equal(ok.json.project.layers[3].clips[0].text, 'saved text');
  const stale = await call('PUT', `${api}/project/demo`, { project: edited, rev: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, ERR.STALE_REV);
  assert.equal(stale.json.current.rev, 2, 'the current copy rides along');
  assert.equal(stale.json.current.layers[3].clips[0].text, 'saved text');
  const viaHeader = await call('PUT', `${api}/project/demo`, { project: edited }, { 'if-match': '"2"' });
  assert.equal(viaHeader.json.rev, 3);
  assert.equal((await call('PUT', `${api}/project/demo`, { project: edited })).json.code, ERR.REV_REQUIRED);
  const bad = structuredClone(edited);
  bad.layers[0].clips[0].src = '../../etc/passwd';
  const rej = await call('PUT', `${api}/project/demo`, { project: bad, rev: 3 });
  assert.deepEqual([rej.status, rej.json.code], [422, ERR.BAD_SRC]);
  assert.equal((await call('PUT', `${api}/project/demo`, { rev: 3 })).status, 400);
});

test('ops: the only way to edit; needs the rev; a stale rev is 409; errors are typed 422; undo and redo; a restarted server answers NO_SESSION', async () => {
  const { call, ws, handler } = await setup();
  const first = (await call('GET', `${api}/project/demo`)).json;
  assert.equal((await ops(call, 'demo', 'splitClip', { clipId: 'c1', atMs: 4000 })).json.code, ERR.REV_REQUIRED);
  const split = await ops(call, 'demo', 'splitClip', { clipId: 'c1', atMs: 4000 }, first.rev);
  assert.equal(split.status, 200);
  assert.equal(split.json.newClipId, 'c6');
  assert.deepEqual([split.json.dirty, split.json.canUndo, split.json.canRedo], [true, true, false]);
  assert.equal(split.json.project.layers[0].clips.length, 2);
  assert.equal(split.json.project.layers[0].clips[1].in, 4000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'demo.studio.json'), 'utf8')).layers[0].clips.length, 1, 'an op does not save');
  const stale = await ops(call, 'demo', 'deleteClip', { clipId: 'c6' }, 99);
  assert.deepEqual([stale.status, stale.json.code], [409, ERR.STALE_REV]);
  assert.equal(stale.json.current.layers[0].clips.length, 2);
  const locked = await ops(call, 'demo', 'setLayerFlag', { layerId: 'video', flag: 'locked', value: true }, first.rev);
  const refused = await ops(call, 'demo', 'splitClip', { clipId: 'c6', atMs: 6000 }, first.rev);
  assert.deepEqual([locked.status, refused.status, refused.json.code], [200, 422, ERR.LOCKED]);
  assert.equal((await ops(call, 'demo', 'formatDisk', {}, first.rev)).json.code, ERR.UNKNOWN_OP);
  assert.equal((await ops(call, 'demo', 'splitClip', 'nope', first.rev)).json.code, ERR.BAD_ARG);
  assert.equal((await call('POST', `${api}/project/demo/ops`, { args: {}, rev: first.rev })).json.code, ERR.UNKNOWN_OP);
  const undo1 = await ops(call, 'demo', 'undo', undefined, first.rev);
  assert.equal(undo1.json.project.layers[0].locked, false, 'undo walks back over the lock');
  const undo2 = await ops(call, 'demo', 'undo', undefined, first.rev);
  assert.equal(undo2.json.project.layers[0].clips.length, 1);
  assert.equal(undo2.json.dirty, false, 'back at the saved copy is not dirty');
  assert.equal((await ops(call, 'demo', 'undo', undefined, first.rev)).json.code, ERR.NOTHING_TO_UNDO);
  const redo = await ops(call, 'demo', 'redo', undefined, first.rev);
  assert.equal(redo.json.project.layers[0].clips.length, 2);
  assert.equal((await ops(call, 'demo', 'redo', undefined, first.rev)).json.code, undefined, 'redo of the lock');
  assert.equal((await ops(call, 'demo', 'redo', undefined, first.rev)).json.code, ERR.NOTHING_TO_REDO);
  handler.close();
  const after = await ops(call, 'demo', 'splitClip', { clipId: 'c1', atMs: 100 }, first.rev);
  assert.deepEqual([after.status, after.json.code], [409, ERR.NO_SESSION], 'the page must GET the project again');
  assert.equal(after.json.current.rev, 1);
});

test('autosave writes a recovery copy after edits; the next open offers it; restore makes it the (unsaved) working copy; discard clears it; a save clears it', async () => {
  const { call, ws, handler, start: restart } = await setup();
  const first = (await call('GET', `${api}/project/demo`)).json;
  await ops(call, 'demo', 'setSubtitleText', { clipId: 'c4', text: 'typed but not saved' }, first.rev);
  handler.flush();
  const auto = path.join(ws, 'demo.studio.autosave.json');
  assert.ok(fs.existsSync(auto), 'the recovery copy exists');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'demo.studio.json'), 'utf8')).layers[3].clips[0].text, 'Hello there, this is Studio', 'the saved file is untouched');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(auto, future, future);
  // a new server process (no sessions) opens the project
  const s2 = await restart(createEditorHandler({ autosaveDelayMs: 20 }));
  const get = async (p) => (await fetch(s2.base + p)).json();
  const reopened = await get(`${api}/project/demo`);
  assert.deepEqual(reopened.recover && Object.keys(reopened.recover), ['updatedAt'], 'offered, not applied');
  assert.equal(reopened.project.layers[3].clips[0].text, 'Hello there, this is Studio');
  const peek = await get(`${api}/project/demo/autosave`);
  assert.equal(peek.project.layers[3].clips[0].text, 'typed but not saved');
  const post = (p, body) => fetch(s2.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const restored = await post(`${api}/project/demo/ops`, { op: 'restoreAutosave', rev: reopened.rev });
  assert.equal(restored.project.layers[3].clips[0].text, 'typed but not saved');
  assert.equal(restored.dirty, true, 'restored, still to be saved');
  assert.equal(restored.canUndo, true);
  const saved = await (await fetch(`${s2.base}${api}/project/demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: restored.project, rev: restored.rev }) })).json();
  assert.equal(saved.dirty, false);
  assert.ok(!fs.existsSync(auto), 'a save clears the recovery copy');
  fs.writeFileSync(auto, JSON.stringify(sampleProject()));
  const discard = await fetch(`${s2.base}${api}/project/demo/autosave`, { method: 'DELETE' });
  assert.equal(discard.status, 200);
  assert.ok(!fs.existsSync(auto));
  assert.equal((await fetch(`${s2.base}${api}/project/demo/autosave`)).status, 404);
});

test('rename, duplicate, delete-to-trash, export and import over HTTP, each with its guard', async () => {
  const { call, ws } = await setup();
  const dup = await call('POST', `${api}/project/demo/duplicate`, {});
  assert.deepEqual([dup.status, dup.json.slug], [201, 'demo-copy']);
  const clash = await call('PATCH', `${api}/project/demo/rename`, { to: 'demo-copy', rev: 1 });
  assert.deepEqual([clash.status, clash.json.code], [409, ERR.EXISTS]);
  assert.equal((await call('PATCH', `${api}/project/demo/rename`, { to: '../up', rev: 1 })).json.code, ERR.BAD_SLUG);
  assert.equal((await call('PATCH', `${api}/project/demo/rename`, { to: 'fresh-name', rev: 4 })).json.code, ERR.STALE_REV);
  const renamed = await call('PATCH', `${api}/project/demo/rename`, { to: 'fresh-name' }, { 'if-match': '1' });
  assert.equal(renamed.json.slug, 'fresh-name');
  assert.ok(fs.existsSync(path.join(ws, 'fresh-name.studio.json')) && !fs.existsSync(path.join(ws, 'demo.studio.json')));
  assert.equal((await call('GET', `${api}/projects`)).json.projects.some((p) => p.slug === 'demo'), false);
  const noConfirm = await call('DELETE', `${api}/project/fresh-name`, undefined, { 'if-match': '2' });
  assert.equal(noConfirm.json.code, ERR.CONFIRM_REQUIRED);
  assert.equal((await call('DELETE', `${api}/project/fresh-name?confirm=fresh-name`)).json.code, ERR.REV_REQUIRED);
  assert.equal((await call('DELETE', `${api}/project/fresh-name?confirm=fresh-name`, undefined, { 'if-match': '1' })).json.code, ERR.STALE_REV);
  const del = await call('DELETE', `${api}/project/fresh-name?confirm=fresh-name`, undefined, { 'if-match': '2' });
  assert.equal(del.status, 200);
  assert.match(del.json.trashed, /^fresh-name\..*\.studio\.json$/);
  assert.ok(fs.existsSync(path.join(ws, '.trash', del.json.trashed)), 'moved, not erased');
  const exported = await call('GET', `${api}/project/demo-copy/export`);
  assert.match(exported.headers.get('content-disposition'), /demo-copy\.studio-bundle\.json/);
  assert.ok(!exported.text.includes(ws));
  const imp = await call('POST', `${api}/projects/import`, { bundle: exported.json, name: 'Imported one' });
  assert.deepEqual([imp.status, imp.json.slug, imp.json.missing], [201, 'imported-one', []]);
  const evil = structuredClone(exported.json);
  evil.media.push({ name: '../../etc/passwd', present: true });
  assert.equal((await call('POST', `${api}/projects/import`, { bundle: evil })).json.code, ERR.BAD_BUNDLE);
  const evil2 = structuredClone(exported.json);
  evil2.project.layers[0].clips[0].src = '/etc/passwd';
  assert.equal((await call('POST', `${api}/projects/import`, { bundle: evil2 })).json.code, ERR.BAD_BUNDLE);
});

test('no route accepts a filesystem path: slugs, file names, ids, bodies and headers are all checked', async () => {
  const { call } = await setup();
  for (const slug of ['..%2Fdemo', '%2e%2e', '..', 'a%2Fb', 'a%5Cb', '%00', '.hidden', 'x'.repeat(70), '%2Fetc%2Fpasswd']) {
    for (const [m, sub] of [['GET', ''], ['GET', '/export'], ['GET', '/autosave'], ['POST', '/duplicate'], ['POST', '/render']]) {
      const r = await call(m, `${api}/project/${slug}${sub}`, m === 'POST' ? {} : undefined);
      assert.ok([400, 404].includes(r.status), `${m} ${slug}${sub} -> ${r.status}`);
      assert.notEqual(r.json?.ok, true);
    }
  }
  for (const file of ['..%2Fdemo.webm', '%2e%2e%2fdemo.webm', '%2Fetc%2Fpasswd', 'demo.studio.json', 'demo.captions.json', '.env', 'noext', 'x'.repeat(200)]) assert.equal((await call('GET', `${api}/media/${file}`)).status === 200, false, file);
  assert.equal((await call('GET', `${api}/jobs/..%2F..%2Fx/events`)).status, 400);
  assert.equal((await call('GET', `${api}/jobs/zzzzzzzzzzzz/events`)).json.code, ERR.NO_SUCH_JOB);
  const first = (await call('GET', `${api}/project/demo`)).json;
  const smuggled = structuredClone(first.project);
  smuggled.layers[0].clips[0].path = '/etc/passwd';
  assert.equal((await call('PUT', `${api}/project/demo`, { project: smuggled, rev: first.rev })).json.code, ERR.UNKNOWN_FIELD);
  assert.equal((await ops(call, 'demo', 'addClip', { layerId: 'video', src: '../../etc/passwd', start: 0, duration: 1000 }, first.rev)).json.code, ERR.BAD_ARG);
  assert.equal((await ops(call, 'demo', 'addClip', { layerId: 'video', src: '/etc/passwd', start: 20000, duration: 1000 }, first.rev)).json.code, ERR.BAD_ARG);
  assert.equal((await call('POST', `${api}/project/demo/ops`, '{"op":"undo"', { 'content-type': 'application/json' })).json.code, ERR.BAD_BODY);
  assert.equal((await call('POST', `${api}/project/demo/ops`, '[1]')).json.code, ERR.BAD_BODY);
  assert.equal((await call('POST', `${api}/project/demo/ops`, 'op=undo', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('POST', `${api}/projects`, { name: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
  assert.equal((await call('POST', `${api}/projects`, { name: 'from another site' }, { origin: 'https://evil.example' })).json.code, ERR.FOREIGN_ORIGIN);
  assert.equal((await call('GET', `${api}/projects`, undefined, { origin: 'https://evil.example' })).status, 200, 'reads are not blocked by origin; writes are');
});

test('media: workspace files with Range support (206, suffix, open-ended, 416), HEAD, and only media extensions', async () => {
  const { call, ws, base } = await setup();
  const text = '0123456789'.repeat(100);
  fs.writeFileSync(path.join(ws, 'clip.webm'), text);
  fs.mkdirSync(path.join(ws, 'videos'));
  fs.writeFileSync(path.join(ws, 'videos', 'inside.opus'), 'opus bytes');
  fs.writeFileSync(path.join(ws, 'demo.srt'), '1\n');
  const full = await call('GET', `${api}/media/clip.webm`);
  assert.deepEqual([full.status, full.headers.get('content-type'), full.headers.get('accept-ranges'), full.headers.get('content-length'), full.text.length], [200, 'video/webm', 'bytes', '1000', 1000]);
  const r1 = await call('GET', `${api}/media/clip.webm`, undefined, { range: 'bytes=10-19' });
  assert.deepEqual([r1.status, r1.text, r1.headers.get('content-range'), r1.headers.get('content-length')], [206, '0123456789', 'bytes 10-19/1000', '10']);
  const r2 = await call('GET', `${api}/media/clip.webm`, undefined, { range: 'bytes=995-' });
  assert.deepEqual([r2.status, r2.text, r2.headers.get('content-range')], [206, '56789', 'bytes 995-999/1000']);
  const r3 = await call('GET', `${api}/media/clip.webm`, undefined, { range: 'bytes=-4' });
  assert.deepEqual([r3.status, r3.text, r3.headers.get('content-range')], [206, '6789', 'bytes 996-999/1000']);
  const r4 = await call('GET', `${api}/media/clip.webm`, undefined, { range: 'bytes=990-5000' });
  assert.deepEqual([r4.status, r4.headers.get('content-range')], [206, 'bytes 990-999/1000'], 'an end past the file is clamped');
  for (const bad of ['bytes=2000-', 'bytes=5-2', 'bytes=-', 'items=0-1']) {
    const r = await call('GET', `${api}/media/clip.webm`, undefined, { range: bad });
    assert.deepEqual([r.status, r.headers.get('content-range')], [416, 'bytes */1000'], bad);
  }
  assert.equal((await call('GET', `${api}/media/clip.webm`, undefined, { range: 'bytes=0-1,5-6' })).status, 200, 'multi-range falls back to the whole file');
  const head = await fetch(`${base}${api}/media/clip.webm`, { method: 'HEAD' });
  assert.deepEqual([head.status, head.headers.get('content-length'), (await head.text()).length], [200, '1000', 0]);
  assert.equal((await call('GET', `${api}/media/inside.opus`)).text, 'opus bytes', 'videos/ is searched');
  assert.equal((await call('GET', `${api}/media/demo.srt`)).headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal((await call('GET', `${api}/media/missing.webm`)).status, 404);
});

/** Read a server-sent-event stream until the server closes it; returns the parsed `data:` events. */
async function events(base, id) {
  const res = await fetch(`${base}${api}/jobs/${id}/events`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  return (await res.text()).split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
}

test('render: renders the SAVED project; unsaved edits are 409; progress arrives as server-sent events; outputs land in the workspace', async () => {
  const { call, ws, calls, base } = await setup();
  const first = (await call('GET', `${api}/project/demo`)).json;
  const edited = await ops(call, 'demo', 'setSubtitleText', { clipId: 'c4', text: 'unsaved words' }, first.rev);
  const unsaved = await call('POST', `${api}/project/demo/render`, {});
  assert.deepEqual([unsaved.status, unsaved.json.code], [409, ERR.UNSAVED]);
  assert.equal(calls.length, 0);
  const saved = await call('PUT', `${api}/project/demo`, { project: edited.json.project, rev: edited.json.rev });
  assert.equal(saved.json.dirty, false);
  const started = await call('POST', `${api}/project/demo/render`, { burnSubtitles: false });
  assert.equal(started.status, 202);
  assert.match(started.json.id, /^[a-f0-9]{12}$/);
  const got = await events(base, started.json.id);
  assert.deepEqual(got.map((e) => e.type), ['start', 'progress', 'done']);
  assert.equal(got[1].pct, 50);
  assert.deepEqual(got[2].outputs, ['demo.export.webm', 'demo.srt', 'demo.vtt']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.cwd, ws);
  assert.match(fs.readFileSync(path.join(ws, 'demo.srt'), 'utf8'), /unsaved words/, 'the saved edit is what was rendered');
  assert.ok(fs.existsSync(path.join(ws, 'demo.export.webm')));
  const late = await events(base, started.json.id);
  assert.deepEqual(late.map((e) => e.type), ['start', 'progress', 'done'], 'a late listener gets the history and the stream ends');
  const burn = await call('POST', `${api}/project/demo/render`, { burnSubtitles: true });
  await events(base, burn.json.id);
  assert.ok(calls[1].args.join(' ').includes('subtitles=demo.srt'));
  assert.ok((await call('GET', `${api}/media/demo.export.webm`)).status === 200, 'the export can be played back through the media route');
});

test('render: one at a time (RENDER_BUSY), and an ffmpeg failure is an error event, then the slot is free again', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const execFile = (cmd, args, opts, cb) => {
    n++;
    const child = { stdout: new EventEmitter() };
    if (n === 1) gate.then(() => { fs.writeFileSync(path.join(opts.cwd, args.at(-1)), 'x'); cb(null, '', ''); });
    else setImmediate(() => cb(new Error('boom'), '', 'Unknown encoder libvpx-vp9'));
    return child;
  };
  const { call, base } = await setup({ execFile });
  await call('GET', `${api}/project/demo`);
  const one = await call('POST', `${api}/project/demo/render`, {});
  const two = await call('POST', `${api}/project/demo/render`, {});
  assert.deepEqual([two.status, two.json.code], [409, ERR.RENDER_BUSY]);
  release();
  await events(base, one.json.id);
  const three = await call('POST', `${api}/project/demo/render`, {});
  assert.equal(three.status, 202);
  const failed = await events(base, three.json.id);
  assert.equal(failed.at(-1).type, 'error');
  assert.equal(failed.at(-1).code, ERR.RENDER_FAILED);
  assert.match(failed.at(-1).message, /Unknown encoder/);
  const four = await call('POST', `${api}/project/demo/render`, {});
  assert.equal(four.status, 202, 'the slot is free after a failure');
  await events(base, four.json.id);
});

test('the vendored browser file is carried by the page, matches its recorded hash, ships its licences, and nothing loads from a CDN', async () => {
  const info = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'VERSION.json'), 'utf8'));
  assert.deepEqual([info.name, info.version, info.license], ['vis-timeline', '8.5.4', '(Apache-2.0 OR MIT)']);
  for (const [name, hash] of Object.entries(info.files)) assert.equal(sha256(path.join(VENDOR_DIR, name)), hash, `${name} is unmodified`);
  assert.ok(fs.statSync(path.join(VENDOR_DIR, 'vis-timeline.min.js')).size < 700 * 1024, 'stays a lightweight download');
  const { call } = await setup();
  const vendored = fs.readFileSync(path.join(VENDOR_DIR, 'vis-timeline.min.js'), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  assert.ok((await call('GET', '/editor')).text.includes(vendored.slice(0, 2000)), 'the vendored script is what the page carries');
  const uiDir = path.join(path.dirname(VENDOR_DIR));
  for (const f of ['editor.html', 'editor.css', 'app.mjs', 'api.mjs', 'dom.mjs', 'player.mjs', 'projects.mjs', 'timeline.mjs']) {
    const text = fs.readFileSync(path.join(uiDir, f), 'utf8');
    assert.ok(!/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(text.replace(/<!--[\s\S]*?-->/g, '')), `${f} references no external host`);
    assert.ok(!/\binnerHTML\b|\beval\(/.test(text.replace(/\/\/.*$/gm, '')), `${f} never builds markup from strings`);
  }
  const notice = fs.readFileSync(new URL('../NOTICE-editor.md', import.meta.url), 'utf8');
  for (const name of ['vis-timeline', 'vis-data', 'vis-util', 'moment', '@egjs/hammerjs', 'propagating-hammerjs', 'component-emitter', 'keycharm', 'uuid', 'xss', 'subtitle']) assert.ok(notice.includes(`| ${name}`), `${name} is in NOTICE-editor.md`);
  for (const f of ['LICENSE-vis-timeline-MIT.txt', 'LICENSE-vis-timeline-Apache-2.0.txt']) assert.ok(fs.existsSync(path.join(VENDOR_DIR, f)));
});
