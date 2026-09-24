// The editor page in a real Chromium, behind Studio's real server and its access-token gate (Playwright, one worker, ports
// 48600-48699): load a fixture project, split with the keyboard, trim by dragging an edge, copy and paste, edit a subtitle inline,
// lock a layer, undo, save, export; project management from the first screen; 390 px and dark mode.
// Skipped with a message when no Chromium is installed (`npx playwright install chromium`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import editorHandler from '../src/editor/routes.mjs';
import { writeSampleWorkspace } from '../src/editor/sample.mjs';
import { startStudio } from '../src/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

async function loadChromium() {
  const require = createRequire(import.meta.url);
  for (const spec of ['playwright', 'playwright-core', path.join(REPO, 'ui', 'e2e', 'node_modules', 'playwright-core')]) {
    try {
      const { chromium } = require(spec);
      if (chromium && fs.existsSync(chromium.executablePath())) return chromium;
    } catch { /* try the next place */ }
  }
  return null;
}
const chromium = await loadChromium();
const opts = { skip: chromium ? false : 'no Chromium for Playwright here (run `npx playwright install chromium`); the real-browser check was skipped' };

/** A stand-in for ffmpeg (a real subprocess): for `-i` alone it prints a 10 s banner (what projectFromJob reads); for a render it prints progress and writes the last argument. */
function fakeFfmpeg(dir) {
  const file = path.join(dir, 'fake-ffmpeg.mjs');
  fs.writeFileSync(file, "#!/usr/bin/env node\nimport fs from 'node:fs';\nconst a = process.argv.slice(2);\nif (!a.includes('-progress')) { console.error('Duration: 00:00:10.00, start: 0.000000, bitrate: 1 kb/s'); process.exit(1); }\nconsole.log('out_time_us=4000000');\nfs.writeFileSync(a[a.length - 1], 'rendered');\n");
  fs.chmodSync(file, 0o755);
  return file;
}

async function startOn(ws) {
  for (let port = 48600; port < 48700; port++) {
    try { return await startStudio({ workspace: ws, port, log: () => {} }); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no free port in 48600-48699');
}

async function withStudio(fn, { project = true } = {}) {
  const ws = fs.realpathSync(makeTempDir('studio-editor-browser-'));
  writeSampleWorkspace(ws, { mediaDir: 'videos', withProject: project });
  const previous = process.env.FFMPEG;
  process.env.FFMPEG = fakeFfmpeg(ws);
  const studio = await startOn(ws);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try { await fn({ ws, studio, browser, open: (hash = '') => `${studio.url}/editor?token=${studio.token}${hash}` }); } finally {
    await browser.close();
    await studio.close();
    editorHandler.close();
    if (previous === undefined) delete process.env.FFMPEG; else process.env.FFMPEG = previous;
  }
}

const watch = (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|the server responded/.test(m.text())) errors.push(m.text()); });
  return errors;
};

