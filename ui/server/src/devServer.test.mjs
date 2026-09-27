// #378 — the dev server as a managed process, through the REAL route table and real child processes: it starts
// only when asked, runs the project's own script, reaches "running", stops (and leaves nothing listening), is
// refused outside the workspace, reports a busy port, stops on Close project and Sign out, and tells a Cockpit
// session branch from any other. The fixture app binds a throwaway port (47300+), never one of the Cockpit's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';

const sandbox = makeTempDir('devsrv-');
process.env.CONSTRUCT_WORKSPACE_ROOT = path.join(sandbox, 'ws');
process.env.CONSTRUCT_STATE_DIR = path.join(sandbox, 'state');
process.env.CONSTRUCT_DEV_SERVER_PORT_BASE = '47300';
fs.mkdirSync(process.env.CONSTRUCT_WORKSPACE_ROOT);
delete process.env.CONSTRUCT_GITHUB_CLIENT_ID;
delete process.env.CONSTRUCT_GITHUB_CLIENT_SECRET;
delete process.env.CONSTRUCT_E2E_PROJECT_DIR;
process.env.CONSTRUCT_SESSION_SECRET = 'must-not-reach-project-code';

const { app, devServer } = await import('./index.mjs');
const { workspaceRoot } = await import('./workspace.mjs');
const { parseLocalPort, looksLikePortBusy, busyPortFrom, readDevCommand, findFreePort, RESERVED_PORTS, nonLoopbackAddresses } = await import('./devServer.mjs');

// The fixture app: serves marker.txt (read on every request, so a checkout is visible without a restart) and
// prints what a real dev server prints. It reports which Cockpit secrets it can see.
const FIXTURE_SERVER = `import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.env.PORT);
const srv = http.createServer((q, r) => r.end(fs.readFileSync('marker.txt', 'utf8')));
srv.on('error', (e) => { console.error(e.message); process.exit(1); });
srv.listen(port, '127.0.0.1', () => {
  console.log('secret:' + (process.env.CONSTRUCT_SESSION_SECRET ?? 'none') + ' host:' + process.env.HOST);
  console.log('  Local:   http://localhost:' + port + '/');
});
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
`;

// #557: the same fixture, but bound to every interface (what a framework that ignores the Cockpit's HOST/HOSTNAME
// env does, Next.js's own default) so the LAN-reachability probe has something to actually find.
const FIXTURE_SERVER_ALL_INTERFACES = `import http from 'node:http';
const port = Number(process.env.PORT);
const srv = http.createServer((q, r) => r.end('all-interfaces'));
srv.on('error', (e) => { console.error(e.message); process.exit(1); });
srv.listen(port, '0.0.0.0', () => {
  console.log('  Local:   http://localhost:' + port + '/');
});
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
`;

let server;
let base;
let ws;
let projectDir;

const git = (...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: projectDir, encoding: 'utf8' });
const call = (method, url, body, headers = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const status = async () => (await call('GET', '/api/dev-server')).json();
const until = async (fn, ms = 20_000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const setPackage = (scripts) => fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0', scripts }));
const openProject = (dir) => call('POST', '/api/settings', { projectDir: dir });
const listening = (port) => new Promise((resolve) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  ws = workspaceRoot();
  projectDir = path.join(ws, 'app');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'architecture.yml'), 'version: 1\n');
  fs.writeFileSync(path.join(projectDir, 'server.mjs'), FIXTURE_SERVER);
  fs.writeFileSync(path.join(projectDir, 'marker.txt'), 'main-marker');
  setPackage({ dev: 'node server.mjs' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

after(async () => {
  await devServer.stopAll();
  server.close();
});

test('pure helpers: dev wins over start, a missing script is a refusal, addresses and busy ports are recognised', () => {
  const root = makeTempDir('devsrv-pure-');
  assert.equal(readDevCommand(root).refusal.code, 'NO_DEV_SCRIPT', 'no package.json');
  fs.writeFileSync(path.join(root, 'package.json'), '{ not json');
  assert.equal(readDevCommand(root).refusal.code, 'NO_DEV_SCRIPT', 'unreadable package.json');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js' } }));
  assert.deepEqual(readDevCommand(root), { script: 'start', text: 'node app.js', display: 'npm run start' });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: 'node app.js', dev: 'vite' } }));
  assert.deepEqual(readDevCommand(root), { script: 'dev', text: 'vite', display: 'npm run dev' });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: '  ' } }));
  assert.equal(readDevCommand(root).refusal.code, 'NO_DEV_SCRIPT', 'a blank script is not a script');

  assert.equal(parseLocalPort('  ➜  Local:   http://localhost:5173/'), 5173);
  assert.equal(parseLocalPort('- Local: http://127.0.0.1:3005'), 3005);
  assert.equal(parseLocalPort('ready on http://[::1]:8080'), 8080);
  assert.equal(parseLocalPort('proxying https://example.com:9000'), null, 'only local addresses count');
  assert.equal(looksLikePortBusy('Error: listen EADDRINUSE: address already in use :::5173'), true);
  assert.equal(looksLikePortBusy('Port 5173 is in use, trying another one...'), true);
  assert.equal(looksLikePortBusy('compiled successfully'), false);
  assert.equal(busyPortFrom('Error: listen EADDRINUSE: address already in use 127.0.0.1:5173'), 5173);
  assert.equal(busyPortFrom('Port 5199 is in use, trying another one...'), 5199);
  assert.equal(busyPortFrom('compiled successfully'), null);
});

