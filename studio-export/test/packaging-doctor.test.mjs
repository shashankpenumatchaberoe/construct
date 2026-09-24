// `studio doctor` and the `studio` command line, with injected probes: no ffmpeg, browser or Ollama needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { DEFAULT_OLLAMA_URL, findOllamaUrl, onPath, pingOllama, resolveOllamaUrl, runDoctor } from '../bin/doctor.mjs';
import { main, parseArgs } from '../bin/cli.mjs';

const allOk = { node: () => '22.14.0', ffmpeg: () => true, ffprobe: () => true, chromium: () => true, ollama: () => true, python: () => true, kokoro: () => true };
const only = (over) => ({ ...allOk, ...over });
const byId = (r, id) => r.results.find((x) => x.id === id);

test('doctor: everything present is ready, exit 0, no fix lines', async () => {
  const r = await runDoctor({ probes: allOk, platform: 'linux', cwd: makeTempDir('studio-doc-') });
  assert.equal(r.exitCode, 0);
  assert.equal(r.results.length, 7);
  assert.ok(r.results.every((x) => x.ok && x.fix === undefined));
  assert.equal(r.lines.at(-1), 'ready');
  assert.ok(!r.lines.some((l) => l.includes('fix:')));
});

test('doctor: each missing required item gives its own fix line and exit 1', async () => {
  const cwd = makeTempDir('studio-doc-');
  const cases = [
    ['ffmpeg', { ffmpeg: () => false }, 'sudo apt install ffmpeg'],
    ['ffprobe', { ffprobe: () => false }, 'sudo apt install ffmpeg'],
    ['chromium', { chromium: () => false }, 'npx playwright install chromium'],
    ['node', { node: () => '18.19.0' }, 'nvm install 20'],
  ];
  for (const [id, over, fix] of cases) {
    const r = await runDoctor({ probes: only(over), platform: 'linux', cwd });
    assert.equal(r.exitCode, 1, id);
    assert.equal(byId(r, id).ok, false);
    assert.equal(byId(r, id).required, true);
    assert.ok(byId(r, id).fix.includes(fix), `${id}: ${byId(r, id).fix}`);
    assert.ok(r.lines.some((l) => l.startsWith('MISSING')), id);
    assert.ok(r.lines.some((l) => l.trim() === `fix: ${byId(r, id).fix}`), `${id} fix line printed`);
    assert.match(r.lines.at(-1), /1 required item\(s\) missing/);
  }
  const none = await runDoctor({ probes: { node: () => '19.0.0', ffmpeg: () => false, ffprobe: () => false, chromium: () => false, ollama: () => true, python: () => true, kokoro: () => true }, cwd });
  assert.match(none.lines.at(-1), /4 required item\(s\) missing: node, ffmpeg, ffprobe, playwright chromium/);
});

test('doctor: only optional items missing (Ollama, kokoro-js, python3) still exits 0 and prints their fixes', async () => {
  const r = await runDoctor({ probes: only({ ollama: () => false, kokoro: () => false, python: () => false }), platform: 'linux', cwd: makeTempDir('studio-doc-') });
  assert.equal(r.exitCode, 0);
  assert.equal(r.lines.filter((l) => l.startsWith('optional')).length, 3);
  assert.ok(byId(r, 'ollama').fix.includes('ollama serve'));
  assert.ok(byId(r, 'kokoro').fix.includes('npm i kokoro-js'));
  assert.ok(byId(r, 'python').fix.includes('python3'));
  assert.match(r.lines.at(-1), /^ready \(3 optional item\(s\) missing: ollama, kokoro-js, python3\)$/);
});

