// Studio's configuration (studio.config.json) and the model providers behind it. Local only: the one provider shipped is
// Ollama, and there is no cloud default. A provider is { name, listModels(), chat() }; another local provider is added with
// registerProvider(name, factory) and selected by `provider` in the config.
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- config

export const CONFIG_ERR = Object.freeze({
  BAD_JSON: 'CONFIG_BAD_JSON',
  NOT_OBJECT: 'CONFIG_NOT_OBJECT',
  UNKNOWN_KEY: 'CONFIG_UNKNOWN_KEY',
  UNKNOWN_PROVIDER: 'CONFIG_UNKNOWN_PROVIDER',
  BAD_BASE_URL: 'CONFIG_BAD_BASE_URL',
  BAD_MODEL: 'CONFIG_BAD_MODEL',
  BAD_TTS_BACKEND: 'CONFIG_BAD_TTS_BACKEND',
  BAD_VOICE: 'CONFIG_BAD_VOICE',
  TTS_CMD_REQUIRED: 'CONFIG_TTS_CMD_REQUIRED',
  BAD_BOOLEAN: 'CONFIG_BAD_BOOLEAN',
  BAD_RECORDING: 'CONFIG_BAD_RECORDING',
  FILE_ONLY: 'CONFIG_FILE_ONLY',
  WRITE_FAILED: 'CONFIG_WRITE_FAILED',
});

export const TTS_BACKENDS = Object.freeze(['kokoro', 'chatterbox', 'cmd']);
export const CONFIG_FILE = 'studio.config.json';

/** Keys that can only be changed by editing studio.config.json, never through the HTTP API (they name a command or a file). */
export const FILE_ONLY_KEYS = Object.freeze(['tts.ttsCmd', 'tts.voiceSample']);

export const DEFAULT_CONFIG = Object.freeze({
  provider: 'ollama',
  providers: { ollama: { baseUrl: 'http://127.0.0.1:11434' } },
  models: { planner: 'llama3.2', narration: 'llama3.2' },
  tts: { backend: 'kokoro', voice: 'af_heart', ttsCmd: '', voiceSample: '' },
  allowPrivateNetwork: false,
  recording: { width: 1280, height: 720, pace: 1, burnCaptions: true },
});

