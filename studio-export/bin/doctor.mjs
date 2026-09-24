// `studio doctor`: what Studio needs on this machine that npm cannot install, and the exact command that fixes each gap.
// Deterministic: every probe is injectable (`probes`), so the report and the exit code are testable without the machine.
// Exit code: 1 when a REQUIRED item is missing, 0 otherwise (optional items only ever produce a note; Ollama is never fatal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const MIN_NODE_MAJOR = 20;

/** The first `baseUrl` (or `ollamaUrl`) string found anywhere in a parsed studio.config.json, else null. */
export function findOllamaUrl(config) {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && /^(baseUrl|baseURL|ollamaUrl|ollama_url)$/.test(k)) return x;
    }
    for (const x of Object.values(v)) { const r = walk(x); if (r) return r; }
    return null;
  };
  return walk(config);
}

/** Where to look for Ollama: `--ollama-url`, then the config file, then OLLAMA_HOST, then the default. */
export function resolveOllamaUrl({ ollamaUrl, configPath, env = process.env, cwd = process.cwd(), readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  if (ollamaUrl) return ollamaUrl;
  const file = configPath ? path.resolve(cwd, configPath) : path.join(cwd, 'studio.config.json');
  try {
    const found = findOllamaUrl(JSON.parse(readFile(file)));
    if (found) return found;
  } catch { /* no config, or not JSON: fall through, doctor never fails on this */ }
  if (env.OLLAMA_HOST) return /^https?:\/\//.test(env.OLLAMA_HOST) ? env.OLLAMA_HOST : `http://${env.OLLAMA_HOST}`;
  return DEFAULT_OLLAMA_URL;
}

/** Is `bin` (a bare name or a path) an existing file on PATH? Pure filesystem, no process spawned. */
export function onPath(bin, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  if (bin.includes('/') || bin.includes('\\')) return exts.some((e) => exists(bin + e));
  const dirs = (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  return dirs.some((d) => exts.some((e) => exists(path.join(d, bin + e))));
}

/** GET {url}/api/tags with a hard timeout; true when Ollama answers, false on anything else. Never throws. */
export async function pingOllama(url, { timeoutMs = 2000, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(new URL('/api/tags', url).href, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

/** Is Playwright's chromium downloaded? Imports `playwright` lazily so a missing package is reported, not thrown. */
export async function chromiumInstalled() {
  try {
    const { chromium } = await import('playwright');
    return fs.existsSync(chromium.executablePath());
  } catch { return false; }
}

export const mediaCacheDir = (env = process.env) => env.CONSTRUCT_MEDIA_CACHE || path.join(os.homedir(), '.cache', 'construct-media');

/** The probes doctor runs. Each returns a boolean (node returns the version string). Replace any of them in tests. */
export function defaultProbes({ env = process.env, platform = process.platform } = {}) {
  const has = (bin) => onPath(bin, { env, platform });
  return {
    node: () => process.versions.node,
    ffmpeg: () => has(env.FFMPEG || 'ffmpeg'),
    ffprobe: () => has(env.FFPROBE || 'ffprobe'),
    chromium: chromiumInstalled,
    ollama: (url) => pingOllama(url),
    python: () => has('python3'),
    kokoro: () => fs.existsSync(path.join(mediaCacheDir(env), 'node_modules', 'kokoro-js')),
  };
}

const installFfmpeg = (platform) => (platform === 'darwin' ? 'brew install ffmpeg' : platform === 'win32' ? 'winget install Gyan.FFmpeg' : 'sudo apt install ffmpeg');
const installPython = (platform) => (platform === 'darwin' ? 'brew install python' : platform === 'win32' ? 'winget install Python.Python.3' : 'sudo apt install python3 python3-venv');

/**
 * Run every check. Returns { results, lines, exitCode }; each result is
 * { id, label, required, ok, detail, fix } and `fix` is the exact command when the item is missing.
 */
export async function runDoctor({ probes = defaultProbes(), platform = process.platform, env = process.env, cwd = process.cwd(), ollamaUrl, configPath, readFile } = {}) {
  const url = resolveOllamaUrl({ ollamaUrl, configPath, env, cwd, readFile });
  const results = [];
  const add = (id, label, required, ok, detail, fix) => results.push({ id, label, required, ok: Boolean(ok), detail, fix: ok ? undefined : fix });
  const safe = async (fn, ...a) => { try { return await fn(...a); } catch { return false; } };

  const nodeVersion = await safe(probes.node);
  const major = Number(String(nodeVersion || '').split('.')[0]);
  add('node', 'node', true, major >= MIN_NODE_MAJOR, nodeVersion ? `v${nodeVersion} (need >= ${MIN_NODE_MAJOR})` : `need >= ${MIN_NODE_MAJOR}`, `install Node ${MIN_NODE_MAJOR} or newer from https://nodejs.org or with your version manager (nvm install ${MIN_NODE_MAJOR})`);
  add('ffmpeg', 'ffmpeg', true, await safe(probes.ffmpeg), 'encodes video and mixes audio', installFfmpeg(platform));
  add('ffprobe', 'ffprobe', true, await safe(probes.ffprobe), 'reads video and audio durations (ships with ffmpeg)', installFfmpeg(platform));
  add('chromium', 'playwright chromium', true, await safe(probes.chromium), 'records the website', 'npx playwright install chromium');
  add('ollama', 'ollama', false, await safe(probes.ollama, url), `local model server at ${url} (2 s timeout)`, 'install Ollama from https://ollama.com, then run: ollama serve   (and pull a model, e.g. ollama pull llama3.2; or point studio.config.json at another local server)');
  add('kokoro', 'kokoro-js', false, await safe(probes.kokoro), 'default local narration voice', `mkdir -p ${mediaCacheDir(env)} && cd ${mediaCacheDir(env)} && npm init -y && npm i kokoro-js`);
  add('python', 'python3', false, await safe(probes.python), 'only for own-voice cloning', installPython(platform));

  const lines = [];
  for (const r of results) {
    const tag = r.ok ? 'ok      ' : r.required ? 'MISSING ' : 'optional';
    lines.push(`${tag} ${r.label}: ${r.detail}`);
    if (r.fix) lines.push(`         fix: ${r.fix}`);
  }
  const missing = results.filter((r) => !r.ok && r.required);
  const optional = results.filter((r) => !r.ok && !r.required);
  lines.push(missing.length ? `${missing.length} required item(s) missing: ${missing.map((r) => r.label).join(', ')}` : `ready${optional.length ? ` (${optional.length} optional item(s) missing: ${optional.map((r) => r.label).join(', ')})` : ''}`);
  return { results, lines, exitCode: missing.length ? 1 : 0 };
}
