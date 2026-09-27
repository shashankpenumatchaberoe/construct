// Unit + round-trip coverage for the GitHub login gate (#278).
//
// The OAuth round trip runs against a real Express app with a fake GitHub
// injected (`fetchImpl`) — no network, but every byte of the real handler
// code, including the state cookie, the code exchange and the allowlist.
//
// workspaceRoot.mjs is imported FIRST (same as settings.test.mjs) so every
// `resolveAuthConfig` call in this file that omits `CONSTRUCT_SESSION_SECRET`
// falls back to a private per-process CONSTRUCT_STATE_DIR rather than the
// developer's real `~/.local/state/construct` (#418).
import '../../../test-utils/workspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import {
  AuthConfigError,
  SESSION_COOKIE,
  STATE_COOKIE,
  createAuth,
  isLoopbackHost,
  loadOrCreatePersistedSecret,
  parseAllowedLogins,
  parseCookies,
  resolveAuthConfig,
  serializeCookie,
  sessionSecretPath,
  signValue,
  verifySession,
  verifyValue,
} from './auth.mjs';

const SECRET = 'a'.repeat(48);
const OAUTH_ENV = {
  CONSTRUCT_GITHUB_CLIENT_ID: 'client-id',
  CONSTRUCT_GITHUB_CLIENT_SECRET: 'client-secret',
  CONSTRUCT_ALLOWED_LOGINS: 'owner-login',
  CONSTRUCT_SESSION_SECRET: SECRET,
};

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

test('parseCookies handles real headers, and cannot be confused or polluted', () => {
  assert.deepEqual({ ...parseCookies('a=1; b=two') }, { a: '1', b: 'two' });
  assert.deepEqual({ ...parseCookies('') }, {});
  assert.deepEqual({ ...parseCookies(undefined) }, {});
  // First occurrence wins: appending a second cookie of the same name must
  // not override the real session.
  assert.equal(parseCookies(`${SESSION_COOKIE}=real; ${SESSION_COOKIE}=forged`)[SESSION_COOKIE], 'real');
  // A cookie literally named __proto__ is inert on a null-prototype object.
  const polluted = parseCookies('__proto__=x; a=1');
  assert.equal(polluted.a, '1');
  assert.equal(Object.getPrototypeOf(polluted), null);
  assert.equal({}.x, undefined);
  // Quoted values, percent-encoding, and junk segments.
  assert.equal(parseCookies('q="quoted"')['q'], 'quoted');
  assert.equal(parseCookies('e=a%20b')['e'], 'a b');
  assert.equal(parseCookies('e=%E0%A4%A')['e'], '%E0%A4%A'); // invalid escape falls back to raw
  assert.deepEqual({ ...parseCookies('novalue; =empty; a=1') }, { a: '1' });
});

