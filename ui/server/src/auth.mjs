// GitHub OAuth login and server-side session enforcement for the Cockpit
// backend (#278, part of epic #277).
//
// Why this module exists, stated plainly: every other route in this server
// runs Construct CLI commands (commandRunner.mjs), browses the filesystem
// (dirBrowse.mjs) and reads/writes source files under a *client-settable*
// project directory. Unauthenticated + reachable = remote code execution.
// #277 bound the listener to loopback as an immediate mitigation; this
// module is what makes exposing it deliberately actually safe.
//
// Design notes worth knowing before editing:
//
//   * Enforcement is server-side and mount-wide. index.mjs registers
//     `requireSession` on `/api` *before* every route it protects, so a
//     route added tomorrow is gated by default rather than by remembering
//     to opt in. The only public API route is `/api/health`, which is
//     registered above the middleware and returns `{ok:true}` and nothing
//     else.
//   * No new runtime dependency. The session is an HMAC-SHA256-signed,
//     base64url-encoded JSON payload verified with `timingSafeEqual`; the
//     OAuth code exchange is two plain `fetch` calls. `passport` is a lot
//     of machinery for one strategy, and `cookie-parser`/`cookie-signature`
//     would save ~20 lines that `node:crypto` already does correctly. The
//     module whose failure mode is "anyone gets in" is the last place to
//     take on supply-chain surface.
//   * The test-login escape hatch is a *login*, not a bypass — see
//     `resolveAuthConfig` and `POST /auth/test-login` below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from '../../../packages/engine/processStore.mjs';

export const SESSION_COOKIE = 'construct_session';
export const STATE_COOKIE = 'construct_oauth_state';
export const DEFAULT_SESSION_TTL_HOURS = 8;
const STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
// `read:user` is the narrowest scope that returns the authenticated user's
// login — which is the only thing the allowlist is checked against. We
// deliberately do not ask for `repo`: opening a project from GitHub (#277's
// sub-issue 3) can widen this when it actually needs to.
const OAUTH_SCOPE = 'read:user';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1', '']);

/** A host string this server can bind to that is *not* reachable from
 * another machine. Anything else counts as exposed, and exposure without
 * authentication is refused at startup. */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? '').trim().toLowerCase());
}

/** Thrown for a configuration the server must refuse to start with, as
 * opposed to a request-time failure. index.mjs prints `.message` and exits
 * 1 rather than dumping a stack trace at whoever ran `npm start`. */
export class AuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

// --------------------------------------------------------------------------
// Cookies
// --------------------------------------------------------------------------

/** Parse a `Cookie:` header into a null-prototype object. First occurrence
 * of a name wins (a second `construct_session=` appended by an attacker
 * cannot override the real one), and the result has no prototype so a
 * cookie literally named `__proto__` is inert. */
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Serialize one `Set-Cookie` value. `httpOnly` and `sameSite=Lax` are the
 * defaults rather than options a caller might forget. */