test('findFreePort skips a busy port and never returns one the Cockpit reserves', async () => {
  // The blocker binds port 0 (OS-assigned) rather than a hardcoded number: on this dev machine an
  // unrelated long-lived process can hold a fixed port like 47500 as an ephemeral source port, which
  // caused a false EADDRINUSE failure here (#729).
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busyPort = blocker.address().port;
  try {
    assert.equal(await findFreePort(busyPort), busyPort + 1);
  } finally {
    blocker.close();
  }
  // A reserved port is skipped even when it looks free (tested on a throwaway number, not on a real one).
  assert.equal(await findFreePort(47700, { reserved: [47700, 47701] }), 47702);
  for (const p of [80, 443, 3000, 4000]) assert.ok(RESERVED_PORTS.includes(p), `${p} is never handed out`);
});

test('with no project open there is nothing to start: a refusal, never the server\'s own cwd', async () => {
  const s = await status();
  assert.equal(s.state, 'not-running');
  assert.equal(s.refusal.code, 'NO_PROJECT');
  const r = await call('POST', '/api/dev-server/start', {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'NO_PROJECT');
});

test('opening a project starts nothing: it shows the exact command and stays not-running', async () => {
  await openProject('app');
  const s = await status();
  assert.equal(s.state, 'not-running');
  assert.equal(s.refusal, null);
  assert.deepEqual(s.command, { script: 'dev', text: 'node server.mjs', display: 'npm run dev' });
  assert.equal(s.pid, null);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await status()).state, 'not-running', 'nothing starts on its own');
});

