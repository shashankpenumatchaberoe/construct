import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gotoCockpit } from './support/cockpit.js';
import { makeBrowseProject, openProject } from './support/browseProject.js';
import { previewBridgeScript } from '../../../packages/engine/previewBridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.E2E_API_BASE || 'http://localhost:4000';
// The server's own first-port choice for a fixture app (set by playwright.config.js, never a human's 3000/4000).
const PORT_BASE = Number(process.env.E2E_DEVSERVER_PORT_BASE) || 0;

// #378 — the live preview's dev server, for real: a real fixture project (a git repository with a package.json
// whose `dev` script is a tiny node server), the real Cockpit server starting it as a child process, the real
// preview bridge script in its page, and a real Chromium looking at the result. Nothing is stubbed.
//
// The fixture app: waits a moment before listening (so "Starting" is a state you can see), serves a page that
// carries the REAL bridge (or not, in `no-plugin` mode) and a button that throws, and in `fixed` mode ignores
// PORT and binds a hard-coded port (what a script that pins its port does, so a taken port really fails it).
// In `lan` mode it binds every interface (0.0.0.0) instead of loopback — what a framework that ignores the
// Cockpit's HOST/HOSTNAME env does (Next.js's own default) — to exercise the LAN-reachable warning (#557).
const SERVER = `import http from 'node:http';
import fs from 'node:fs';
const mode = () => fs.readFileSync('mode.txt', 'utf8').trim();
const BRIDGE = ${JSON.stringify(previewBridgeScript())};
const html = () => '<!doctype html><html><body style="font-family:sans-serif;padding:24px"><h1>Hello from the dev server</h1>'
  + '<button id="boom">Break the app</button>'
  + '<script>document.getElementById("boom").addEventListener("click", function () { throw new Error("Cannot read properties of undefined (reading \\'email\\')"); });</script>'
  + (mode() === 'no-plugin' ? '' : '<script>' + BRIDGE + '</script>') + '</body></html>';
const port = mode() === 'fixed' ? Number(fs.readFileSync('fixed-port.txt', 'utf8')) : Number(process.env.PORT);
const bindHost = mode() === 'lan' ? '0.0.0.0' : '127.0.0.1';
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(html()); });
srv.on('error', (e) => { console.error(e.message); process.exit(1); });
setTimeout(() => srv.listen(port, bindHost, () => console.log('  Local:   http://localhost:' + port + '/')), 1200);
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
`;

const canConnect = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