test('serializeCookie always sets HttpOnly/SameSite, and Secure only when asked', () => {
  const c = serializeCookie(SESSION_COOKIE, 'v', { maxAge: 60, secure: true });
  assert.match(c, /^construct_session=v; Path=\/; Max-Age=60; Expires=/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.ok(!serializeCookie('n', 'v').includes('Secure'));
  assert.equal(serializeCookie('n', 'a b').split(';')[0], 'n=a%20b');
});

// ---------------------------------------------------------------------------
// Signed values
// ---------------------------------------------------------------------------

test('a signed session round-trips, and every way of breaking it is rejected', () => {
  const now = 1_000_000;
  const token = signValue({ login: 'owner-login', exp: now + 1000 }, SECRET);
  assert.equal(verifySession(token, SECRET, now).login, 'owner-login');

  // Wrong secret.
  assert.equal(verifySession(token, 'b'.repeat(48), now), null);
  // Expired.
  assert.equal(verifySession(token, SECRET, now + 1001), null);
  // Tampered payload, signature left alone.
  const forgedBody = Buffer.from(JSON.stringify({ login: 'attacker', exp: now + 1000 }), 'utf8').toString('base64url');
  assert.equal(verifySession(`${forgedBody}.${token.split('.')[1]}`, SECRET, now), null);
  // Truncated signature (length mismatch must not throw in timingSafeEqual).
  assert.equal(verifySession(`${token.slice(0, -4)}`, SECRET, now), null);
  // Structural junk.
  for (const bad of ['', 'x', '.', 'a.', '.b', 'not-a-token', null, undefined, 42]) {
    assert.equal(verifySession(bad, SECRET, now), null);
  }
  // A value that verifies but names no login is not a session.
  assert.equal(verifySession(signValue({ exp: now + 1000 }, SECRET), SECRET, now), null);
  assert.equal(verifyValue(signValue({ exp: now + 1000 }, SECRET), SECRET, now).exp, now + 1000);
  // A payload with no exp never verifies — an eternal session is not a thing.
  assert.equal(verifyValue(signValue({ login: 'x' }, SECRET), SECRET, now), null);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('isLoopbackHost knows what is and is not reachable from elsewhere', () => {
  for (const h of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '']) assert.equal(isLoopbackHost(h), true);
  for (const h of ['0.0.0.0', '192.168.1.5', 'cockpit.example.com', '::']) assert.equal(isLoopbackHost(h), false);
});

test('parseAllowedLogins splits and lowercases', () => {
  assert.deepEqual(parseAllowedLogins(' Owner, Second\nThird '), ['owner', 'second', 'third']);
  assert.deepEqual(parseAllowedLogins(''), []);
  assert.deepEqual(parseAllowedLogins(undefined), []);
});

test('loopback with nothing configured stays open (today’s behaviour), OAuth turns the gate on', () => {
  const open = resolveAuthConfig({}, { host: '127.0.0.1' });
  assert.equal(open.required, false);
  assert.equal(open.secureCookies, false);

  const gated = resolveAuthConfig(OAUTH_ENV, { host: '127.0.0.1' });
  assert.equal(gated.required, true);
  assert.equal(gated.oauthConfigured, true);
  assert.deepEqual(gated.allowedLogins, ['owner-login']);
  // Secure cookies would be unusable over plain http on loopback.
  assert.equal(gated.secureCookies, false);
  assert.equal(resolveAuthConfig(OAUTH_ENV, { host: '0.0.0.0' }).secureCookies, true);
});

test('the server refuses to start in every unsafe configuration', () => {
  const refuses = (env, opts, re) =>
    assert.throws(() => resolveAuthConfig(env, opts), (e) => e instanceof AuthConfigError && re.test(e.message), `expected refusal matching ${re}`);

  // Exposed on a real interface with no way to log in.
  refuses({}, { host: '0.0.0.0' }, /no way to log in/);
  // Exposed and explicitly told to be open anyway.
  refuses({ CONSTRUCT_AUTH: 'off' }, { host: '0.0.0.0' }, /refused while bound to/);
  // OAuth configured, but the allowlist is empty — "login with GitHub"
  // would otherwise mean every GitHub account on earth.
  refuses({ ...OAUTH_ENV, CONSTRUCT_ALLOWED_LOGINS: '' }, {}, /every GitHub account on earth/);
  // Half-configured credentials.
  refuses({ CONSTRUCT_GITHUB_CLIENT_ID: 'x' }, {}, /half-configured/);
  // Nonsense values.
  refuses({ CONSTRUCT_AUTH: 'maybe' }, {}, /must be "required" or "off"/);
  refuses({ ...OAUTH_ENV, CONSTRUCT_SESSION_SECRET: 'short' }, {}, /at least 16 characters/);
  refuses({ ...OAUTH_ENV, CONSTRUCT_SESSION_TTL_HOURS: '-3' }, {}, /positive number of hours/);
  // Required with no credentials and no test login.
  refuses({ CONSTRUCT_AUTH: 'required' }, {}, /no way to log in/);
});

test('the e2e test login is refused in production and off loopback — at startup, not per request', () => {
  const env = { CONSTRUCT_AUTH: 'required', CONSTRUCT_AUTH_TEST_USER: 'e2e-user', CONSTRUCT_SESSION_SECRET: SECRET };
  // The only configuration it is allowed in.
  const ok = resolveAuthConfig(env, { host: '127.0.0.1' });
  assert.equal(ok.required, true);
  assert.equal(ok.testUser, 'e2e-user');

  assert.throws(
    () => resolveAuthConfig({ ...env, NODE_ENV: 'production' }, { host: '127.0.0.1' }),
    (e) => e instanceof AuthConfigError && /NODE_ENV=production/.test(e.message),
  );
  assert.throws(
    () => resolveAuthConfig(env, { host: '0.0.0.0' }),
    (e) => e instanceof AuthConfigError && /not loopback/.test(e.message),
  );
});

test('the production refusal is case-insensitive — NODE_ENV=Production is still production', () => {
  const env = { CONSTRUCT_AUTH: 'required', CONSTRUCT_AUTH_TEST_USER: 'e2e-user', CONSTRUCT_SESSION_SECRET: SECRET };
  for (const value of ['production', 'Production', 'PRODUCTION', '  production  ']) {
    assert.throws(
      () => resolveAuthConfig({ ...env, NODE_ENV: value }, { host: '127.0.0.1' }),
      (e) => e instanceof AuthConfigError && /NODE_ENV=production/.test(e.message),
      `NODE_ENV=${JSON.stringify(value)} must refuse to start`,
    );
  }
  // A non-production value is still fine.
  assert.equal(resolveAuthConfig({ ...env, NODE_ENV: 'test' }, { host: '127.0.0.1' }).testUser, 'e2e-user');
});

test('the test login is not a second answer to who may use this Cockpit', () => {
  // With a real allowlist in play, a test user who is not on it is refused
  // at startup rather than silently minting sessions for an unlisted login.
  assert.throws(
    () => resolveAuthConfig({ ...OAUTH_ENV, CONSTRUCT_AUTH_TEST_USER: 'someone-else' }, { host: '127.0.0.1' }),
    (e) => e instanceof AuthConfigError && /not in CONSTRUCT_ALLOWED_LOGINS/.test(e.message),
  );
  // On the allowlist (case-insensitively) it is allowed.
  assert.equal(
    resolveAuthConfig({ ...OAUTH_ENV, CONSTRUCT_AUTH_TEST_USER: 'Owner-Login' }, { host: '127.0.0.1' }).testUser,
    'Owner-Login',
  );
  // No allowlist configured at all (the plain e2e posture) stays allowed.
  assert.equal(
    resolveAuthConfig({ CONSTRUCT_AUTH: 'required', CONSTRUCT_AUTH_TEST_USER: 'e2e-user', CONSTRUCT_SESSION_SECRET: SECRET }, { host: '127.0.0.1' }).testUser,
    'e2e-user',
  );
});

test('CONSTRUCT_AUTH=off is honoured on loopback only', () => {
  assert.equal(resolveAuthConfig({ ...OAUTH_ENV, CONSTRUCT_AUTH: 'off' }, { host: '127.0.0.1' }).required, false);
});

// ---------------------------------------------------------------------------
// Persisted session secret (#418) — a restart from the same state directory
// must not sign everyone out.
// ---------------------------------------------------------------------------

test('two resolveAuthConfig calls with the same state dir yield the same generated secret', () => {
  const stateDir = makeTempDir('auth-secret-');
  const first = resolveAuthConfig({}, { host: '127.0.0.1', stateDir });
  const second = resolveAuthConfig({}, { host: '127.0.0.1', stateDir });
  assert.equal(first.sessionSecret, second.sessionSecret);
  assert.equal(first.ephemeralSecret, true);
  assert.equal(first.sessionSecretFile, sessionSecretPath(stateDir));
  // Persisted with owner-only permissions.
  const mode = fs.statSync(sessionSecretPath(stateDir)).mode & 0o777;
  assert.equal(mode, 0o600);
  // And it round-trips: the file on disk is exactly the secret handed back.
  assert.equal(fs.readFileSync(sessionSecretPath(stateDir), 'utf8').trim(), first.sessionSecret);
});

test('a session cookie signed before a simulated restart still verifies after it, via the persisted secret', () => {
  const stateDir = makeTempDir('auth-secret-restart-');
  const before = resolveAuthConfig({}, { host: '127.0.0.1', stateDir });
  const token = signValue({ login: 'owner-login', exp: Date.now() + 60_000 }, before.sessionSecret);
  // A fresh resolveAuthConfig call stands in for a fresh server process starting up again.
  const after = resolveAuthConfig({}, { host: '127.0.0.1', stateDir });
  assert.ok(verifyValue(token, after.sessionSecret), 'the cookie must still verify against the secret a "restarted" process resolves');
});

test('an env-provided CONSTRUCT_SESSION_SECRET always wins over a stored one, and touches no file', () => {
  const stateDir = makeTempDir('auth-secret-env-wins-');
  const config = resolveAuthConfig({ CONSTRUCT_SESSION_SECRET: SECRET }, { host: '127.0.0.1', stateDir });
  assert.equal(config.sessionSecret, SECRET);
  assert.equal(config.ephemeralSecret, false);
  assert.equal(config.sessionSecretFile, null);
  assert.equal(fs.existsSync(sessionSecretPath(stateDir)), false);
});

test('a group/world-readable session-secret file is refused, like ssh refuses such a private key', () => {
  const stateDir = makeTempDir('auth-secret-perms-');
  const file = sessionSecretPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, 'a'.repeat(64), { mode: 0o644 });
  assert.throws(
    () => resolveAuthConfig({}, { host: '127.0.0.1', stateDir }),
    (e) => e instanceof AuthConfigError && /readable or writable by users other than its owner/.test(e.message) && /chmod 600/.test(e.message),
  );
  // Fixing the permissions makes it trusted again, unchanged.
  fs.chmodSync(file, 0o600);
  assert.equal(resolveAuthConfig({}, { host: '127.0.0.1', stateDir }).sessionSecret, 'a'.repeat(64));
});

test('loadOrCreatePersistedSecret: a 0640 (group-readable) file is refused just like 0644', () => {
  const stateDir = makeTempDir('auth-secret-perms-group-');
  const file = sessionSecretPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, 'b'.repeat(64), { mode: 0o640 });
  assert.throws(() => loadOrCreatePersistedSecret(stateDir), (e) => e instanceof AuthConfigError);
});

