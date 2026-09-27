import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #418 — every server restart used to sign everyone out: with no
// CONSTRUCT_SESSION_SECRET set, auth.mjs's resolveAuthConfig minted a fresh
// random 32-byte secret per process, and run-hosted.sh generated a fresh one
// per launch on top of that. This spec proves the fix end to end, for real:
// a genuine ui/server child process, a genuine signed session cookie minted
// by the real /auth/test-login route, an actual SIGTERM + respawn of that
// process from the SAME state directory with NO session secret in its
// environment (the exact posture that used to sign everyone out) — and the
// same cookie still verifying afterwards, because the server persisted its
// generated secret at <stateDir>/session-secret (auth.mjs,
// loadOrCreatePersistedSecret) instead of minting a new one.
//
// A restart mid-test is not something Playwright's own `webServer` option
// can express (it starts a server once per run), so this spec manages its
// own disposable ui/server process on a free port, entirely independent of
// the shared playwright.config.js webServer — mirroring
// docs-logo-status.spec.js's own pattern for the same reason. Run it with:
//   npx playwright test -c playwright.sessionRestart.config.js --workers=1
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SHOTS = path.resolve(HERE, '../screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const TEST_USER = 'e2e-restart-owner';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

test.describe.serial('#418 a session cookie survives a real server restart, via the persisted secret', () => {
  test.slow();
  let tmp;
  let stateDir;
  let workspaceDir;
  let port;
  let apiBase;
  let clientOrigin;
  let child;

  function startServer() {
    // Deliberately NOT setting CONSTRUCT_SESSION_SECRET: the whole point of
    // #418 is that the server persists its own generated secret rather
    // than mint (and forget) a new one on every restart.
    return spawn(process.execPath, ['src/index.mjs'], {
      cwd: path.join(REPO_ROOT, 'ui', 'server'),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        UI_CLIENT_ORIGIN: clientOrigin,
        CONSTRUCT_AUTH: 'required',
        CONSTRUCT_AUTH_TEST_USER: TEST_USER,
        NODE_ENV: 'test',
        CONSTRUCT_STATE_DIR: stateDir,
        CONSTRUCT_WORKSPACE_ROOT: workspaceDir,
      },
      stdio: 'pipe',
    });
  }

  async function waitHealthy(timeoutMs = 20_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if ((await fetch(`${apiBase}/api/health`)).ok) return;
      } catch {
        /* still starting */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`ui/server did not become healthy on ${apiBase} in time`);
  }

  function stopServer() {
    return new Promise((resolve) => {
      if (!child) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
  }

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og418-restart-'));
    stateDir = path.join(tmp, 'state');
    workspaceDir = path.join(tmp, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    port = await freePort();
    apiBase = `http://127.0.0.1:${port}`;
    // Only used as the Origin header handleTestLogin checks against — no server actually listens here.
    clientOrigin = `http://127.0.0.1:${await freePort()}`;
    child = startServer();
    await waitHealthy();
  });

  test.afterAll(async () => {
    await stopServer();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a cookie minted before SIGTERM still opens the API after a fresh process starts from the same state dir', async ({ page, request }) => {
    // A genuine session, minted by the real route (not fabricated): POST
    // /auth/test-login with the Cockpit's own Origin, exactly what
    // handleTestLogin requires.
    const login = await request.post(`${apiBase}/auth/test-login`, { headers: { origin: clientOrigin } });
    expect(login.ok()).toBe(true);
    const setCookieHeader = login.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie')?.value || '';
    const match = /construct_session=([^;]+)/.exec(setCookieHeader);
    expect(match, 'the test login must set a session cookie').not.toBeNull();
    const sessionCookieValue = decodeURIComponent(match[1]);

    const secretFile = path.join(stateDir, 'session-secret');
    expect(fs.existsSync(secretFile), 'the server must have persisted a generated secret (#418)').toBe(true);
    const secretBefore = fs.readFileSync(secretFile, 'utf8').trim();
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);

    const cookieHeader = `construct_session=${encodeURIComponent(sessionCookieValue)}`;
    const before = await request.get(`${apiBase}/api/settings`, { headers: { cookie: cookieHeader } });
    expect(before.status()).toBe(200);

    // The actual restart.
    await stopServer();
    child = startServer();
    await waitHealthy();

    // The persisted secret is exactly what it was — not a new one minted for the new process.
    expect(fs.readFileSync(secretFile, 'utf8').trim()).toBe(secretBefore);

    // The SAME cookie, no new login, against the NEW process.
    const after = await request.get(`${apiBase}/api/settings`, { headers: { cookie: cookieHeader } });
    expect(after.status()).toBe(200);
    const afterSession = await request.get(`${apiBase}/auth/session`, { headers: { cookie: cookieHeader } });
    const body = await afterSession.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.login).toBe(TEST_USER);

    // Visual evidence (rule 11): the same cookie, injected into a real
    // browser context, opens the authenticated session view after the
    // restart — no new login anywhere in this test.
    await page.context().addCookies([{ name: 'construct_session', value: sessionCookieValue, url: apiBase }]);
    await page.goto(`${apiBase}/auth/session`);
    await expect(page.locator('body')).toContainText('"authenticated":true');
    await expect(page.locator('body')).toContainText(`"login":"${TEST_USER}"`);
    await page.screenshot({ path: path.join(SHOTS, '418-1-session-survives-restart.png'), fullPage: true });
  });
});