export function serializeCookie(name, value, { maxAge, secure = false, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (typeof maxAge === 'number') {
    parts.push(`Max-Age=${Math.floor(maxAge)}`);
    parts.push(`Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`);
  }
  if (httpOnly) parts.push('HttpOnly');
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// --------------------------------------------------------------------------
// Signed values
// --------------------------------------------------------------------------

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

/** `base64url(JSON) + "." + base64url(HMAC-SHA256)`. base64url contains no
 * `.`, so the separator is unambiguous. */
export function signValue(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** Verify signature and expiry. Returns the payload, or null — never
 * throws, and never distinguishes *why* it failed to the caller, so a
 * probing client learns nothing from the difference. */
export function verifyValue(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !secret) return null;
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || !(payload.exp > now)) return null;
  return payload;
}

/** A session is a verified value that additionally names a GitHub login. */
export function verifySession(token, secret, now = Date.now()) {
  const payload = verifyValue(token, secret, now);
  if (!payload || typeof payload.login !== 'string' || payload.login === '') return null;
  return payload;
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** `CONSTRUCT_ALLOWED_LOGINS` — comma (or whitespace) separated GitHub
 * logins. Compared case-insensitively, because GitHub logins are. */
export function parseAllowedLogins(raw) {
  return trimmed(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const SESSION_SECRET_FILE = 'session-secret';

/** `<stateDir>/session-secret` — where the generated secret lives when
 * `CONSTRUCT_SESSION_SECRET` is not set (#418). */
export function sessionSecretPath(stateDir) {
  return path.join(stateDir, SESSION_SECRET_FILE);
}

/**
 * The secret to sign sessions with when no `CONSTRUCT_SESSION_SECRET` is
 * configured: read from `<stateDir>/session-secret` if it exists, else
 * generated and stored there (#418, mitigating B12 in
 * docs/AUDIT-2026-09-oss-and-spof.md). Two calls with the same `stateDir`
 * return the same secret, so a server restart no longer signs everyone out
 * as long as the state directory survives it.
 *
 * Refuses a file that is readable or writable by anyone but its owner —
 * exactly like `ssh` refuses a group/world-readable private key — because
 * trusting it would let another account on a shared machine forge sessions.
 * An env-provided secret is never subject to this: it always wins, and this
 * function is not called at all when one is set.
 *
 * Narrow, accepted race: two processes starting for the very first time
 * against the same empty `stateDir` at the same instant can each generate
 * and write a different secret; the last `writeFileSync` wins on disk, but
 * the other process keeps the value it already generated in memory. This is
 * no worse than today's "one random secret per process" and is expected to
 * be hit essentially never (only ever on a state directory's first boot).
 */
export function loadOrCreatePersistedSecret(stateDir) {
  const file = sessionSecretPath(stateDir);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (stat) {
    if ((stat.mode & 0o077) !== 0) {
      throw new AuthConfigError(
        `${file} is readable or writable by users other than its owner (mode ${(stat.mode & 0o777).toString(8)}). ` +
          `Refusing to trust it as a session secret — like ssh refuses a group/world-readable private key. Fix it with: chmod 600 ${file}`,
      );
    }
    const secret = fs.readFileSync(file, 'utf8').trim();
    if (secret) return secret;
    // Fall through: an empty/corrupt file is regenerated below rather than trusted or left unusable.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/**
 * Resolve the whole auth posture from the environment, or throw
 * AuthConfigError for a configuration the server must not run with.
 *
 * The rules, in one place:
 *
 *  - OAuth credentials present  -> login required, always, loopback or not.
 *  - Bound to a non-loopback host without a way to log in -> refuse to
 *    start. This is what makes #277's loopback default meaningful: you
 *    cannot expose this server and still have it be open.
 *  - Loopback with nothing configured -> unauthenticated, as today, with a
 *    startup warning. Requiring every developer (and the e2e suite) to
 *    register an OAuth app to run a local cockpit would break dev for a
 *    threat model ("an attacker already on your machine, as you") that a
 *    cookie does not address anyway. `CONSTRUCT_AUTH=required` forces the
 *    gate on regardless.
 *  - `CONSTRUCT_AUTH=off` is honoured only on loopback.
 *
 * The test-login hatch (`CONSTRUCT_AUTH_TEST_USER`) is guarded here rather
 * than at request time on purpose: a box configured with it in production,
 * or exposed on a real interface, fails loudly at startup instead of
 * silently running with a back door.
 */
export function resolveAuthConfig(
  env = process.env,
  { host = '127.0.0.1', port = 4000, clientOrigin = 'http://localhost:3000', stateDir = resolveStateDir() } = {},
) {
  const loopback = isLoopbackHost(host);
  const clientId = trimmed(env.CONSTRUCT_GITHUB_CLIENT_ID);
  const clientSecret = trimmed(env.CONSTRUCT_GITHUB_CLIENT_SECRET);
  const oauthConfigured = Boolean(clientId && clientSecret);
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new AuthConfigError(
      'GitHub OAuth is half-configured: set both CONSTRUCT_GITHUB_CLIENT_ID and CONSTRUCT_GITHUB_CLIENT_SECRET, or neither.',
    );
  }

  const mode = trimmed(env.CONSTRUCT_AUTH).toLowerCase();
  if (mode && mode !== 'required' && mode !== 'off') {
    throw new AuthConfigError(`CONSTRUCT_AUTH must be "required" or "off" (got "${mode}").`);
  }

  const allowedLogins = parseAllowedLogins(env.CONSTRUCT_ALLOWED_LOGINS);

  const testUser = trimmed(env.CONSTRUCT_AUTH_TEST_USER);
  if (testUser) {
    // Case-insensitive on purpose. Node treats NODE_ENV as an opaque string
    // and deploy tooling is inconsistent about case, so a case-sensitive
    // compare here would let `NODE_ENV=Production` ship the hatch to
    // production — a narrow hole, but the one that matters most.
    if (trimmed(env.NODE_ENV).toLowerCase() === 'production') {
      throw new AuthConfigError(
        'CONSTRUCT_AUTH_TEST_USER is set while NODE_ENV=production. That variable mints a session without GitHub and exists only for the e2e suite — refusing to start rather than run with a back door. Unset it.',
      );
    }
    if (!loopback) {
      throw new AuthConfigError(
        `CONSTRUCT_AUTH_TEST_USER is set while bound to ${host}, which is not loopback. The test login must never be reachable from another machine — refusing to start. Unset it, or bind to 127.0.0.1.`,
      );
    }
    // One source of truth for "who may drive this Cockpit". Without this a
    // server running real OAuth *and* a stale test user would mint sessions
    // for a login the owner never allowed. Checked again at request time in
    // handleTestLogin so the two login paths cannot drift apart later.
    if (allowedLogins.length > 0 && !allowedLogins.includes(testUser.toLowerCase())) {
      throw new AuthConfigError(
        `CONSTRUCT_AUTH_TEST_USER is "${testUser}", which is not in CONSTRUCT_ALLOWED_LOGINS (${allowedLogins.join(', ')}). The test login must not be a second answer to who may use this Cockpit — add it to the allowlist, or unset it.`,
      );
    }
  }

  let required;
  if (mode === 'required') required = true;
  else if (mode === 'off') {
    if (!loopback) {
      throw new AuthConfigError(
        `CONSTRUCT_AUTH=off is refused while bound to ${host}, which is not loopback. This server runs commands and writes files; it is not something to expose unauthenticated.`,
      );
    }
    required = false;
  } else required = oauthConfigured || !loopback;

  if (required && !oauthConfigured && !testUser) {
    throw new AuthConfigError(
      `Login is required${loopback ? '' : ` (this server is bound to ${host}, not loopback)`} but there is no way to log in: set CONSTRUCT_GITHUB_CLIENT_ID and CONSTRUCT_GITHUB_CLIENT_SECRET (and CONSTRUCT_ALLOWED_LOGINS). See issue #278 for the setup steps.`,
    );
  }

  if (oauthConfigured && allowedLogins.length === 0) {
    throw new AuthConfigError(
      'GitHub OAuth is configured but CONSTRUCT_ALLOWED_LOGINS is empty. Without an allowlist, "login with GitHub" means every GitHub account on earth can drive this server. Set CONSTRUCT_ALLOWED_LOGINS to your own login.',
    );
  }

  const sessionSecretEnv = trimmed(env.CONSTRUCT_SESSION_SECRET);
  if (sessionSecretEnv && sessionSecretEnv.length < 16) {
    throw new AuthConfigError('CONSTRUCT_SESSION_SECRET must be at least 16 characters. Generate one with: openssl rand -hex 32');
  }
  // No secret configured: persisted at <stateDir>/session-secret (#418), so
  // a restart from the same state directory does not sign everyone out. An
  // env-provided secret always wins over the stored one.
  const sessionSecretFile = sessionSecretEnv ? null : sessionSecretPath(stateDir);
  const sessionSecret = sessionSecretEnv || loadOrCreatePersistedSecret(stateDir);

  const ttlHoursRaw = trimmed(env.CONSTRUCT_SESSION_TTL_HOURS);
  const ttlHours = ttlHoursRaw ? Number(ttlHoursRaw) : DEFAULT_SESSION_TTL_HOURS;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new AuthConfigError(`CONSTRUCT_SESSION_TTL_HOURS must be a positive number of hours (got "${ttlHoursRaw}").`);
  }

  return {
    required,
    oauthConfigured,
    clientId,
    clientSecret,
    allowedLogins,
    testUser,
    sessionSecret,
    ephemeralSecret: !sessionSecretEnv,
    sessionSecretFile,
    sessionTtlMs: ttlHours * 60 * 60 * 1000,
    // `Secure` would make the cookie unusable over plain http on loopback,
    // which is exactly how this is developed; anywhere else it is on.
    secureCookies: !loopback,
    loopback,
    host,
    clientOrigin,
    callbackUrl: trimmed(env.CONSTRUCT_OAUTH_CALLBACK_URL) || `http://localhost:${port}/auth/callback`,
  };
}

// --------------------------------------------------------------------------
// GitHub calls
// --------------------------------------------------------------------------

/** Exchange an authorization code for a token. Returns the token, or null
 * for any refusal — GitHub answers a bad or already-redeemed code with
 * `{error: "bad_verification_code"}` and HTTP 200, so the body must be
 * inspected rather than the status trusted. */
async function exchangeCode({ config, code, fetchImpl }) {
  const res = await fetchImpl(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'construct-cockpit' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  });
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || body.error || typeof body.access_token !== 'string' || !body.access_token) return null;
  return body.access_token;
}

/** Identify the token's owner. Returns `{login, name, avatarUrl}` or null. */
async function fetchGithubUser({ token, fetchImpl }) {
  const res = await fetchImpl(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'construct-cockpit',
    },
  });
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!body || typeof body.login !== 'string' || !body.login) return null;
  return { login: body.login, name: typeof body.name === 'string' ? body.name : null, avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null };
}