test('the startup warning names where the generated secret is stored, once persistence is in play', () => {
  const stateDir = makeTempDir('auth-secret-warn-');
  const config = resolveAuthConfig({ CONSTRUCT_AUTH: 'required', CONSTRUCT_AUTH_TEST_USER: 'e2e-user' }, { host: '127.0.0.1', stateDir });
  const auth = createAuth(config);
  const warning = auth.describeStartup().find((l) => /CONSTRUCT_SESSION_SECRET is not set/.test(l.text));
  assert.ok(warning, 'expected the ephemeral-secret warning to be present');
  assert.match(warning.text, /using a generated secret stored at/);
  assert.ok(warning.text.includes(sessionSecretPath(stateDir)));
  assert.match(warning.text, /survive/);
});

// ---------------------------------------------------------------------------
// The gate and the OAuth round trip, against a real Express app
// ---------------------------------------------------------------------------

function fakeGithub({ token = 'gh-token', user = { login: 'owner-login', name: 'Owner', avatar_url: 'https://avatars/owner.png' }, tokenBody } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).includes('login/oauth/access_token')) {
      const body = tokenBody ?? { access_token: token, token_type: 'bearer', scope: 'read:user' };
      return { ok: true, json: async () => body };
    }
    if (String(url).includes('api.github.com/user')) {
      if (init?.headers?.Authorization !== `Bearer ${token}`) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => user };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return { fetchImpl, calls };
}