export class ConfigError extends Error {
  constructor(code, message, errors = []) { super(message); this.name = 'ConfigError'; this.code = code; this.errors = errors; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MODEL_RE = /^[\w][\w.:/@+-]{0,199}$/;
const VOICE_RE = /^[a-z]{2}_[a-z0-9]{2,20}$/; // a Kokoro stock voice id such as af_heart
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Validate a config object and fill in defaults. Returns { ok, errors: [{ code, path, message }], config }.
 * Unknown keys are rejected so a typo does not silently do nothing.
 */
export function validateConfig(input) {
  const errors = [];
  const err = (code, p, message) => errors.push({ code, path: p, message });
  if (!isObj(input)) return { ok: false, errors: [{ code: CONFIG_ERR.NOT_OBJECT, path: '', message: 'the config must be a JSON object' }] };
  const cfg = clone(DEFAULT_CONFIG);
  const known = Object.keys(DEFAULT_CONFIG);
  for (const k of Object.keys(input)) if (!known.includes(k)) err(CONFIG_ERR.UNKNOWN_KEY, k, `unknown key "${k}"`);

  if (input.provider !== undefined) {
    if (typeof input.provider !== 'string' || !PROVIDERS.has(input.provider)) err(CONFIG_ERR.UNKNOWN_PROVIDER, 'provider', `unknown provider ${JSON.stringify(input.provider)}; registered: ${[...PROVIDERS.keys()].join(', ')}`);
    else cfg.provider = input.provider;
  }
  if (input.providers !== undefined) {
    if (!isObj(input.providers)) err(CONFIG_ERR.NOT_OBJECT, 'providers', 'providers must be an object');
    else {
      cfg.providers = {};
      for (const [name, opts] of Object.entries(input.providers)) {
        if (!PROVIDERS.has(name)) { err(CONFIG_ERR.UNKNOWN_PROVIDER, `providers.${name}`, `unknown provider "${name}"; registered: ${[...PROVIDERS.keys()].join(', ')}`); continue; }
        if (!isObj(opts)) { err(CONFIG_ERR.NOT_OBJECT, `providers.${name}`, 'must be an object'); continue; }
        const base = opts.baseUrl;
        let ok = false;
        try { const u = new URL(base); ok = (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { /* not a URL */ }
        if (!ok) { err(CONFIG_ERR.BAD_BASE_URL, `providers.${name}.baseUrl`, 'baseUrl must be an http or https URL without credentials'); continue; }
        cfg.providers[name] = { ...opts, baseUrl: new URL(base).origin + new URL(base).pathname.replace(/\/+$/, '') };
      }
      if (!cfg.providers[cfg.provider] && PROVIDERS.has(cfg.provider)) cfg.providers[cfg.provider] = clone(DEFAULT_CONFIG.providers.ollama);
    }
  }
  if (input.models !== undefined) {
    if (!isObj(input.models)) err(CONFIG_ERR.NOT_OBJECT, 'models', 'models must be an object { planner, narration }');
    else for (const k of Object.keys(input.models)) {
      if (k !== 'planner' && k !== 'narration') { err(CONFIG_ERR.UNKNOWN_KEY, `models.${k}`, `unknown model role "${k}"; use planner or narration`); continue; }
      const v = input.models[k];
      if (typeof v !== 'string' || (v !== '' && !MODEL_RE.test(v))) err(CONFIG_ERR.BAD_MODEL, `models.${k}`, 'a model name such as llama3.2 or qwen2.5:7b (empty means: none chosen)');
      else cfg.models[k] = v;
    }
  }
  if (input.tts !== undefined) {
    if (!isObj(input.tts)) err(CONFIG_ERR.NOT_OBJECT, 'tts', 'tts must be an object');
    else {
      for (const k of Object.keys(input.tts)) if (!['backend', 'voice', 'ttsCmd', 'voiceSample'].includes(k)) err(CONFIG_ERR.UNKNOWN_KEY, `tts.${k}`, `unknown key "tts.${k}"`);
      const t = input.tts;
      if (t.backend !== undefined) { if (!TTS_BACKENDS.includes(t.backend)) err(CONFIG_ERR.BAD_TTS_BACKEND, 'tts.backend', `backend must be one of ${TTS_BACKENDS.join(', ')}`); else cfg.tts.backend = t.backend; }
      if (t.voice !== undefined) { if (typeof t.voice !== 'string' || !VOICE_RE.test(t.voice)) err(CONFIG_ERR.BAD_VOICE, 'tts.voice', 'a Kokoro voice id such as af_heart'); else cfg.tts.voice = t.voice; }
      for (const k of ['ttsCmd', 'voiceSample']) {
        if (t[k] === undefined) continue;
        if (typeof t[k] !== 'string' || t[k].length > 1000 || /[\u0000\n\r]/.test(t[k])) err(CONFIG_ERR.BAD_VOICE, `tts.${k}`, `${k} must be a single-line string`);
        else cfg.tts[k] = t[k];
      }
      if (cfg.tts.backend === 'cmd' && !cfg.tts.ttsCmd) err(CONFIG_ERR.TTS_CMD_REQUIRED, 'tts.ttsCmd', 'backend "cmd" needs ttsCmd, for example: my-tts --in {text_file} --out {out}');
    }
  }
  if (input.allowPrivateNetwork !== undefined) {
    if (typeof input.allowPrivateNetwork !== 'boolean') err(CONFIG_ERR.BAD_BOOLEAN, 'allowPrivateNetwork', 'must be true or false');
    else cfg.allowPrivateNetwork = input.allowPrivateNetwork;
  }
  if (input.recording !== undefined) {
    if (!isObj(input.recording)) err(CONFIG_ERR.BAD_RECORDING, 'recording', 'recording must be an object { width, height, pace }');
    else {
      const r = input.recording;
      for (const k of Object.keys(r)) if (!['width', 'height', 'pace', 'burnCaptions'].includes(k)) err(CONFIG_ERR.UNKNOWN_KEY, `recording.${k}`, `unknown key "recording.${k}"`);
      const num = (k, lo, hi, int) => {
        if (r[k] === undefined) return;
        if (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < lo || r[k] > hi || (int && !Number.isInteger(r[k]))) err(CONFIG_ERR.BAD_RECORDING, `recording.${k}`, `${k} must be ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}`);
        else cfg.recording[k] = r[k];
      };
      num('width', 320, 3840, true); num('height', 240, 2160, true); num('pace', 0.25, 4, false);
      if (r.burnCaptions !== undefined) { if (typeof r.burnCaptions !== 'boolean') err(CONFIG_ERR.BAD_BOOLEAN, 'recording.burnCaptions', 'must be true or false'); else cfg.recording.burnCaptions = r.burnCaptions; }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], config: cfg };
}

/** Load the config from `file`; when it does not exist, create it with the defaults. Throws ConfigError on bad JSON or values. */
export function loadConfig(file) {
  if (!fs.existsSync(file)) {
    const config = clone(DEFAULT_CONFIG);
    saveConfig(file, config);
    return { config, file, created: true };
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError(CONFIG_ERR.BAD_JSON, `${path.basename(file)} is not valid JSON: ${e.message}`); }
  const v = validateConfig(raw);
  if (!v.ok) throw new ConfigError(v.errors[0].code, `${path.basename(file)}: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, v.errors);
  return { config: v.config, file, created: false };
}

/** Validate and write the config (atomically: a temp file in the same folder, then rename). Returns the normalised config. */
export function saveConfig(file, config) {
  const v = validateConfig(config);
  if (!v.ok) throw new ConfigError(v.errors[0].code, v.errors.map((e) => `${e.path}: ${e.message}`).join('; '), v.errors);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v.config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { throw new ConfigError(CONFIG_ERR.WRITE_FAILED, `could not write ${path.basename(file)}: ${e.message}`); }
  return v.config;
}

/** Apply an API update to the current config: the client may not change file-only keys (a command or a file path). */
export function applyUpdate(current, incoming) {
  if (!isObj(incoming)) throw new ConfigError(CONFIG_ERR.NOT_OBJECT, 'the config must be a JSON object');
  const errors = [];
  const next = clone(incoming);
  for (const key of FILE_ONLY_KEYS) {
    const [a, b] = key.split('.');
    if (isObj(next[a]) && next[a][b] !== undefined) {
      if (next[a][b] !== current[a][b]) errors.push({ code: CONFIG_ERR.FILE_ONLY, path: key, message: `${key} can only be changed by editing ${CONFIG_FILE} (it names a command or a file)` });
      delete next[a][b];
    }
  }
  if (errors.length) throw new ConfigError(CONFIG_ERR.FILE_ONLY, errors[0].message, errors);
  const merged = { ...clone(current), ...next };
  for (const k of ['models', 'tts', 'recording']) if (isObj(next[k])) merged[k] = { ...current[k], ...next[k] };
  if (isObj(next.providers)) merged.providers = { ...current.providers, ...next.providers };
  // keep the file-only values
  merged.tts = { ...merged.tts, ttsCmd: current.tts.ttsCmd, voiceSample: current.tts.voiceSample };
  return merged;
}

// ---------------------------------------------------------------- providers

/** Typed model errors. code: MODEL_UNREACHABLE | MODEL_TIMEOUT | MODEL_HTTP | MODEL_BAD_RESPONSE | MODEL_MISSING. */
export const MODEL_ERR = Object.freeze({ UNREACHABLE: 'MODEL_UNREACHABLE', TIMEOUT: 'MODEL_TIMEOUT', HTTP: 'MODEL_HTTP', BAD_RESPONSE: 'MODEL_BAD_RESPONSE', MISSING: 'MODEL_MISSING' });
export class ModelError extends Error {
  constructor(code, message) { super(message); this.name = 'ModelError'; this.code = code; }
}

const PROVIDERS = new Map();
/** Register a provider factory: (options, { fetch }) => { name, listModels(), chat() }. Another local provider plugs in here. */
export function registerProvider(name, factory) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(name) || typeof factory !== 'function') throw new TypeError('registerProvider(name, factory)');
  PROVIDERS.set(name, factory);
}
export const providerNames = () => [...PROVIDERS.keys()];

/** The provider selected in `config` (default: ollama), built from its options. `deps.fetch` is injectable for tests. */
export function createProvider(config, deps = {}) {
  const name = config.provider || 'ollama';
  const factory = PROVIDERS.get(name);
  if (!factory) throw new ConfigError(CONFIG_ERR.UNKNOWN_PROVIDER, `unknown provider "${name}"`);
  return factory(config.providers?.[name] || {}, deps);
}

async function timed(fetchFn, url, init, timeoutMs, outer) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onOuter = () => ac.abort(new Error('aborted'));
  if (outer) outer.addEventListener('abort', onOuter, { once: true });
  try {
    return await fetchFn(url, { ...init, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted && String(ac.signal.reason?.message) === 'timeout') throw new ModelError(MODEL_ERR.TIMEOUT, `no answer from ${new URL(url).host} within ${Math.round(timeoutMs / 1000)} s`);
    throw new ModelError(MODEL_ERR.UNREACHABLE, `cannot reach ${new URL(url).host}: ${e?.cause?.code || e?.message || e}`);
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onOuter);
  }
}

/** Ollama over its HTTP API with the global fetch only: POST /api/chat (stream:false), GET /api/tags. */
export function createOllamaProvider(options = {}, deps = {}) {
  const base = String(options.baseUrl || DEFAULT_CONFIG.providers.ollama.baseUrl).replace(/\/+$/, '');
  const fetchFn = deps.fetch || globalThis.fetch;
  const chatTimeout = options.timeoutMs ?? deps.timeoutMs ?? 180000;
  const tagsTimeout = options.tagsTimeoutMs ?? deps.tagsTimeoutMs ?? 5000;
  return {
    name: 'ollama',
    baseUrl: base,
    async listModels({ signal } = {}) {
      const res = await timed(fetchFn, `${base}/api/tags`, { method: 'GET' }, tagsTimeout, signal);
      if (!res.ok) throw new ModelError(MODEL_ERR.HTTP, `ollama answered HTTP ${res.status} to /api/tags`);
      let body;
      try { body = await res.json(); } catch { throw new ModelError(MODEL_ERR.BAD_RESPONSE, 'ollama /api/tags did not return JSON'); }
      if (!Array.isArray(body?.models)) throw new ModelError(MODEL_ERR.BAD_RESPONSE, 'ollama /api/tags has no models list');
      return body.models.map((m) => ({ name: String(m.name || m.model), size: Number(m.size) || 0 })).filter((m) => m.name);
    },
    async chat({ model, messages, json = false, temperature = 0.2, signal }) {
      if (!model) throw new ModelError(MODEL_ERR.MISSING, 'no model is chosen; pick one in the settings');
      const body = { model, messages, stream: false, options: { temperature }, ...(json ? { format: 'json' } : {}) };
      const res = await timed(fetchFn, `${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, chatTimeout, signal);
      if (res.status === 404) throw new ModelError(MODEL_ERR.MISSING, `ollama does not have the model "${model}" (ollama pull ${model})`);
      if (!res.ok) throw new ModelError(MODEL_ERR.HTTP, `ollama answered HTTP ${res.status} to /api/chat`);
      let out;
      try { out = await res.json(); } catch { throw new ModelError(MODEL_ERR.BAD_RESPONSE, 'ollama /api/chat did not return JSON'); }
      const text = out?.message?.content;
      if (typeof text !== 'string') throw new ModelError(MODEL_ERR.BAD_RESPONSE, 'ollama /api/chat returned no message');
      return text;
    },
  };
}
registerProvider('ollama', createOllamaProvider);