test('the editor page in Chromium: split, trim by dragging, copy and paste, inline subtitle edit, lock, undo, save, export', opts, async () => {
  await withStudio(async ({ ws, studio, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
    const errors = watch(page);
    const api = async (p) => (await fetch(`${studio.url}/api/editor${p}`, { headers: { authorization: `Bearer ${studio.token}` } })).json();
    const clipsOf = async (kind) => (await api('/project/demo')).project.layers.find((l) => l.kind === kind).clips;
    const items = (kind) => page.locator(`.vis-item.kind-${kind}`);

    // the gate: no token, no editor
    assert.equal((await fetch(`${studio.url}/editor`)).status, 200, "the page shell holds no secret and reloads without a token");
    assert.equal((await fetch(`${studio.url}/api/editor/projects`)).status, 401);

    // first screen: New quick demo is the default path; the token leaves the address bar
    await page.goto(open());
    assert.ok(!page.url().includes('token='), 'the token is removed from the address bar');
    await page.getByRole('heading', { name: 'New quick demo' }).waitFor();
    assert.equal(await page.locator('#job-select option').count(), 1);
    await page.getByRole('button', { name: 'Open on the timeline' }).click();
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    assert.equal(await page.locator('.vis-item').count(), 5, 'one clip per project clip on four layers');
    for (const kind of ['video', 'voice', 'music', 'subtitle']) assert.ok(await items(kind).count() >= 1, kind);
    assert.equal(await page.locator('.vis-label').count(), 4, 'one row per layer');
    assert.match((await page.locator('.vis-text.vis-minor').allTextContents()).join(' '), /0:0\d/, 'the ruler shows mm:ss times');

    // the playhead: click the ruler
    const axis = await page.locator('.vis-panel.vis-top').boundingBox();
    await page.mouse.click(axis.x + axis.width * 0.5, axis.y + axis.height / 2);
    assert.notEqual((await page.locator('#time').innerText()).split(' / ')[0], '0:00.0', 'the playhead moved');

    // split with the keyboard (S): the video clip is cut at the playhead
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    assert.match(await page.locator('#time').innerText(), /^0:03\.0/);
    await page.keyboard.press('s');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-video').length === 2);
    assert.deepEqual((await clipsOf('video')).map((c) => [c.start, c.duration, c.in]), [[0, 3000, 0], [3000, 7000, 3000]], 'split at 3 s, the right half starts 3 s into the source');
    assert.match(await page.locator('#save-state').innerText(), /Unsaved/);

    // trim by dragging the right edge of the second subtitle
    await page.locator('.vis-item', { hasText: 'A second line of text' }).click();
    await page.waitForSelector('.vis-item.vis-selected .vis-drag-right');
    const handle = await page.locator('.vis-item.vis-selected .vis-drag-right').boundingBox();
    const before = (await clipsOf('subtitle')).find((c) => c.id === 'c5');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 40, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.move(handle.x - 90, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(async ([b, token]) => (await (await fetch('/api/editor/project/demo', { headers: { authorization: `Bearer ${token}` } })).json()).project.layers[3].clips.find((c) => c.id === 'c5').duration < b, [before.duration, studio.token]);
    const after = (await clipsOf('subtitle')).find((c) => c.id === 'c5');
    assert.equal(after.start, before.start, 'only the end moved');
    assert.ok(after.duration < before.duration && after.duration >= 40, `trimmed from ${before.duration} to ${after.duration}`);

    // drag the first subtitle a little to the right (a move; snapping may pull it to an edge)
    const first = page.locator('.vis-item', { hasText: 'Hello there' });
    const fb = await first.boundingBox();
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    await page.mouse.move(fb.x + fb.width / 2 + 30, fb.y + fb.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(async (token) => (await (await fetch('/api/editor/project/demo', { headers: { authorization: `Bearer ${token}` } })).json()).project.layers[3].clips.find((c) => c.id === 'c4').start > 500, studio.token);

    // copy and paste at the playhead
    await first.click();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Control+v');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 3);
    const subs = await clipsOf('subtitle');
    assert.equal(subs.length, 3);
    assert.equal(subs.find((c) => c.start === 8000).text, 'Hello there, this is Studio', 'pasted at 8 s with the same text');

    // undo takes the paste back, redo restores it, undo again
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 2);
    assert.equal((await clipsOf('subtitle')).length, 2);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 3);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 2);

    // inline subtitle edit (double-click) and the live overlay over the preview
    await page.locator('.vis-item', { hasText: 'Hello there' }).dblclick();
    const input = page.locator('input.inline-edit');
    await input.waitFor();
    await input.fill('Edited inline');
    await input.press('Enter');
    await page.waitForFunction(async (token) => (await (await fetch('/api/editor/project/demo', { headers: { authorization: `Bearer ${token}` } })).json()).project.layers[3].clips.find((c) => c.id === 'c4').text === 'Edited inline', studio.token);
    await page.locator('.vis-item', { hasText: 'Edited inline' }).waitFor();
    const c4 = (await clipsOf('subtitle')).find((c) => c.id === 'c4');
    await page.keyboard.press('Home');
    for (let ms = 0; ms < c4.start + 200; ms += 100) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('subtitle-overlay').textContent === 'Edited inline');

    // lock the subtitle layer: edits are refused with a message
    await page.getByRole('button', { name: 'Lock Subtitles' }).click();
    await page.waitForFunction(() => document.querySelector('.vis-item.kind-subtitle.locked'));
    await page.locator('.vis-item.kind-subtitle').first().click();
    await page.keyboard.press('Delete');
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast').innerText(), /locked/i);
    await page.getByRole('button', { name: 'Lock Subtitles' }).click();
    await page.waitForFunction(() => !document.querySelector('.vis-item.kind-subtitle.locked'));

    // save, then export (soft subtitles by default)
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
    const onDisk = JSON.parse(fs.readFileSync(path.join(ws, 'demo.studio.json'), 'utf8'));
    assert.equal(onDisk.layers[0].clips.length, 2, 'the split is in the saved file');
    assert.equal(onDisk.layers[3].clips.find((c) => c.id === 'c4').text, 'Edited inline');
    assert.equal(onDisk.rev, 2);
    await page.locator('#export summary').click();
    await page.getByRole('button', { name: 'Export video' }).click();
    await page.locator('#export-links a').first().waitFor();
    assert.deepEqual(await page.locator('#export-links a').allInnerTexts(), ['demo.export.webm', 'demo.srt', 'demo.vtt']);
    assert.match(await page.locator('#export-status').innerText(), /separate track/);
    assert.match(fs.readFileSync(path.join(ws, 'demo.srt'), 'utf8'), /Edited inline/);
    const link = await page.locator('#export-links a').first().getAttribute('href');
    assert.ok(link.includes('token='), 'a download link carries the token (a plain link cannot send a header)');
    assert.equal((await fetch(`${studio.url}${link}`)).status, 200);
    assert.equal((await fetch(`${studio.url}${link.split('?')[0]}`)).status, 401);

    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('project management from the first screen: quick demo, duplicate, rename, delete to .trash, export and import a bundle, recovery after a restart', opts, async () => {
  await withStudio(async ({ ws, studio, browser, open }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = watch(page);
    const api = async (p) => (await fetch(`${studio.url}/api/editor${p}`, { headers: { authorization: `Bearer ${studio.token}` } })).json();
    const slugs = async () => (await api('/projects')).projects.map((p) => p.slug).sort();
    const row = (name) => page.locator('li.project', { hasText: name });

    await page.goto(open());
    await page.getByRole('heading', { name: 'New quick demo' }).waitFor();
    await page.getByRole('button', { name: 'Open on the timeline' }).click();
    await page.waitForSelector('body[data-ready="demo"]');
    assert.equal(await page.locator('.vis-item').count(), 3, 'layers ready from the job: video, voice, music (no captions in this workspace)');
    assert.deepEqual(await slugs(), ['demo']);
    await page.getByRole('link', { name: 'Projects' }).click();
    await row('demo').waitFor();

    // duplicate
    await row('demo').getByRole('button', { name: /^Duplicate/ }).click();
    await row('demo copy').waitFor();
    assert.deepEqual(await slugs(), ['demo', 'demo-copy']);

    // rename through the dialog; a name that is taken is refused with the message and nothing moves
    await row('demo copy').getByRole('button', { name: /^Rename/ }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('demo');
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
    await page.waitForSelector('.toast.error');
    assert.match(await page.locator('.toast').innerText(), /already exists/);
    assert.deepEqual(await slugs(), ['demo', 'demo-copy']);
    await row('demo copy').getByRole('button', { name: /^Rename/ }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('second-cut');
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.startsWith('Renamed'));
    assert.deepEqual(await slugs(), ['demo', 'second-cut']);

    // export the bundle (a download), delete with a confirm step, import the bundle back
    const [download] = await Promise.all([page.waitForEvent('download'), row('demo copy').getByRole('button', { name: /^Export/ }).click()]);
    assert.equal(download.suggestedFilename(), 'second-cut.studio-bundle.json');
    const bundlePath = path.join(ws, 'saved-bundle.json');
    await download.saveAs(bundlePath);
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    assert.deepEqual(bundle.media.map((m) => m.name), ['demo.music.mp3', 'demo.voice.opus', 'demo.webm']);
    assert.ok(!JSON.stringify(bundle).includes(ws), 'the bundle holds names, never paths');
    await row('demo copy').getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.deepEqual(await slugs(), ['demo', 'second-cut'], 'cancel deletes nothing');
    await row('demo copy').getByRole('button', { name: /^Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.startsWith('Moved to .trash'));
    assert.deepEqual(await slugs(), ['demo']);
    assert.match(fs.readdirSync(path.join(ws, '.trash')).join(' '), /^second-cut\..*\.studio\.json$/);
    await page.locator('input[type=file]').setInputFiles(bundlePath);
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.startsWith('Imported'));
    assert.equal((await slugs()).length, 2);

    // recovery: edit, wait for the recovery copy, "restart" (sessions gone), reopen: offered, restore keeps it unsaved
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.locator('.vis-item.kind-video').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('s');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-video').length === 2);
    await page.waitForFunction(() => /recovery copy kept/.test(document.getElementById('save-state').textContent));
    const auto = path.join(ws, 'demo.studio.autosave.json');
    for (let i = 0; i < 30 && !fs.existsSync(auto); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(auto), 'the recovery copy was written');
    editorHandler.close();
    await page.goto(open('#/p/demo'));
    await page.locator('#restore').waitFor();
    assert.equal(await page.locator('.vis-item.kind-video').count(), 1, 'offered, not applied');
    await page.locator('#restore').click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-video').length === 2);
    assert.match(await page.locator('#save-state').innerText(), /Unsaved/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'demo.studio.json'), 'utf8')).layers[0].clips.length, 1, 'still not saved to the project file');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  }, { project: false });
});

test('the editor page at 390 px and in dark mode: no sideways scroll, controls reachable, tokens switch', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    for (const [scheme, width] of [['light', 390], ['dark', 390], ['dark', 1280]]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme });
      const page = await context.newPage();
      await page.goto(open());
      await page.getByRole('heading', { name: 'New quick demo' }).waitFor();
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), scheme === 'dark' ? 'rgb(16, 18, 22)' : 'rgb(246, 247, 249)');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `home fits ${width}px`);
      await page.goto(open('#/p/demo'));
      await page.waitForSelector('body[data-ready="demo"]');
      await page.waitForSelector('.vis-item');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `the editor fits ${width}px without sideways scroll`);
      for (const name of ['Split', 'Undo', 'Play', 'Save']) assert.ok(await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().isVisible(), name);
      const box = await page.locator('#timeline').boundingBox();
      assert.ok(box.width <= width && box.width > 300, `the timeline is ${box.width}px wide`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.vis-item.kind-video')).color), scheme === 'dark' ? 'rgb(232, 235, 240)' : 'rgb(20, 23, 28)', 'the timeline follows the colour scheme');
      await page.keyboard.press('Tab');
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'keyboard focus is visible');
      await context.close();
    }
  });
});