/** Boot a real Express app carrying the real auth routes and a gated route,
 * on an ephemeral port. */
async function withApp({ env = OAUTH_ENV, host = '127.0.0.1', deps = {} }, fn) {
  const config = resolveAuthConfig(env, { host, clientOrigin: 'http://localhost:3000' });
  const auth = createAuth(config, deps);
  const app = express();
  app.use(express.json());
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  auth.mountRoutes(app);
  app.use('/api', auth.requireSession);
  app.get('/api/settings', (req, res) => res.json({ ok: true, login: req.session?.login ?? null }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, auth, config });
  } finally {
    server.close();
  }
}

const cookieHeader = (res, name) => (res.headers.getSetCookie() || []).find((c) => c.startsWith(`${name}=`)) || null;
const cookieValue = (res, name) => {
  const set = cookieHeader(res, name);
  return set ? decodeURIComponent(set.slice(name.length + 1).split(';')[0]) : null;
};

test('an unauthenticated request is refused with 401, and /api/health stays public', async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'auth_required');
    assert.equal(body.loginPath, '/auth/login');

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  });
});

test('a forged, tampered or expired cookie is refused exactly like no cookie at all', async () => {
  await withApp({}, async ({ base }) => {
    const forged = signValue({ login: 'owner-login', exp: Date.now() + 60_000 }, 'not-the-real-secret-at-all');
    const expired = signValue({ login: 'owner-login', exp: Date.now() - 1 }, SECRET);
    for (const value of [forged, expired, 'garbage', '']) {
      const res = await fetch(`${base}/api/settings`, { headers: { cookie: `${SESSION_COOKIE}=${value}` } });
      assert.equal(res.status, 401, `expected 401 for cookie "${value.slice(0, 12)}"`);
    }
  });
});

