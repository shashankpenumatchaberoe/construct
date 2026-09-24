// The page's only door to the server: JSON in, JSON out, errors carry the server's `code`. No editing logic lives in the browser;
// every change to a project is `ops()` (the server applies it and answers with the whole new project).
//
// Access token: Studio's server refuses every /editor and /api/ request without the token it printed at start. The page reads it
// from `?token=` (the Studio page links here with it), keeps it for this tab only (sessionStorage, the key the Studio page uses),
// removes it from the address bar, and sends it as `Authorization: Bearer`. Things a browser fetches without headers (media in a
// <video>, an EventSource, a download link) carry it as `?token=` instead.
const BASE = '/api/editor';

const remember = (fn) => { try { return fn(); } catch { return ''; } };
let token = new URLSearchParams(location.search).get('token') || '';
if (token) {
  remember(() => sessionStorage.setItem('studio-token', token));
  remember(() => history.replaceState(null, '', location.pathname + location.hash));
} else token = remember(() => sessionStorage.getItem('studio-token')) || '';

const withToken = (url) => (token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url);

export class ApiError extends Error {
  constructor(status, data) {
    const e = (data && data.error) || data || {};
    super(status === 401 ? 'Studio needs its access token. Open the editor from the Studio page, or use the address Studio printed.' : e.message || `Request failed (${status})`);
    this.status = status;
    this.code = e.code;
    this.data = data || {};
  }
}

export async function call(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try { res = await fetch(BASE + path, init); } catch { throw new ApiError(0, { code: 'OFFLINE', message: 'Cannot reach Studio. Is it still running?' }); }
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.ok === false)) throw new ApiError(res.status, data);
  return data;
}

const enc = encodeURIComponent;
export const api = {
  projects: () => call('GET', '/projects'),
  sources: () => call('GET', '/sources'),
  create: (body) => call('POST', '/projects', body),
  importBundle: (bundle, name) => call('POST', '/projects/import', { bundle, name }),
  load: (slug) => call('GET', `/project/${enc(slug)}`),
  save: (slug, project, rev) => call('PUT', `/project/${enc(slug)}`, { project, rev }),
  ops: (slug, op, args, rev) => call('POST', `/project/${enc(slug)}/ops`, { op, args, rev }),
  rename: (slug, to, rev) => call('PATCH', `/project/${enc(slug)}/rename`, { to, rev }),
  duplicate: (slug) => call('POST', `/project/${enc(slug)}/duplicate`, {}),
  trash: (slug, rev) => call('DELETE', `/project/${enc(slug)}?confirm=${enc(slug)}`, undefined, { 'If-Match': String(rev) }),
  exportBundle: (slug) => call('GET', `/project/${enc(slug)}/export`),
  discardAutosave: (slug) => call('DELETE', `/project/${enc(slug)}/autosave`),
  render: (slug, burnSubtitles) => call('POST', `/project/${enc(slug)}/render`, { burnSubtitles }),
  mediaUrl: (name) => withToken(`${BASE}/media/${enc(name)}`),
  eventsUrl: (id) => withToken(`${BASE}/jobs/${enc(id)}/events`),
};