// --------------------------------------------------------------------------
// The auth object
// --------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Build the auth surface from a resolved config.
 *
 * `deps` exists so the tests can drive the OAuth round trip without a
 * network: `fetchImpl` stands in for GitHub, `now` for the clock and
 * `randomToken` for the CSRF state. `onLogout` (#378) runs when a session signs
 * out (with that session's login, or null when there is none; #569), so work the session started (the target app's dev server) stops with it.
 */
export function createAuth(config, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const now = deps.now || (() => Date.now());
  const randomToken = deps.randomToken || (() => crypto.randomBytes(24).toString('base64url'));
  // #378: signing out stops what the session started (the target app's dev server). Never blocks or fails the logout.
  const onLogout = typeof deps.onLogout === 'function' ? deps.onLogout : () => {};

  const testLoginEnabled = Boolean(config.testUser);

  function cookiesOf(headers) {
    return parseCookies(headers?.cookie);
  }

  /** The verified session on a request, or null. Used by the middleware,
   * by the WebSocket upgrade check, and by `/auth/session`. */
  function sessionFromHeaders(headers) {
    return verifySession(cookiesOf(headers)[SESSION_COOKIE], config.sessionSecret, now());
  }

  /** May this request proceed? True when auth is not required at all, or
   * when it carries a valid session. The WebSocket upgrade uses exactly
   * this, so the socket can never be more permissive than the REST API. */
  function allows(headers) {
    if (!config.required) return true;
    return sessionFromHeaders(headers) !== null;
  }

  function isAllowedLogin(login) {
    if (config.allowedLogins.length === 0) return false;
    return config.allowedLogins.includes(String(login).toLowerCase());
  }

  function setSessionCookie(res, user) {
    const issuedAt = now();
    const payload = {
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? null,
      iat: issuedAt,
      exp: issuedAt + config.sessionTtlMs,
    };
    res.append(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE, signValue(payload, config.sessionSecret), {
        maxAge: Math.floor(config.sessionTtlMs / 1000),
        secure: config.secureCookies,
      }),
    );
    return payload;
  }

  function clearCookie(res, name) {
    res.append('Set-Cookie', serializeCookie(name, '', { maxAge: 0, secure: config.secureCookies }));
  }

  /** Rolling renewal: re-issue once more than half the TTL has elapsed, so
   * an actively-used cockpit does not log itself out mid-session while an
   * abandoned one still expires. */
  function maybeRenew(res, session) {
    const elapsed = now() - (session.iat ?? 0);
    if (elapsed > config.sessionTtlMs / 2) {
      setSessionCookie(res, { login: session.login, name: session.name, avatarUrl: session.avatarUrl });
    }
  }

  /** The gate. index.mjs mounts this on `/api` above every route it
   * protects — not per route, so nothing can be added later that forgets
   * to be gated. */
  function requireSession(req, res, next) {
    if (!config.required) {
      req.session = null;
      return next();
    }
    const session = sessionFromHeaders(req.headers);
    if (!session) {
      return res.status(401).json({
        ok: false,
        code: 'auth_required',
        error: 'Authentication required. Sign in with GitHub to use this Cockpit.',
        loginPath: '/auth/login',
      });
    }
    req.session = session;
    maybeRenew(res, session);
    return next();
  }

  function sendError(res, status, title, detail) {
    res.status(status).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
        '<body style="font-family:system-ui,sans-serif;background:#0f1115;color:#e6e8ee;padding:3rem;line-height:1.6">' +
        `<h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
        `<p><a style="color:#7aa2f7" href="${escapeHtml(config.clientOrigin)}">Back to the Cockpit</a></p></body>`,
    );
  }

  // ---- route handlers ----

  function handleSession(req, res) {
    const session = config.required ? sessionFromHeaders(req.headers) : null;
    res.json({
      // `authRequired: false` is the honest answer for an unauthenticated
      // local run; the client renders the cockpit directly in that case.
      authRequired: config.required,
      authenticated: config.required ? session !== null : true,
      user: session ? { login: session.login, name: session.name ?? null, avatarUrl: session.avatarUrl ?? null } : null,
      githubConfigured: config.oauthConfigured,
      loginPath: '/auth/login',
      testLogin: testLoginEnabled,
      testLoginUser: testLoginEnabled ? config.testUser : null,
    });
  }

  function handleLogin(req, res) {
    if (!config.oauthConfigured) {
      return sendError(
        res,
        503,
        'GitHub login is not configured',
        'This server has no CONSTRUCT_GITHUB_CLIENT_ID / CONSTRUCT_GITHUB_CLIENT_SECRET set, so it cannot start a GitHub login.',
      );
    }
    const state = randomToken();
    // The state lives in a signed, httpOnly, short-lived cookie and is
    // compared against the `state` query parameter GitHub echoes back.
    // Signed rather than raw so a page that can write cookies for this
    // origin still cannot fixate a state it knows.
    res.append(
      'Set-Cookie',
      serializeCookie(STATE_COOKIE, signValue({ state, exp: now() + STATE_TTL_MS }, config.sessionSecret), {
        maxAge: Math.floor(STATE_TTL_MS / 1000),
        secure: config.secureCookies,
      }),
    );
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.callbackUrl);
    url.searchParams.set('scope', OAUTH_SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return res.redirect(302, url.toString());
  }

  async function handleCallback(req, res) {
    if (!config.oauthConfigured) return sendError(res, 503, 'GitHub login is not configured', 'No OAuth credentials are set on this server.');

    // Consumed unconditionally and first: a replayed callback URL finds no
    // state cookie the second time and is refused before any code is sent
    // to GitHub.
    const stateCookie = parseCookies(req.headers?.cookie)[STATE_COOKIE];
    clearCookie(res, STATE_COOKIE);

    const expected = verifyValue(stateCookie, config.sessionSecret, now());
    const provided = typeof req.query?.state === 'string' ? req.query.state : '';
    const expectedState = typeof expected?.state === 'string' ? expected.state : '';
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expectedState, 'utf8');
    if (!expectedState || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return sendError(
        res,
        400,
        'Login could not be completed',
        'The login state did not match, or it expired or was already used. Start the login again from the Cockpit.',
      );
    }

    const code = typeof req.query?.code === 'string' ? req.query.code : '';
    if (!code) return sendError(res, 400, 'Login could not be completed', 'GitHub did not return an authorization code.');

    let token;
    try {
      token = await exchangeCode({ config, code, fetchImpl });
    } catch {
      token = null;
    }
    if (!token) {
      return sendError(
        res,
        401,
        'GitHub refused the login',
        'The authorization code was rejected — it may have expired or already been used. Start the login again from the Cockpit.',
      );
    }

    let user;
    try {
      user = await fetchGithubUser({ token, fetchImpl });
    } catch {
      user = null;
    }
    if (!user) return sendError(res, 401, 'GitHub refused the login', 'The signed-in GitHub account could not be identified.');

    // The distinction #278 asks for: authenticating with GitHub perfectly
    // and still being refused. No session is issued here.
    if (!isAllowedLogin(user.login)) {
      return sendError(
        res,
        403,
        'This account is not allowed',
        `You signed in to GitHub as "${user.login}", but that account is not in this Cockpit's allowlist (CONSTRUCT_ALLOWED_LOGINS). Ask the owner to add it.`,
      );
    }

    setSessionCookie(res, user);
    return res.redirect(302, config.clientOrigin);
  }

  function handleLogout(req, res) {
    try { onLogout(sessionFromHeaders(req.headers)?.login ?? null); } catch { /* a cleanup hook must never keep someone signed in */ }
    clearCookie(res, SESSION_COOKIE);
    res.json({ ok: true });
  }

  /**
   * The e2e escape hatch — and it is a *login*, not a bypass.
   *
   * It does not make requests authenticate themselves and it does not
   * disable `requireSession`. It mints a normal signed session cookie for
   * one configured login, so Playwright proves the real gate by actually
   * logging in and holding a real cookie. There is no code path anywhere
   * in this module where "an env var is set" substitutes for "this request
   * carries a valid signed session".
   *
   * Four independent things have to be true for it to do anything:
   *   1. `CONSTRUCT_AUTH_TEST_USER` is set — otherwise this route 404s and
   *      does not exist.
   *   2. `NODE_ENV !== 'production'` — otherwise the process refused to
   *      start (resolveAuthConfig).
   *   3. The server is bound to loopback — otherwise, likewise.
   *   4. The request carries the Cockpit's own Origin — so a page in
   *      another tab cannot mint one in a developer's browser. Fail-closed:
   *      a request with no Origin at all (plain curl) is refused too.
   *   5. The configured login passes the same allowlist the OAuth callback
   *      applies, when an allowlist exists. Also enforced at startup; kept
   *      here so the two login paths cannot drift apart later.
   */
  function handleTestLogin(req, res) {
    if (!testLoginEnabled) return res.status(404).json({ ok: false, error: 'Not found' });
    const origin = req.get ? req.get('origin') : req.headers?.origin;
    if (origin !== config.clientOrigin) {
      return res.status(403).json({ ok: false, error: 'Refused: the test login only accepts requests from the Cockpit origin.' });
    }
    if (config.allowedLogins.length > 0 && !isAllowedLogin(config.testUser)) {
      return res.status(403).json({ ok: false, error: 'Refused: the test login user is not in CONSTRUCT_ALLOWED_LOGINS.' });
    }
    const session = setSessionCookie(res, { login: config.testUser, name: `${config.testUser} (test login)`, avatarUrl: null });
    return res.json({ ok: true, user: { login: session.login, name: session.name, avatarUrl: session.avatarUrl } });
  }

  /** Register the `/auth/*` surface. These routes are deliberately outside
   * `/api`, and therefore outside the gate — you cannot log in through a
   * door that requires you to already be logged in. */
  function mountRoutes(app) {
    app.get('/auth/session', handleSession);
    app.get('/auth/login', handleLogin);
    app.get('/auth/callback', handleCallback);
    app.post('/auth/logout', handleLogout);
    app.post('/auth/test-login', handleTestLogin);
    return app;
  }

  /** One-line startup summary + the warnings that matter. */
  function describeStartup() {
    const lines = [];
    if (!config.required) {
      lines.push({
        level: 'warn',
        text:
          'Authentication is OFF. This server runs CLI commands, browses the filesystem and writes source files — it is bound to loopback, so only this machine can reach it. Set CONSTRUCT_GITHUB_CLIENT_ID/SECRET and CONSTRUCT_ALLOWED_LOGINS to require a GitHub login (#278).',
      });
    } else if (config.oauthConfigured) {
      lines.push({ level: 'log', text: `Authentication: GitHub login required. Allowed logins: ${config.allowedLogins.join(', ')}.` });
    } else {
      lines.push({ level: 'log', text: 'Authentication: required (no GitHub OAuth app configured).' });
    }
    if (testLoginEnabled) {
      lines.push({
        level: 'warn',
        text: `TEST LOGIN ENABLED: POST /auth/test-login will mint a session for "${config.testUser}" without GitHub. This exists for the e2e suite, is refused under NODE_ENV=production and off loopback, and must never be set on a shared machine.`,
      });
    }
    if (config.required && config.ephemeralSecret) {
      lines.push({
        level: 'warn',
        text: `CONSTRUCT_SESSION_SECRET is not set — using a generated secret stored at ${config.sessionSecretFile}. Sessions survive a restart as long as that file does; set the env var instead to use your own.`,
      });
    }
    return lines;
  }

  return {
    config,
    required: config.required,
    testLoginEnabled,
    sessionFromHeaders,
    allows,
    isAllowedLogin,
    requireSession,
    mountRoutes,
    describeStartup,
    /** #638: the same plain error page, for the separate repository-connection callback (githubRepoApi.mjs). */
    sendError,
    // exported for tests / reuse
    handleSession,
    handleLogin,
    handleCallback,
    handleLogout,
    handleTestLogin,
  };
}