test('the full GitHub round trip issues a session that then opens the API', async () => {
  const gh = fakeGithub();
  await withApp({ deps: { ...gh, randomToken: () => 'state-123' } }, async ({ base }) => {
    const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const target = new URL(login.headers.get('location'));
    assert.equal(target.origin + target.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(target.searchParams.get('client_id'), 'client-id');
    assert.equal(target.searchParams.get('state'), 'state-123');
    assert.equal(target.searchParams.get('scope'), 'read:user');
    const state = cookieValue(login, STATE_COOKIE);
    assert.ok(state, 'login must set a state cookie');
    assert.match(cookieHeader(login, STATE_COOKIE), /HttpOnly/);

    const cb = await fetch(`${base}/auth/callback?code=good-code&state=state-123`, {
      redirect: 'manual',
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(state)}` },
    });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get('location'), 'http://localhost:3000');
    const session = cookieValue(cb, SESSION_COOKIE);
    assert.ok(session, 'callback must set a session cookie');
    assert.match(cookieHeader(cb, SESSION_COOKIE), /HttpOnly/);
    assert.match(cookieHeader(cb, SESSION_COOKIE), /SameSite=Lax/);
    // The state cookie is cleared, so the same callback URL cannot be replayed.
    assert.match(cookieHeader(cb, STATE_COOKIE), /Max-Age=0/);

    const api = await fetch(`${base}/api/settings`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).login, 'owner-login');

    const who = await fetch(`${base}/auth/session`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } });
    const whoBody = await who.json();
    assert.equal(whoBody.authenticated, true);
    assert.equal(whoBody.user.login, 'owner-login');
    assert.equal(whoBody.user.avatarUrl, 'https://avatars/owner.png');
    assert.equal(whoBody.testLogin, false);

    const out = await fetch(`${base}/auth/logout`, { method: 'POST' });
    assert.match(cookieHeader(out, SESSION_COOKIE), /Max-Age=0/);
  });
});

test('a callback with a bad, replayed or state-less code is refused and issues no session', async () => {
  const bad = fakeGithub({ tokenBody: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } });
  await withApp({ deps: { ...bad, randomToken: () => 's1' } }, async ({ base }) => {
    const state = cookieValue(await fetch(`${base}/auth/login`, { redirect: 'manual' }), STATE_COOKIE);
    // GitHub answers a reused/expired code with HTTP 200 and an error body —
    // the body has to be inspected, not the status trusted.
    const res = await fetch(`${base}/auth/callback?code=already-used&state=s1`, {
      redirect: 'manual',
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(state)}` },
    });
    assert.equal(res.status, 401);
    assert.equal(cookieHeader(res, SESSION_COOKIE), null);
  });

  const gh = fakeGithub();
  await withApp({ deps: { ...gh, randomToken: () => 's2' } }, async ({ base }) => {
    // Replay: the state cookie was consumed by the first callback, so a
    // second identical request carries none. Refused before the code is
    // ever sent to GitHub.
    const res = await fetch(`${base}/auth/callback?code=good-code&state=s2`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    assert.equal(cookieHeader(res, SESSION_COOKIE), null);
    assert.equal(gh.calls.length, 0, 'a state-less callback must not reach GitHub at all');

    // A state that does not match the cookie is equally refused.
    const stateCookie = cookieValue(await fetch(`${base}/auth/login`, { redirect: 'manual' }), STATE_COOKIE);
    const mismatch = await fetch(`${base}/auth/callback?code=good-code&state=attacker-chosen`, {
      redirect: 'manual',
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
    assert.equal(mismatch.status, 400);
    assert.equal(cookieHeader(mismatch, SESSION_COOKIE), null);

    // Missing code, valid state.
    const state3 = cookieValue(await fetch(`${base}/auth/login`, { redirect: 'manual' }), STATE_COOKIE);
    const noCode = await fetch(`${base}/auth/callback?state=s2`, { redirect: 'manual', headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(state3)}` } });
    assert.equal(noCode.status, 400);
  });
});

test('a real GitHub user who is not on the allowlist is refused — authenticated, still denied', async () => {
  const gh = fakeGithub({ user: { login: 'some-other-person', name: 'Somebody', avatar_url: 'https://avatars/x.png' } });
  await withApp({ deps: { ...gh, randomToken: () => 's' } }, async ({ base }) => {
    const state = cookieValue(await fetch(`${base}/auth/login`, { redirect: 'manual' }), STATE_COOKIE);
    const res = await fetch(`${base}/auth/callback?code=good&state=s`, {
      redirect: 'manual',
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(state)}` },
    });
    assert.equal(res.status, 403);
    assert.equal(cookieHeader(res, SESSION_COOKIE), null, 'a refused login must not leave a session behind');
    const html = await res.text();
    assert.match(html, /some-other-person/);
    assert.match(html, /CONSTRUCT_ALLOWED_LOGINS/);
    // The GitHub token exchange happened — this is a refusal *after* a
    // successful GitHub authentication, which is the point.
    assert.equal(gh.calls.length, 2);
  });
});