test('doctor: a probe that throws counts as missing and never crashes; fixes follow the platform', async () => {
  const boom = () => { throw new Error('boom'); };
  const r = await runDoctor({ probes: only({ ollama: boom, ffmpeg: boom }), platform: 'darwin', cwd: makeTempDir('studio-doc-') });
  assert.equal(byId(r, 'ollama').ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(byId(r, 'ffmpeg').fix, 'brew install ffmpeg');
  assert.equal((await runDoctor({ probes: only({ ffmpeg: () => false }), platform: 'win32', cwd: makeTempDir('studio-doc-') })).results[1].fix, 'winget install Gyan.FFmpeg');
});

test('doctor: the Ollama URL comes from --ollama-url, then studio.config.json, then OLLAMA_HOST, then the default', async () => {
  const cwd = makeTempDir('studio-doc-');
  const seen = [];
  const probes = only({ ollama: (u) => { seen.push(u); return true; } });
  await runDoctor({ probes, cwd, env: {} });
  fs.writeFileSync(path.join(cwd, 'studio.config.json'), JSON.stringify({ models: { plan: { provider: 'ollama', baseUrl: 'http://10.0.0.5:11434', model: 'x' } } }));
  await runDoctor({ probes, cwd, env: { OLLAMA_HOST: 'other:1' } });
  await runDoctor({ probes, cwd, env: {}, ollamaUrl: 'http://flag:1' });
  fs.rmSync(path.join(cwd, 'studio.config.json'));
  await runDoctor({ probes, cwd, env: { OLLAMA_HOST: 'other:1' } });
  await runDoctor({ probes, cwd, env: {}, configPath: 'nope.json' });
  assert.deepEqual(seen, [DEFAULT_OLLAMA_URL, 'http://10.0.0.5:11434', 'http://flag:1', 'http://other:1', DEFAULT_OLLAMA_URL]);
  assert.equal(findOllamaUrl({ a: [{ b: { ollamaUrl: 'http://z' } }] }), 'http://z');
  assert.equal(findOllamaUrl({ nothing: 1 }), null);
  assert.equal(resolveOllamaUrl({ cwd, readFile: () => 'not json', env: {} }), DEFAULT_OLLAMA_URL);
});

test('onPath finds a binary on PATH without spawning anything', () => {
  const dir = makeTempDir('studio-path-');
  fs.writeFileSync(path.join(dir, 'fakeffmpeg'), '');
  assert.equal(onPath('fakeffmpeg', { env: { PATH: `/nonexistent:${dir}` } }), true);
  assert.equal(onPath('absent', { env: { PATH: dir } }), false);
  assert.equal(onPath(path.join(dir, 'fakeffmpeg'), { env: { PATH: '' } }), true, 'an explicit path (FFMPEG=/x/ffmpeg) is checked directly');
  assert.equal(onPath('tool', { platform: 'win32', env: { PATH: '/x;/b', PATHEXT: '.EXE;.CMD' }, exists: (p) => p === path.join('/b', 'tool.CMD') }), true, 'Windows: ; separator and PATHEXT');
});

test('pingOllama: true on 200, false on refusal, error status or timeout, within the timeout', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') { res.end('{"models":[]}'); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(await pingOllama(`http://127.0.0.1:${port}`), true);
    assert.equal(await pingOllama('http://127.0.0.1:1', { timeoutMs: 500 }), false);
    const slow = http.createServer(() => {}); // never answers
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    assert.equal(await pingOllama(`http://127.0.0.1:${slow.address().port}`, { timeoutMs: 300 }), false);
    assert.ok(Date.now() - t0 < 2000, 'gave up at the timeout');
    slow.closeAllConnections?.();
    await new Promise((r) => slow.close(r));
    assert.equal(await pingOllama('http://127.0.0.1:1', { fetchImpl: () => { throw new Error('x'); } }), false);
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

test('cli: parseArgs takes the flags, defaults to start, and rejects bad input', () => {
  assert.deepEqual(parseArgs([]), { command: 'start', flags: {} });
  assert.deepEqual(parseArgs(['start', '--port', '48200', '--host=0.0.0.0', '--workspace', 'w', '--config', 'c.json']), { command: 'start', flags: { port: 48200, host: '0.0.0.0', workspace: 'w', config: 'c.json' } });
  assert.deepEqual(parseArgs(['doctor', '--ollama-url', 'http://x']).flags, { 'ollama-url': 'http://x' });
  assert.throws(() => parseArgs(['--port']), /--port needs a value/);
  assert.throws(() => parseArgs(['--port', 'abc']), /--port must be a whole number/);
  assert.throws(() => parseArgs(['--nope', '1']), /unknown option --nope/);
  assert.throws(() => parseArgs(['start', 'extra']), /unexpected argument "extra"/);
});

const capture = () => { const o = []; const e = []; return { out: (s) => o.push(s), err: (s) => e.push(s), o, e }; };

test('cli: --version, --help, unknown command', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  let c = capture();
  assert.equal(await main(['--version'], c), 0);
  assert.deepEqual(c.o, [pkg.version]);
  c = capture();
  assert.equal(await main(['--help'], c), 0);
  assert.match(c.o[0], new RegExp(`^studio ${pkg.version.replace(/\./g, '\\.')}`));
  assert.match(c.o[0], /studio doctor/);
  c = capture();
  assert.equal(await main(['frobnicate'], c), 2);
  assert.match(c.e[0], /unknown command "frobnicate"/);
});

test('cli: start without src/server.mjs prints one clear line and exits 1', async () => {
  const c = capture();
  const code = await main(['start'], { ...c, serverFile: path.join(makeTempDir('studio-nosrv-'), 'src', 'server.mjs'), env: {} });
  assert.equal(code, 1);
  assert.equal(c.e.length, 1);
  assert.match(c.e[0], /^studio: the server is not part of this build \(src\/server\.mjs is missing\)/);
  assert.equal(c.o.length, 0);
});

test('cli: start imports the server and calls startStudio with port, host, workspace and configPath; sets the media workspace env', async () => {
  const cwd = makeTempDir('studio-start-');
  const serverFile = path.join(cwd, 'server.mjs');
  fs.writeFileSync(serverFile, '');
  const calls = [];
  const env = {};
  const c = capture();
  const code = await main(['--port', '48201', '--workspace', 'ws', '--config', 'my.json'], { ...c, cwd, env, serverFile, startImport: async () => ({ startStudio: async (o) => { calls.push(o); } }) });
  assert.equal(code, null, 'null: keep the process alive for the server');
  assert.deepEqual(calls, [{ port: 48201, host: undefined, workspace: path.join(cwd, 'ws'), configPath: path.join(cwd, 'my.json') }]);
  assert.equal(env.STUDIO_ROOT, path.join(cwd, 'ws'));
  assert.equal(env.STUDIO_VIDEO_DIR, path.join(cwd, 'ws', 'videos'));
  const d = [];
  await main([], { ...capture(), cwd, env: {}, serverFile, startImport: async () => ({ startStudio: async (o) => { d.push(o.workspace); } }) });
  assert.deepEqual(d, [path.join(cwd, 'studio-workspace')], 'default workspace ./studio-workspace');
  const c2 = capture();
  assert.equal(await main([], { ...c2, cwd, env: {}, serverFile, startImport: async () => ({}) }), 1);
  assert.match(c2.e[0], /does not export startStudio/);
});

test('bin/studio.mjs end to end: --version, doctor exit codes follow the machine, unknown flag exits 2', () => {
  const bin = new URL('../bin/studio.mjs', import.meta.url).pathname;
  const v = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const d = spawnSync(process.execPath, [bin, 'doctor', '--ollama-url', 'http://127.0.0.1:1'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(d.status, 1, 'no ffmpeg on an empty PATH');
  assert.match(d.stdout, /MISSING\s+ffmpeg/);
  assert.match(d.stdout, /fix: .*ffmpeg/);
  assert.equal(spawnSync(process.execPath, [bin, '--bogus'], { encoding: 'utf8' }).status, 2);
});