test.describe.serial('Live preview: Start dev server as a managed process (#378)', () => {
  let project;
  let restore;
  const setMode = (m) => fs.writeFileSync(path.join(project.repo, 'mode.txt'), m);
  const status = async (request) => (await request.get(`${API}/api/dev-server`)).json();

  test.beforeAll(async () => {
    project = makeBrowseProject('og378-devserver-');
    fs.writeFileSync(path.join(project.repo, 'server.mjs'), SERVER);
    fs.writeFileSync(path.join(project.repo, 'package.json'), JSON.stringify({ name: 'fixture-app', scripts: { dev: 'node server.mjs' } }));
    setMode('plugin');
    project.git('add', '-A');
    project.git('commit', '-q', '-m', 'fixture app');
    restore = await openProject(API, project.repo);
  });

  test.afterAll(async () => {
    await fetch(`${API}/api/dev-server/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await restore?.();
    project?.remove();
  });

  const openBillingPage = async (page) => {
    await gotoCockpit(page, '/pages');
    const files = page.getByRole('complementary', { name: 'Browser' }).locator('.pages-browser');
    await files.locator('select').selectOption('billing');
    await files.getByRole('button', { name: 'BillingPage.tsx' }).click();
    await expect(page.locator('.live-preview-panel')).toBeVisible();
  };
  const card = (page) => page.getByTestId('dev-server');
  const frame = (page) => page.frameLocator('iframe[title="Live app preview"]');
  /** Start, answering the one-time "run it?" question if it is asked (a fresh browser context asks it again). */
  const startIt = async (page) => {
    await page.getByTestId('dev-server-start').click();
    await page.getByTestId('dev-server-confirm').click();
  };

  test('never starts by itself; asks once; then Starting -> Running, framed, logged, restartable and stoppable, with the branch kind shown', async ({ page, request }) => {
    test.setTimeout(120_000);
    await openBillingPage(page);

    // --- not running: the exact command is shown, and NOTHING has started ---
    await expect(card(page)).toHaveAttribute('data-state', 'not-running');
    await expect(page.getByTestId('dev-server-command')).toHaveText('npm run dev');
    await expect(page.getByTestId('dev-server-script')).toHaveText('node server.mjs');
    await page.waitForTimeout(1500);
    expect((await status(request)).state).toBe('not-running');
    expect((await status(request)).pid).toBeNull();

    // --- "Use a URL instead" stays, but only for an address on this machine ---
    await page.getByLabel('Preview URL').fill('https://example.com/');
    await page.getByRole('button', { name: 'Load preview' }).click();
    await expect(page.locator('.live-preview-message')).toContainText('Only a local address can be previewed');
    await expect(page.locator('iframe[title="Live app preview"]')).toHaveCount(0);

    // --- branch provenance: a hand-made branch is "Other", a Cockpit session branch is "Session" ---
    await expect(page.getByTestId('branch-provenance')).toHaveAttribute('data-kind', 'other');
    await expect(page.getByTestId('branch-provenance')).toContainText('Other branch');
    await expect(page.getByTestId('branch-name')).toHaveText('main');
    project.git('checkout', '-q', '-b', 'cockpit/e2e-devserver-a3f7');
    await expect(page.getByTestId('branch-provenance')).toHaveAttribute('data-kind', 'session', { timeout: 10_000 });
    await expect(page.getByTestId('branch-provenance')).toContainText('Session branch');
    await expect(page.getByTestId('branch-name')).toHaveText('cockpit/e2e-devserver-a3f7');
    project.git('checkout', '-q', '-b', 'feature/hand-made');
    await expect(page.getByTestId('branch-provenance')).toHaveAttribute('data-kind', 'other', { timeout: 10_000 });
    project.git('checkout', '-q', 'cockpit/e2e-devserver-a3f7');
    await expect(page.getByTestId('branch-provenance')).toHaveAttribute('data-kind', 'session', { timeout: 10_000 });

    // --- the first Start only asks: still nothing running until "Run it" ---
    await page.getByTestId('dev-server-start').click();
    await expect(page.getByTestId('dev-server-confirm')).toBeVisible();
    await page.getByTestId('dev-server-cancel').click();
    await expect(page.getByTestId('dev-server-confirm')).toHaveCount(0);
    expect((await status(request)).state).toBe('not-running');
    await page.getByTestId('dev-server-start').click();
    await page.getByTestId('dev-server-confirm').click();

    // --- starting, then running on 127.0.0.1 on a free port that is not one of the Cockpit's ---
    await expect(card(page)).toHaveAttribute('data-state', 'starting');
    await expect(page.getByTestId('dev-server-stop')).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    const running = await status(request);
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect([80, 443, 3000, 4000]).not.toContain(running.port);
    if (PORT_BASE) expect(running.port).toBeGreaterThanOrEqual(PORT_BASE);
    expect(running.branchKind).toBe('session');
    // loopback only: no "reachable from your network" warning (#557; the lan-bound case is its own test below)
    await expect(page.getByTestId('dev-server-network-warning')).toHaveCount(0);

    // --- the preview frames it by itself, and the Cockpit's plugin announced itself (so no "off" card) ---
    await expect(frame(page).locator('h1')).toHaveText('Hello from the dev server');
    await page.waitForTimeout(7000);
    await expect(page.getByTestId('preview-plugin-off')).toHaveCount(0);

    // --- app error: the app throws inside the preview, and the Cockpit says what it threw ---
    await frame(page).locator('#boom').click();
    await expect(page.getByTestId('preview-app-error')).toContainText("Cannot read properties of undefined (reading 'email')");
    await page.getByTestId('preview-app-error').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('preview-app-error')).toHaveCount(0);

    // --- its output is in the bottom panel's Logs ---
    await page.getByTestId('dev-server-show-log').click();
    await expect(page.getByText(/Dev server is running at http:\/\/127\.0\.0\.1:\d+\//).first()).toBeVisible({ timeout: 10_000 });

    // --- the running server sees the session branch's files (same tree): editing the fixture shows through with no sync ---
    // (server-side proof lives in devServer.test.mjs; here the check is that Restart replaces the process cleanly)
    await page.getByTestId('dev-server-restart').click();
    await expect.poll(async () => (await status(request)).pid, { timeout: 30_000 }).not.toBe(running.pid);
    await expect(card(page)).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    await expect(frame(page).locator('h1')).toHaveText('Hello from the dev server');

    // --- stop: nothing is left listening and the frame lets go of the address ---
    const now = await status(request);
    await page.getByTestId('dev-server-stop').click();
    await expect(card(page)).toHaveAttribute('data-state', 'not-running');
    await expect(page.locator('iframe[title="Live app preview"]')).toHaveCount(0);
    await expect.poll(() => canConnect(now.port), { timeout: 10_000 }).toBe(false);
    expect((await status(request)).state).toBe('not-running');
  });

  test('a server also reachable from the network warns on the Running card, leaving the fix to the developer (#557)', async ({ page, request }) => {
    test.setTimeout(60_000);
    setMode('lan');
    await openBillingPage(page);
    await startIt(page);
    await expect(card(page)).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    const warning = page.getByTestId('dev-server-network-warning');
    await expect(warning).toBeVisible({ timeout: 10_000 });
    await expect(warning).toContainText('also reachable from your network');
    expect((await status(request)).networkWarning).toMatch(/^This server is also reachable from your network: .+:\d+$/);
    await page.getByTestId('dev-server-stop').click();
    await expect(card(page)).toHaveAttribute('data-state', 'not-running');
    expect((await status(request)).state).toBe('not-running');
  });

  test('plugin missing: the server answers but the app never loads the Cockpit plugin, and the card says how to add it', async ({ page, request }) => {
    test.setTimeout(120_000);
    setMode('no-plugin');
    await openBillingPage(page);
    await startIt(page);
    await expect(card(page)).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    await expect(frame(page).locator('h1')).toHaveText('Hello from the dev server');
    await expect(page.getByTestId('preview-plugin-off')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('preview-plugin-off')).toContainText('constructPreview()');
    await expect(page.getByTestId('preview-plugin-off')).toContainText('Tree, impact and source still work');
    await page.getByTestId('dev-server-stop').click();
    await expect(card(page)).toHaveAttribute('data-state', 'not-running');
    expect((await status(request)).state).toBe('not-running');
  });

  test('port busy: a script that pins a taken port fails with a reason and a free suggestion; "Use port" recovers', async ({ page, request }) => {
    test.skip(!PORT_BASE, 'needs the harness-chosen port range (playwright.config.js sets E2E_DEVSERVER_PORT_BASE)');
    test.setTimeout(120_000);
    const pinned = PORT_BASE + 40;
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(pinned, '127.0.0.1', r));
    try {
      setMode('fixed');
      fs.writeFileSync(path.join(project.repo, 'fixed-port.txt'), String(pinned));
      await openBillingPage(page);
      await startIt(page);
      await expect(card(page)).toHaveAttribute('data-state', 'port-busy', { timeout: 30_000 });
      await expect(page.getByTestId('dev-server-message')).toHaveText(`Port ${pinned} is in use by another process.`);
      await expect(page.getByTestId('dev-server-use-port')).toHaveText(`Use port ${pinned + 1}`);
      await expect(page.getByTestId('dev-server-show-log')).toBeVisible();
      expect((await status(request)).pid).toBeNull();
    } finally {
      await new Promise((r) => blocker.close(r));
    }
    // The port is free now; the script still pins it, so "Use port" is a normal start that comes up truthfully on it.
    await page.getByTestId('dev-server-use-port').click();
    await expect(card(page)).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    expect((await status(request)).port).toBe(pinned);
    await page.getByTestId('dev-server-stop').click();
    await expect(card(page)).toHaveAttribute('data-state', 'not-running');
    expect(await canConnect(pinned)).toBe(false);
  });
});