test('the allowlist is case-insensitive but not a substring match', () => {
  const auth = createAuth(resolveAuthConfig({ ...OAUTH_ENV, CONSTRUCT_ALLOWED_LOGINS: 'Owner-Login, second' }, {}));
  assert.equal(auth.isAllowedLogin('owner-login'), true);
  assert.equal(auth.isAllowedLogin('OWNER-LOGIN'), true);
  assert.equal(auth.isAllowedLogin('second'), true);
  assert.equal(auth.isAllowedLogin('owner-login-2'), false);
  assert.equal(auth.isAllowedLogin('owner'), false);
  assert.equal(auth.isAllowedLogin(''), false);
});

// ---------------------------------------------------------------------------
// The test login
// ---------------------------------------------------------------------------

const TEST_ENV = { CONSTRUCT_AUTH: 'required', CONSTRUCT_AUTH_TEST_USER: 'e2e-user', CONSTRUCT_SESSION_SECRET: SECRET };

test('the test login does not exist unless it is configured', async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/auth/test-login`, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    assert.equal(res.status, 404);
    assert.equal(cookieHeader(res, SESSION_COOKIE), null);
  });
});

test('the test login mints a real session — the gate stays armed either side of it', async () => {
  await withApp({ env: TEST_ENV }, async ({ base }) => {
    // Still 401 before logging in: the env var does not authenticate anything.
    assert.equal((await fetch(`${base}/api/settings`)).status, 401);

    // Refused without the Cockpit's own origin, so another tab cannot mint one.
    assert.equal((await fetch(`${base}/auth/test-login`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/auth/test-login`, { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);

    const res = await fetch(`${base}/auth/test-login`, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    assert.equal(res.status, 200);
    const session = cookieValue(res, SESSION_COOKIE);
    assert.ok(session);

    // It is an ordinary signed session, indistinguishable from an OAuth one.
    assert.equal(verifySession(session, SECRET).login, 'e2e-user');
    const api = await fetch(`${base}/api/settings`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).login, 'e2e-user');

    // And a cookie signed with a different secret still gets nowhere.
    const forged = signValue({ login: 'e2e-user', exp: Date.now() + 60_000 }, 'x'.repeat(48));
    assert.equal((await fetch(`${base}/api/settings`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}` } })).status, 401);
  });
});

test('the test login re-checks the allowlist at request time, not only at startup', async () => {
  // resolveAuthConfig refuses this combination outright, so the only way to
  // reach the request-time check is to hand createAuth a config that drifted
  // past it — which is exactly the future regression this guard exists for.
  const auth = createAuth({
    required: true,
    oauthConfigured: false,
    clientId: '',
    clientSecret: '',
    allowedLogins: ['owner-login'],
    testUser: 'someone-else',
    sessionSecret: SECRET,
    ephemeralSecret: false,
    sessionTtlMs: 60_000,
    secureCookies: false,
    loopback: true,
    host: '127.0.0.1',
    clientOrigin: 'http://localhost:3000',
    callbackUrl: 'http://localhost:4000/auth/callback',
  });
  const app = express();
  auth.mountRoutes(app);
  app.use('/api', auth.requireSession);
  app.get('/api/settings', (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/auth/test-login`, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /CONSTRUCT_ALLOWED_LOGINS/);
    assert.equal(cookieHeader(res, SESSION_COOKIE), null);
  } finally {
    server.close();
  }
});

