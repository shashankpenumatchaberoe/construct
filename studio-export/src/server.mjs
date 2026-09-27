// Studio's HTTP server: the chat page and the JSON API behind it. Local by default (127.0.0.1), one random access token,
// and one rule that carries the design: chat PLANS, blocks EXECUTE. POST /api/chat only ever returns a proposal;
// POST /api/storyboard/approve, carrying the exact id and hash of a proposal, is the only route that starts a recording.
// No route takes a filesystem path from the client; files are served by name from <workspace>/videos only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_FILE, ConfigError, FILE_ONLY_KEYS, applyUpdate, createProvider, loadConfig, providerNames, saveConfig } from './models.mjs';
import { planStoryboard } from './planner.mjs';
import { assertInside, OUTPUTS, runPipeline, voiceAvailability } from './pipeline.mjs';
import { KEYS, LIMITS, describeActions, hashStoryboard, validateStoryboard } from './storyboard.mjs';
import { loadPlaywright } from './resolve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'ui', 'index.html');
const MAX_BODY = 256 * 1024;
const MAX_PROPOSALS = 100;
const MAX_JOB_EVENTS = 1000;
const REDACTED = '(set in studio.config.json)';
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const SERVABLE = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.opus': 'audio/ogg', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(sha(a), sha(b));
const mask = (t) => `${t.slice(0, 4)}…`;
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

/**
 * Start Studio. Returns { url, token, close() }.
 *   { port, host = '127.0.0.1', workspace, configPath, log, deps }
 * `log(message)` receives one start banner with the access URL (the only time the full token is written anywhere) and
 * masked lines after that; pass `() => {}` to silence it. `deps` ({ fetch, provider, playwright, runTool, mediaDir,
 * voiceAvailability }) are injectable for tests.
 */