test('a foreign browser Origin cannot start or stop it', async () => {
  const r = await call('POST', '/api/dev-server/start', {}, { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  assert.equal((await call('POST', '/api/dev-server/stop', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await status()).state, 'not-running');
});

test('start runs the project\'s own script and reaches running; the app answers on 127.0.0.1; output reaches the Logs', async () => {
  const started = await call('POST', '/api/dev-server/start', {});
  assert.equal(started.status, 202);
  assert.equal((await started.json()).state, 'starting');
  const running = await until(async () => { const s = await status(); return s.state === 'running' ? s : null; }, 30_000, 'running');
  assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(running.port >= 47300 && !RESERVED_PORTS.includes(running.port));
  assert.ok(running.pid > 0);
  assert.equal(await (await fetch(running.url)).text(), 'main-marker');
  assert.equal(running.networkWarning, null, 'a server that only bound 127.0.0.1 is not reachable from the network (#557)');

  const logs = await (await call('GET', '/api/logs')).json();
  const text = logs.entries.filter((e) => e.source === 'dev-server').map((e) => e.text).join('\n');
  assert.match(text, /Starting npm run dev \(node server\.mjs\)/);
  assert.match(text, /Local: +http:\/\/localhost:\d+\//, 'the server\'s own output is streamed');
  assert.match(text, /Dev server is running at http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(text, /host:127\.0\.0\.1/, 'HOST is handed to the server');
  assert.match(text, /secret:none/, 'the Cockpit\'s own secrets never reach project code');
});

test('a second start is refused while one runs', async () => {
  const r = await call('POST', '/api/dev-server/start', {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'ALREADY_RUNNING');
});

test('branch provenance: a Cockpit session branch is "session", anything else is "other"; the running server sees the checked-out files', async () => {
  assert.equal((await status()).branch, 'main');
  assert.equal((await status()).branchKind, 'other');
  const { url } = await status();

  // Cockpit creates its session branch by `git checkout -b` in the project's own working tree (autoCommit.mjs).
  git('checkout', '-q', '-b', 'cockpit/billing-invoice-layer-a3f7');
  fs.writeFileSync(path.join(projectDir, 'marker.txt'), 'session-marker');
  git('commit', '-q', '-am', 'session change');
  const s = await status();
  assert.equal(s.branch, 'cockpit/billing-invoice-layer-a3f7');
  assert.equal(s.branchKind, 'session');
  assert.equal(s.state, 'running');
  assert.equal(await (await fetch(url)).text(), 'session-marker', 'same working tree, no copy, no sync step');

  git('checkout', '-q', '-b', 'feature/hand-made');
  assert.equal((await status()).branchKind, 'other');
  git('checkout', '-q', 'cockpit/billing-invoice-layer-a3f7');
  assert.equal((await status()).branchKind, 'session');
});

test('restart replaces the process and comes back running', async () => {
  const before = await status();
  const r = await call('POST', '/api/dev-server/restart', {});
  assert.equal(r.status, 202);
  const after = await until(async () => { const s = await status(); return s.state === 'running' && s.pid !== before.pid ? s : null; }, 30_000, 'restart');
  assert.ok(!alive(before.pid), 'the old process is gone');
  assert.equal(await (await fetch(after.url)).text(), 'session-marker');
});

test('stop ends the process, frees the port and returns to not-running', async () => {
  const running = await status();
  const stopped = await (await call('POST', '/api/dev-server/stop', {})).json();
  assert.equal(stopped.state, 'not-running');
  await until(() => !alive(running.pid), 8000, 'process to exit');
  assert.equal(await listening(running.port), false, 'nothing is left listening');
  const logs = await (await call('GET', '/api/logs')).json();
  assert.ok(logs.entries.some((e) => e.source === 'dev-server' && /stopped/i.test(e.text)));
});

test('Close project stops a running dev server', async () => {
  await call('POST', '/api/dev-server/start', {});
  const running = await until(async () => { const s = await status(); return s.state === 'running' ? s : null; }, 30_000, 'running');
  const closed = await (await call('POST', '/api/settings', { closeProject: true })).json();
  assert.equal(closed.projectDir, null);
  await until(() => !alive(running.pid), 10_000, 'process to exit after Close project');
  assert.equal(await listening(running.port), false);
  await openProject('app');
  assert.equal((await status()).state, 'not-running');
});

test('Sign out stops a running dev server', async () => {
  await call('POST', '/api/dev-server/start', {});
  const running = await until(async () => { const s = await status(); return s.state === 'running' ? s : null; }, 30_000, 'running');
  const out = await call('POST', '/auth/logout', {});
  assert.equal(out.status, 200);
  await until(() => !alive(running.pid), 10_000, 'process to exit after Sign out');
  assert.equal(await listening(running.port), false);
  assert.equal((await status()).state, 'not-running');
});

test('port busy: an explicit port that is taken is refused with a free suggestion, and Stop dismisses it', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(47600, '127.0.0.1', r));
  try {
    const r = await call('POST', '/api/dev-server/start', { port: 47600 });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.code, 'PORT_BUSY');
    assert.equal(body.state, 'failed');
    assert.equal(body.failure.kind, 'port-busy');
    assert.equal(body.failure.port, 47600);
    assert.equal(body.failure.suggestedPort, 47601);
    assert.equal(body.pid, null, 'nothing was spawned');

    // "Use port 47601": the suggestion is a normal start with that port.
    const again = await call('POST', '/api/dev-server/start', { port: body.failure.suggestedPort });
    assert.equal(again.status, 202);
    const running = await until(async () => { const s = await status(); return s.state === 'running' ? s : null; }, 30_000, 'running on the suggestion');
    assert.equal(running.port, 47601);
    await call('POST', '/api/dev-server/stop', {});
  } finally {
    blocker.close();
  }
  assert.equal((await status()).state, 'not-running');
});

test('port busy is also recognised from the server\'s own output when it exits at once', async () => {
  setPackage({ dev: 'node -e "console.error(\'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173\');process.exit(1)"' });
  await call('POST', '/api/dev-server/start', {});
  const failed = await until(async () => { const s = await status(); return s.state === 'failed' ? s : null; }, 30_000, 'failed');
  assert.equal(failed.failure.kind, 'port-busy');
  assert.match(failed.failure.message, /in use by another process/);
  assert.ok(Number.isInteger(failed.failure.suggestedPort));
  await call('POST', '/api/dev-server/stop', {});
});

test('a server that dies before it is ready is "failed" with what it said; a bad port is refused', async () => {
  setPackage({ dev: 'node -e "console.error(\'Error: Cannot find module vite\');process.exit(3)"' });
  await call('POST', '/api/dev-server/start', {});
  const failed = await until(async () => { const s = await status(); return s.state === 'failed' ? s : null; }, 30_000, 'failed');
  assert.equal(failed.failure.kind, 'exited');
  assert.equal(failed.failure.code, 3);
  assert.match(failed.failure.message, /Cannot find module vite/);
  await call('POST', '/api/dev-server/stop', {});
  for (const port of [80, 3000, 4000, 22, 70000, 'abc']) {
    const r = await call('POST', '/api/dev-server/start', { port });
    assert.equal(r.status, 400, String(port));
    assert.equal((await r.json()).code, 'BAD_PORT');
  }
  assert.equal((await status()).state, 'not-running');
});

test('a server bound to every interface produces the LAN-reachable warning (#557); one on 127.0.0.1 only did not', async (t) => {
  if (nonLoopbackAddresses().length === 0) { t.skip('no non-loopback address on this machine to prove reachability with'); return; }
  fs.writeFileSync(path.join(projectDir, 'server.mjs'), FIXTURE_SERVER_ALL_INTERFACES);
  setPackage({ dev: 'node server.mjs' });
  await call('POST', '/api/dev-server/start', {});
  const running = await until(async () => { const s = await status(); return s.state === 'running' && s.networkWarning ? s : null; }, 30_000, 'the network warning');
  assert.match(running.networkWarning, /^This server is also reachable from your network: .+:\d+$/);
  await call('POST', '/api/dev-server/stop', {});

  // the earlier fixture, which binds only 127.0.0.1, never gets the warning (already asserted once above; a
  // second, adjacent proof that switching the bind address is what flips it, not something stuck from before)
  fs.writeFileSync(path.join(projectDir, 'server.mjs'), FIXTURE_SERVER);
  await call('POST', '/api/dev-server/start', {});
  await until(async () => { const s = await status(); return s.state === 'running' ? s : null; }, 30_000, 'running');
  await new Promise((r) => setTimeout(r, 400)); // let the (negative) network probe finish before checking it stayed null
  assert.equal((await status()).networkWarning, null);
  await call('POST', '/api/dev-server/stop', {});
});

test('a project with no dev or start script is refused with a reason', async () => {
  setPackage({ build: 'echo hi' });
  const s = await status();
  assert.equal(s.refusal.code, 'NO_DEV_SCRIPT');
  assert.equal(s.command, null);
  const r = await call('POST', '/api/dev-server/start', {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'NO_DEV_SCRIPT');
});

test('a project whose root is outside the workspace is refused: nothing runs, and the reason says so', async () => {
  setPackage({ dev: 'node server.mjs' });
  await call('POST', '/api/settings', { closeProject: true });
  fs.writeFileSync(path.join(sandbox, 'architecture.yml'), 'version: 1\n'); // the sandbox is the PARENT of the workspace
  fs.mkdirSync(path.join(ws, 'inner'));
  fs.writeFileSync(path.join(ws, 'inner', 'package.json'), JSON.stringify({ scripts: { dev: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"' } }));
  await call('POST', '/api/settings', { projectDir: 'inner' });
  const s = await status();
  assert.equal(s.refusal.code, 'PROJECT_ROOT_OUTSIDE_WORKSPACE');
  const r = await call('POST', '/api/dev-server/start', {});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'PROJECT_ROOT_OUTSIDE_WORKSPACE');
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(fs.existsSync(path.join(ws, 'inner', 'ran.txt')), false, 'the script never ran');
  assert.equal(fs.existsSync(path.join(sandbox, 'ran.txt')), false);
});