test('/auth/session advertises the test login so the login screen can offer it', async () => {
  await withApp({ env: TEST_ENV }, async ({ base }) => {
    const body = await (await fetch(`${base}/auth/session`)).json();
    assert.equal(body.authRequired, true);
    assert.equal(body.authenticated, false);
    assert.equal(body.testLogin, true);
    assert.equal(body.testLoginUser, 'e2e-user');
    assert.equal(body.githubConfigured, false);
    assert.equal(body.user, null);
  });
});

test('/auth/login says so plainly when no OAuth app is configured', async () => {
  await withApp({ env: TEST_ENV }, async ({ base }) => {
    const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /not configured/);
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated mode and renewal
// ---------------------------------------------------------------------------

test('with authentication off, requests pass and /auth/session says so', async () => {
  await withApp({ env: {} }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/settings`)).status, 200);
    const body = await (await fetch(`${base}/auth/session`)).json();
    assert.equal(body.authRequired, false);
    assert.equal(body.authenticated, true);
  });
});

test('a session past half its life is rolled forward; a fresh one is left alone', async () => {
  const config = resolveAuthConfig({ ...OAUTH_ENV, CONSTRUCT_SESSION_TTL_HOURS: '1' }, {});
  let clock = 1_000_000;
  const auth = createAuth(config, { now: () => clock });
  const issued = signValue({ login: 'owner-login', iat: clock, exp: clock + config.sessionTtlMs }, SECRET);

  const run = () => {
    const headers = [];
    const res = { append: (k, v) => headers.push([k, v]), status: () => res, json: () => res };
    let passed = false;
    auth.requireSession({ headers: { cookie: `${SESSION_COOKIE}=${issued}` } }, res, () => {
      passed = true;
    });
    return { passed, headers };
  };

  clock += 60_000; // one minute in — nothing to do
  const fresh = run();
  assert.equal(fresh.passed, true);
  assert.equal(fresh.headers.length, 0);

  clock += 35 * 60_000; // past half of the one-hour TTL
  const stale = run();
  assert.equal(stale.passed, true);
  assert.equal(stale.headers.length, 1);
  assert.match(stale.headers[0][1], new RegExp(`^${SESSION_COOKIE}=`));
});