export async function startStudio({ port = 0, host = '127.0.0.1', workspace, configPath, log = (m) => console.log(m), deps = {} } = {}) {
  if (!workspace) throw new Error('startStudio needs a workspace directory');
  fs.mkdirSync(workspace, { recursive: true });
  const root = fs.realpathSync(workspace);
  const outDir = path.join(root, OUTPUTS);
  fs.mkdirSync(outDir, { recursive: true });
  assertInside(root, outDir);
  const cfgFile = configPath ? path.resolve(configPath) : path.join(root, CONFIG_FILE);
  let { config } = loadConfig(cfgFile);
  const token = process.env.STUDIO_ACCESS_TOKEN && process.env.STUDIO_ACCESS_TOKEN.length >= 8 ? process.env.STUDIO_ACCESS_TOKEN : crypto.randomBytes(24).toString('base64url');

  const page = fs.readFileSync(PAGE, 'utf8');
  const cspHash = (tag) => { const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(page); return m ? `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'` : "'none'"; };
  const csp = `default-src 'none'; script-src ${cspHash('script')}; style-src ${cspHash('style')}; connect-src 'self'; media-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

  const proposals = new Map(); // id -> { id, hash, storyboard, baseUrl }
  const jobs = new Map(); // id -> job
  const queue = [];
  let running = null;
  let closing = false;
  const controllers = new Set();

  // ---------------------------------------------------------------- jobs
  const persist = (job) => {
    try { fs.writeFileSync(assertInside(root, path.join(outDir, `${job.slug}.job.json`)), JSON.stringify(summary(job), null, 2) + '\n'); } catch { /* best effort */ }
  };
  const summary = (j) => ({ id: j.id, slug: j.slug, title: j.title, status: j.status, stage: j.stage, progress: Math.round(j.progress * 100) / 100, created: j.created, finished: j.finished, final: j.final, files: j.files, stages: j.stages, error: j.error, edited: j.edited, storyboardHash: j.storyboardHash });

  for (const f of fs.readdirSync(outDir).filter((n) => n.endsWith('.job.json')).slice(-200)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
      if (typeof j.id === 'string' && /^j[a-z0-9]+$/.test(j.id) && typeof j.slug === 'string' && ['done', 'failed', 'cancelled'].includes(j.status)) jobs.set(j.id, { ...j, events: [], subscribers: new Set() });
    } catch { /* skip a damaged record */ }
  }

  function emitJob(job, ev) {
    const e = { seq: job.events.length + 1, ts: new Date().toISOString(), ...ev };
    if (job.events.length < MAX_JOB_EVENTS) job.events.push(e);
    if (ev.stage) job.stage = ev.stage;
    if (ev.stage === 'record' && ev.type === 'step' && ev.total) job.progress = Math.max(job.progress, 0.6 * (ev.done ? ev.index : ev.index - 1) / ev.total);
    if (ev.stage === 'record' && ev.type === 'done') job.progress = 0.6;
    if (['captions', 'voice', 'mix'].includes(ev.stage) && ['done', 'skipped'].includes(ev.type)) job.progress = Math.min(1, job.progress + 0.4 / 3);
    for (const res of job.subscribers) sse(res, 'progress', e);
  }
  const sse = (res, event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };

  async function pump() {
    if (running || closing) return;
    const job = queue.shift();
    if (!job) return;
    running = job;
    job.status = 'running';
    emitJob(job, { stage: 'job', type: 'start' });
    const ac = new AbortController();
    controllers.add(ac);
    job.abort = () => ac.abort();
    try {
      const playwright = deps.playwright || await loadPlaywright();
      const r = await runPipeline({
        storyboard: job.storyboard, workspace: root, config: job.config, playwright, slug: job.slug, signal: ac.signal,
        stages: job.stagesWanted, onEvent: (ev) => emitJob(job, ev),
        deps: { ...(deps.runTool ? { runTool: deps.runTool } : {}), ...(deps.mediaDir !== undefined ? { mediaDir: deps.mediaDir } : {}), ...(deps.voiceAvailability ? { voiceAvailability: deps.voiceAvailability } : {}) },
      });
      job.files = r.files; job.stages = r.stages; job.final = r.final;
      job.status = ac.signal.aborted ? 'cancelled' : r.ok ? 'done' : 'failed';
      if (!r.ok) job.error = r.error || { code: 'PIPELINE_FAILED', message: Object.values(r.stages).find((s) => s.status === 'failed')?.reason || 'the pipeline did not produce a video' };
    } catch (e) {
      job.status = ac.signal.aborted ? 'cancelled' : 'failed';
      job.error = { code: e.code || 'PIPELINE_FAILED', message: String(e.message).split('\n')[0] };
    } finally {
      controllers.delete(ac);
      job.progress = job.status === 'done' ? 1 : job.progress;
      job.finished = new Date().toISOString();
      emitJob(job, { stage: 'job', type: job.status, ...(job.error ? { error: job.error } : {}) });
      for (const res of job.subscribers) { sse(res, 'end', summary(job)); res.end(); }
      job.subscribers.clear();
      delete job.abort; delete job.storyboard; delete job.config; delete job.stagesWanted;
      persist(job);
      running = null;
      setImmediate(pump);
    }
  }

  // ---------------------------------------------------------------- handlers
  const publicConfig = () => {
    const c = JSON.parse(JSON.stringify(config));
    for (const key of FILE_ONLY_KEYS) { const [a, b] = key.split('.'); if (c[a][b]) c[a][b] = REDACTED; }
    return c;
  };
  const provider = () => deps.provider || createProvider(config, { fetch: deps.fetch });

  async function readJson(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body too large');
      chunks.push(c);
    }
    if (!n) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); return v; } catch { throw new HttpError(400, 'BAD_JSON', 'the request body must be a JSON object'); }
  }

  const routes = {
    'GET /api/config': async () => ({ config: publicConfig(), fileOnly: FILE_ONLY_KEYS, file: path.basename(cfgFile), providers: providerNames(), voice: (deps.voiceAvailability || voiceAvailability)(config, deps.mediaDir === undefined ? undefined : { tools: deps.mediaDir }) }),
    'PUT /api/config': async (req) => {
      const body = await readJson(req);
      for (const key of FILE_ONLY_KEYS) { const [a, b] = key.split('.'); if (body[a] && typeof body[a] === 'object' && body[a][b] === REDACTED) body[a][b] = config[a][b]; }
      try { config = saveConfig(cfgFile, applyUpdate(config, body)); } catch (e) {
        if (e instanceof ConfigError) throw new HttpError(400, e.code, e.message, { errors: e.errors });
        throw e;
      }
      return { config: publicConfig() };
    },
    'GET /api/models': async () => {
      let p;
      try { p = provider(); } catch (e) { return { provider: config.provider, reachable: false, models: [], error: { code: e.code || 'NO_PROVIDER', message: e.message } }; }
      try { return { provider: p.name, baseUrl: p.baseUrl, reachable: true, models: await p.listModels() }; } catch (e) {
        return { provider: p.name, baseUrl: p.baseUrl, reachable: false, models: [], error: { code: e.code || 'MODEL_UNREACHABLE', message: e.message } };
      }
    },
    'GET /api/schema': async () => ({ actions: describeActions(), limits: LIMITS, keys: KEYS }),
    'POST /api/chat': async (req) => {
      const body = await readJson(req);
      if (typeof body.url !== 'string') throw new HttpError(400, 'URL_INVALID', 'give the address of the site to record');
      const r = await planStoryboard({ messages: body.messages, url: body.url, config, fetch: deps.fetch, provider: deps.provider });
      if (!r.ok) {
        const status = r.error.code === 'PLAN_INVALID' ? 422 : 400;
        throw new HttpError(status, r.error.code, r.error.message, { errors: r.error.errors, attempts: r.attempts, lastReply: r.error.lastReply });
      }
      const id = crypto.randomBytes(8).toString('hex');
      proposals.set(id, { id, hash: r.hash, storyboard: r.storyboard, baseUrl: r.storyboard.baseUrl });
      while (proposals.size > MAX_PROPOSALS) proposals.delete(proposals.keys().next().value);
      return { reply: r.reply, proposal: { id, hash: r.hash, storyboard: r.storyboard, fallback: r.fallback, ...(r.reason ? { reason: r.reason } : {}), attempts: r.attempts } };
    },
    'POST /api/storyboard/approve': async (req) => {
      const body = await readJson(req);
      const p = typeof body.id === 'string' ? proposals.get(body.id) : undefined;
      if (!p) throw new HttpError(404, 'UNKNOWN_PROPOSAL', 'no such proposal; ask in the chat first');
      if (!safeEqual(body.hash, p.hash)) throw new HttpError(409, 'HASH_MISMATCH', 'the hash does not match the proposal that was made');
      const candidate = body.storyboard === undefined ? p.storyboard : body.storyboard;
      const v = validateStoryboard(candidate, { baseUrl: p.baseUrl, allowPrivateNetwork: config.allowPrivateNetwork });
      if (!v.ok) throw new HttpError(422, 'STORYBOARD_INVALID', `the storyboard is not valid: ${v.errors[0].path}: ${v.errors[0].message}`, { errors: v.errors });
      const want = { record: true };
      for (const s of ['captions', 'voice', 'mix']) want[s] = !(isPlainObject(body.stages) && body.stages[s] === false);
      const storyboardHash = hashStoryboard(v.storyboard);
      const id = `j${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const job = {
        id, slug: `${stamp()}-${slugify(v.storyboard.title)}-${crypto.randomBytes(2).toString('hex')}`, title: v.storyboard.title, status: 'queued', stage: 'queued', progress: 0,
        created: new Date().toISOString(), finished: null, final: null, files: {}, stages: {}, error: null, edited: storyboardHash !== p.hash, storyboardHash,
        storyboard: v.storyboard, config: JSON.parse(JSON.stringify(config)), stagesWanted: want, events: [], subscribers: new Set(),
      };
      jobs.set(id, job);
      queue.push(job);
      setImmediate(pump);
      return { status: 202, body: { jobId: id, hash: storyboardHash, edited: job.edited, queued: queue.length + (running ? 1 : 0) } };
    },
    'GET /api/jobs': async () => ({ jobs: [...jobs.values()].sort((a, b) => (a.created < b.created ? 1 : -1)).map(summary) }),
  };

  function serveEvents(req, res, id) {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'UNKNOWN_JOB', 'no such job');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    for (const e of job.events) sse(res, 'progress', e);
    if (['done', 'failed', 'cancelled'].includes(job.status)) { sse(res, 'end', summary(job)); res.end(); return; }
    job.subscribers.add(res);
    const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* gone */ } }, 15000);
    req.on('close', () => { clearInterval(ka); job.subscribers.delete(res); });
  }

  function serveMedia(req, res, name) {
    if (!FILE_NAME_RE.test(name)) throw new HttpError(404, 'NOT_FOUND', 'no such file');
    const ext = path.extname(name).toLowerCase();
    if (!SERVABLE[ext] || name.endsWith('.job.json')) throw new HttpError(404, 'NOT_FOUND', 'no such file');
    let file;
    try { file = assertInside(root, path.join(outDir, name)); } catch { throw new HttpError(404, 'NOT_FOUND', 'no such file'); }
    if (path.dirname(file) !== fs.realpathSync(outDir)) throw new HttpError(404, 'NOT_FOUND', 'no such file');
    let st;
    try { st = fs.statSync(file); } catch { throw new HttpError(404, 'NOT_FOUND', 'no such file'); }
    if (!st.isFile()) throw new HttpError(404, 'NOT_FOUND', 'no such file');
    const headers = { 'content-type': SERVABLE[ext], 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-disposition': 'inline' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
      start = Math.max(0, start); end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  let editorHandler = null;
  const editorFile = path.join(HERE, 'editor', 'routes.mjs');
  const editorModule = async () => {
    if (editorHandler) return editorHandler;
    if (!fs.existsSync(editorFile)) return null;
    const mod = await import(pathToFileURL(editorFile).href);
    editorHandler = typeof mod.default === 'function' ? mod.default : null;
    return editorHandler;
  };

  let allowedHosts = null;
  const server = http.createServer(async (req, res) => {
    try {
      if (allowedHosts && !allowedHosts.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, 'BAD_HOST', 'unexpected Host header');
      const url = new URL(req.url || '/', 'http://studio.local');
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
        res.end(req.method === 'HEAD' ? undefined : page);
        return;
      }
      if (url.pathname === '/health') {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only');
        return sendJson(res, 200, { ok: true, name: 'studio' });
      }
      const isApi = url.pathname.startsWith('/api/');
      const isMedia = url.pathname.startsWith('/media/');
      const isEditor = url.pathname === '/editor' || url.pathname.startsWith('/editor/');
      if (!isApi && !isMedia && !isEditor) throw new HttpError(404, 'NOT_FOUND', 'not found');
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      // The editor page is one static document (no secrets in it); like `/` it loads without a token so a reload after the
      // page stripped ?token= from the address bar still works. Everything it then fetches (/api/editor, /media) is gated.
      const isEditorShell = method === 'GET' && url.pathname === '/editor';
      if (!isEditorShell && !safeEqual(bearer ? bearer[1] : url.searchParams.get('token'), token)) throw new HttpError(401, 'UNAUTHORIZED', 'a valid access token is required');
      if (isMedia) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only');
        return serveMedia(req, res, decodeURIComponent(url.pathname.slice('/media/'.length)));
      }
      if (isEditor || url.pathname.startsWith('/api/editor/')) {
        // The timeline editor lives in src/editor/ and is optional: without it these paths are plain 404s.
        const editor = await editorModule();
        if (editor && await editor(req, res, { workspace: root, url })) return;
        throw new HttpError(404, 'NOT_FOUND', 'not found');
      }
      const ev = /^\/api\/jobs\/([A-Za-z0-9]+)\/events$/.exec(url.pathname);
      if (ev) {
        if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'GET only');
        return serveEvents(req, res, ev[1]);
      }
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) {
        const known = Object.keys(routes).some((k) => k.endsWith(` ${url.pathname}`));
        throw new HttpError(known ? 405 : 404, known ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', known ? 'wrong method' : 'not found');
      }
      const out = await handler(req);
      if (out && out.status && out.body) sendJson(res, out.status, out.body); else sendJson(res, 200, out);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
      if (e instanceof HttpError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } });
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const addr = server.address();
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${shownHost}:${addr.port}`;
  if (host !== '0.0.0.0' && host !== '::') allowedHosts = new Set([`127.0.0.1:${addr.port}`, `localhost:${addr.port}`, `[::1]:${addr.port}`, `${shownHost}:${addr.port}`]);
  if (process.env.STUDIO_ACCESS_TOKEN === token) log(`Line Studio is running: ${url}/ (access token from STUDIO_ACCESS_TOKEN, ${mask(token)})`);
  else log(`Line Studio is running: ${url}/?token=${token}`);
  log(`  workspace ${root}; access token ${mask(token)} (the full token appears only in the address above)`);

  return {
    url, token, port: addr.port,
    async close() {
      closing = true;
      for (const ac of controllers) ac.abort();
      for (const j of jobs.values()) for (const res of j.subscribers || []) { try { res.end(); } catch { /* closed */ } }
      await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
