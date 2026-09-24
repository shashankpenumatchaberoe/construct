// HTTP routes of the Studio editor. The server (server.mjs) calls the default export for `/editor` and `/api/editor/*`, after its
// own access-token check (this file never sees or stores the token):
//
//   handleEditorRequest(req, res, { workspace, url }) -> true when it answered, false when the path is not the editor's.
//
//   GET  /editor                                the page: ui/editor.html with its styles, script and modules inlined (page.mjs)
//   GET  /api/editor/projects                   list: name, modified, duration, clip counts per kind
//   POST /api/editor/projects                   { name, from? }  create blank, or from the Studio job `from`
//   POST /api/editor/projects/import            { bundle, slug?, name? }
//   GET  /api/editor/sources                    Studio jobs and media files to start from / add
//   GET  /api/editor/project/:slug              load (or create from the job of that name)
//   PUT  /api/editor/project/:slug              save { project, rev } (or If-Match); stale rev -> 409 with the current copy
//   DELETE /api/editor/project/:slug?confirm=<slug>   move to .trash/ (If-Match required)
//   PATCH /api/editor/project/:slug/rename      { to, rev }
//   POST /api/editor/project/:slug/duplicate    { name? }
//   GET  /api/editor/project/:slug/export       the project as one portable JSON bundle
//   GET|DELETE /api/editor/project/:slug/autosave   the recovery copy / discard it
//   POST /api/editor/project/:slug/ops          { op, args, rev }: the ONLY way the page edits; undo, redo, restoreAutosave included
//   POST /api/editor/project/:slug/render       { burnSubtitles? } renders the SAVED project -> { id }
//   GET  /api/editor/jobs/:id/events            server-sent events of a render
//   GET  /api/editor/media/:file                a workspace media file, with Range support
//
// The server's access-token gate runs before this handler (this file never sees or stores the token); the page carries the token it was
// opened with and sends it as a bearer header, or as ?token= for what a browser fetches without headers (media, downloads, events).
// No route takes a filesystem path: slugs and file names are [A-Za-z0-9._-] and are resolved inside the workspace's real path.
// Every write carries the rev it was made against; a stale one answers 409 { code: 'STALE_REV', current }.
import { execFile as nodeExecFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { applyOp, createHistory } from './ops.mjs';
import { AUDIO_EXT, EditorError, ERR, VIDEO_EXT, extOf, isBareName, listMedia, openWorkspace, resolveMedia } from './project.mjs';
import { pageCache } from './page.mjs';
import { renderProject } from './render.mjs';
import { checkSlug, openStore } from './store.mjs';

const MAX_BODY = 1024 * 1024;
const MEDIA_TYPES = {
  webm: 'video/webm', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', opus: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', vtt: 'text/vtt; charset=utf-8', srt: 'text/plain; charset=utf-8',
};
const SERVED_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, 'srt', 'vtt']);

/** `If-Match: 3`, `"3"` or `W/"3"` -> 3, else undefined. */
export function revFromHeader(value) {
  const m = typeof value === 'string' ? /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(value) : null;
  return m ? Number(m[1]) : undefined;
}

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  // An oversized body is read and dropped (not kept), then refused with the connection closed: destroying the socket mid-upload
  // leaves a keep-alive client waiting on a dead connection.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
    else if (size > 64 * MAX_BODY) { req.destroy(); break; }
  }
  if (size > MAX_BODY) throw new EditorError(ERR.TOO_LARGE, 'The request is too large.', 413);
  if (!size) return {};
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new EditorError(ERR.UNSUPPORTED_MEDIA, 'Send a JSON body (Content-Type: application/json).', 415);
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch { throw new EditorError(ERR.BAD_BODY, 'The body is not a JSON object.', 400); }
}

/**
 * Build a handler. `execFile` (ffmpeg runs) and `autosaveDelayMs` are seams for tests; the default export uses the real ones.
 * The handler keeps, per project, a working copy with its undo history in memory (a restart loses history, never saved work;
 * the recovery copy `<slug>.studio.autosave.json` is written a moment after each edit).
 */
export function createEditorHandler({ execFile = nodeExecFile, autosaveDelayMs = 1000, uiDir, maxJobs = 20 } = {}) {
  const page = pageCache(uiDir);
  const stores = new Map();
  const sessions = new Map();
  const jobs = new Map();
  let rendering = false;
  const storeFor = (workspace) => {
    const root = openWorkspace(workspace);
    if (!stores.has(root)) stores.set(root, openStore(root));
    return stores.get(root);
  };

  function session(store, slug) {
    const key = `${store.root}\0${slug}`;
    let s = sessions.get(key);
    if (!s) {
      const { project } = store.need(slug);
      const history = createHistory(project);
      s = { key, slug, store, history, saved: project, rev: project.rev ?? 0, timer: null };
      sessions.set(key, s);
    }
    return s;
  }
  const view = (s, extra = {}) => ({
    ok: true, slug: s.slug, project: { ...s.history.present, rev: s.rev }, rev: s.rev, dirty: s.history.present !== s.saved, canUndo: s.history.canUndo, canRedo: s.history.canRedo, ...extra,
  });
  function autosaveNow(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    try {
      if (s.history.present !== s.saved) s.store.writeAutosave(s.slug, { ...s.history.present, rev: s.rev });
      else s.store.clearAutosave(s.slug);
    } catch { /* the project was renamed or deleted meanwhile */ }
  }
  function scheduleAutosave(s) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => autosaveNow(s), autosaveDelayMs);
    s.timer.unref?.();
  }
  const dropSession = (store, slug) => {
    const key = `${store.root}\0${slug}`;
    const s = sessions.get(key);
    if (s?.timer) clearTimeout(s.timer);
    sessions.delete(key);
  };

  function pushEvent(job, event) {
    job.events.push(event);
    for (const write of job.listeners) write(event);
    if (event.type === 'done' || event.type === 'error') job.done = true;
  }

  function serveMedia(req, res, root, name) {
    const file = isBareName(name) && SERVED_EXT.has(extOf(name)) ? resolveMedia(root, name) : null;
    if (!file) return send(res, 404, { ok: false, code: ERR.NOT_FOUND, message: 'No such media file.' });
    const size = fs.statSync(file).size;
    const type = MEDIA_TYPES[extOf(name)] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    const header = req.headers.range;
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (header && !header.includes(',')) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
      if (!m || (m[1] === '' && m[2] === '')) return send(res, 416, { ok: false, code: ERR.BAD_RANGE, message: 'Unsatisfiable range.' }, { 'Content-Range': `bytes */${size}` });
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start >= size || start > end) return send(res, 416, { ok: false, code: ERR.BAD_RANGE, message: 'Unsatisfiable range.' }, { 'Content-Range': `bytes */${size}` });
      status = 206;
    }
    const length = size ? end - start + 1 : 0;
    res.writeHead(status, { ...base, 'Content-Length': length, ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    if (req.method === 'HEAD' || !size) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  }

  function servePage(req, res) {
    const { html, csp } = page();
    const body = Buffer.from(html);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function api(req, res, { workspace, segs, url }) {
    const method = req.method;
    const store = storeFor(workspace);
    const unsafe = method !== 'GET' && method !== 'HEAD';
    if (unsafe) {
      const origin = req.headers.origin;
      if (origin) {
        let host = null;
        try { host = new URL(origin).host; } catch { host = null; }
        if (host !== req.headers.host) throw new EditorError(ERR.FOREIGN_ORIGIN, 'This request came from another site.', 403);
      }
    }
    const body = unsafe && method !== 'DELETE' ? await readBody(req) : {};
    const ifMatch = revFromHeader(req.headers['if-match']);
    const revOf = () => ifMatch ?? (Number.isSafeInteger(body.rev) ? body.rev : undefined);
    const wrongMethod = () => send(res, 405, { ok: false, code: ERR.METHOD_NOT_ALLOWED, message: `${method} is not allowed here.` });
    const [head, a, b] = segs;

    if (head === 'projects' && a === undefined) {
      if (method === 'GET') return send(res, 200, { ok: true, projects: store.list() });
      if (method === 'POST') {
        const made = await store.createProject({ name: body.name, from: body.from, slug: body.slug }, { execFile });
        return send(res, 201, { ok: true, slug: made.slug, project: made.project, rev: made.project.rev });
      }
      return wrongMethod();
    }
    if (head === 'projects' && a === 'import' && b === undefined) {
      if (method !== 'POST') return wrongMethod();
      const made = store.importBundle(body.bundle, { slug: body.slug, name: body.name });
      return send(res, 201, { ok: true, slug: made.slug, project: made.project, rev: made.project.rev, missing: made.missing });
    }
    if (head === 'sources' && a === undefined) {
      if (method !== 'GET') return wrongMethod();
      return send(res, 200, { ok: true, jobs: store.jobs(), media: listMedia(store.root) });
    }
    if (head === 'project' && a !== undefined) {
      const slug = checkSlug(a);
      if (b === undefined) {
        if (method === 'GET') {
          let s;
          try { s = session(store, slug); } catch (e) {
            if (e.code !== ERR.NOT_FOUND || !store.jobs().some((j) => j.slug === slug)) throw e;
            await store.createProject({ name: slug, slug, from: slug }, { execFile });
            s = session(store, slug);
          }
          const recover = s.history.canUndo ? null : store.recoverable(slug);
          return send(res, 200, view(s, recover ? { recover: { updatedAt: recover.updatedAt } } : {}));
        }
        if (method === 'PUT') {
          const rev = revOf();
          if (body.project === undefined) throw new EditorError(ERR.BAD_BODY, 'Send { project, rev }.', 400);
          const saved = store.save(slug, body.project, rev);
          const s = session(store, slug);
          if (JSON.stringify(body.project.layers) !== JSON.stringify(s.history.present.layers)) s.history.push(body.project);
          s.saved = s.history.present;
          s.rev = saved.rev;
          if (s.timer) { clearTimeout(s.timer); s.timer = null; }
          return send(res, 200, view(s));
        }
        if (method === 'DELETE') {
          const out = store.trash(slug, { confirm: url.searchParams.get('confirm'), rev: ifMatch });
          dropSession(store, slug);
          return send(res, 200, { ok: true, ...out });
        }
        return wrongMethod();
      }
      if (b === 'rename') {
        if (method !== 'PATCH') return wrongMethod();
        const to = checkSlug(body.to);
        const out = store.rename(slug, to, revOf());
        dropSession(store, slug);
        return send(res, 200, { ok: true, slug: out.slug, project: out.project, rev: out.project.rev });
      }
      if (b === 'duplicate') {
        if (method !== 'POST') return wrongMethod();
        const out = store.duplicate(slug, { name: body.name });
        return send(res, 201, { ok: true, slug: out.slug, project: out.project, rev: out.project.rev });
      }
      if (b === 'export') {
        if (method !== 'GET') return wrongMethod();
        return send(res, 200, store.exportBundle(slug), { 'Content-Disposition': `attachment; filename="${slug}.studio-bundle.json"` });
      }
      if (b === 'autosave') {
        if (method === 'GET') {
          const a2 = store.readAutosave(slug);
          if (!a2) throw new EditorError(ERR.NO_AUTOSAVE, 'There is no recovery copy.', 404);
          return send(res, 200, { ok: true, project: a2.project, updatedAt: new Date(a2.mtimeMs).toISOString() });
        }
        if (method === 'DELETE') { store.clearAutosave(slug); return send(res, 200, { ok: true }); }
        return wrongMethod();
      }
      if (b === 'ops') {
        if (method !== 'POST') return wrongMethod();
        const key = `${store.root}\0${slug}`;
        const s = sessions.get(key);
        if (!s) {
          store.need(slug);
          throw new EditorError(ERR.NO_SESSION, 'Open the project first (GET it), then edit.', 409, { current: store.need(slug).project });
        }
        const rev = revOf();
        if (!Number.isSafeInteger(rev)) throw new EditorError(ERR.REV_REQUIRED, 'Send the rev you are editing (a "rev" field).', 400);
        if (rev !== s.rev) throw new EditorError(ERR.STALE_REV, 'This project changed since you opened it.', 409, { current: { ...s.history.present, rev: s.rev } });
        let extra = {};
        if (body.op === 'undo' || body.op === 'redo') {
          const r = body.op === 'undo' ? s.history.undo() : s.history.redo();
          if (!r) throw new EditorError(body.op === 'undo' ? ERR.NOTHING_TO_UNDO : ERR.NOTHING_TO_REDO, `Nothing to ${body.op}.`, 422);
        } else if (body.op === 'restoreAutosave') {
          const rec = store.readAutosave(slug);
          if (!rec) throw new EditorError(ERR.NO_AUTOSAVE, 'There is no recovery copy.', 404);
          s.history.push(rec.project);
        } else {
          const r = applyOp(s.history.present, body.op, body.args ?? {});
          if (!r.ok) return send(res, 422, { ok: false, code: r.code, message: r.message });
          s.history.push(r.project);
          extra = { ...(r.newClipId ? { newClipId: r.newClipId } : {}) };
        }
        scheduleAutosave(s);
        return send(res, 200, view(s, extra));
      }
      if (b === 'render') {
        if (method !== 'POST') return wrongMethod();
        const saved = store.need(slug).project;
        const s = sessions.get(`${store.root}\0${slug}`);
        if (s && s.history.present !== s.saved) throw new EditorError(ERR.UNSAVED, 'Save the project first; a render uses the saved copy.', 409);
        if (rendering) throw new EditorError(ERR.RENDER_BUSY, 'A render is already running.', 409);
        rendering = true;
        const id = crypto.randomBytes(6).toString('hex');
        const job = { id, slug, events: [], listeners: new Set(), done: false };
        jobs.set(id, job);
        for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - maxJobs))) jobs.delete(old);
        renderProject({ project: saved, workspace: store.root, slug, execFile, burnSubtitles: body.burnSubtitles === true, onEvent: (e) => pushEvent(job, e) })
          .catch(() => {})
          .finally(() => { rendering = false; });
        return send(res, 202, { ok: true, id });
      }
    }
    if (head === 'jobs' && a && b === 'events') {
      if (method !== 'GET') return wrongMethod();
      const job = /^[a-f0-9]{12}$/.test(a) ? jobs.get(a) : null;
      if (!job) throw new EditorError(ERR.NO_SUCH_JOB, 'No such render.', 404);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      const write = (e) => { res.write(`data: ${JSON.stringify(e)}\n\n`); if (e.type === 'done' || e.type === 'error') { job.listeners.delete(write); res.end(); } };
      res.write(': render events\n\n');
      for (const e of job.events) write(e);
      if (!job.done) { job.listeners.add(write); res.on('close', () => job.listeners.delete(write)); }
      return undefined;
    }
    if (head === 'media' && a !== undefined && b === undefined) {
      if (method !== 'GET' && method !== 'HEAD') return wrongMethod();
      return serveMedia(req, res, store.root, a);
    }
    return send(res, 404, { ok: false, code: ERR.NOT_FOUND, message: 'No such editor route.' });
  }

  /** Answers `/editor` and `/api/editor/*`; returns false for any other path so the caller can carry on. */
  async function handle(req, res, { workspace, url } = {}) {
    const u = url instanceof URL ? url : new URL(String(url ?? req.url ?? '/'), 'http://localhost');
    const p = u.pathname;
    const isPage = p === '/editor' || p === '/editor/';
    if (!isPage && !p.startsWith('/api/editor/') && p !== '/api/editor') return false;
    try {
      if (!workspace) throw new EditorError(ERR.NOT_FOUND, 'No workspace.', 500);
      if (isPage) {
        if (req.method !== 'GET' && req.method !== 'HEAD') send(res, 405, { ok: false, code: ERR.METHOD_NOT_ALLOWED, message: 'GET only.' });
        else servePage(req, res);
        return true;
      }
      const segs = p.slice('/api/editor/'.length).split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return '\u0000'; } });
      if (segs.some((x) => x.includes('\u0000') || x.includes('/') || x.includes('\\'))) throw new EditorError(ERR.BAD_FILE, 'Bad path.', 400);
      await api(req, res, { workspace, segs, url: u });
    } catch (e) {
      if (res.headersSent) { res.end(); return true; }
      if (e instanceof EditorError) {
        send(res, e.status, { ok: false, code: e.code, message: e.message, ...(e.current ? { current: e.current } : {}), ...(e.errors ? { errors: e.errors } : {}) }, e.code === ERR.TOO_LARGE ? { Connection: 'close' } : {});
      } else send(res, 500, { ok: false, code: 'INTERNAL', message: 'The editor could not handle that request.' });
    }
    return true;
  }
  /** Write every pending recovery copy now (tests, shutdown). */
  handle.flush = () => { for (const s of sessions.values()) if (s.timer) autosaveNow(s); };
  handle.close = () => { for (const s of sessions.values()) if (s.timer) clearTimeout(s.timer); sessions.clear(); };
  return handle;
}

export const handleEditorRequest = createEditorHandler();
export default handleEditorRequest;
