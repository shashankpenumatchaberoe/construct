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
import { makeTempDir } from './support/tmpdir.mjs';
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

async function withStudio(fn, { project = true, autosave = false } = {}) {
  const ws = fs.realpathSync(makeTempDir('studio-editor-browser-'));
  writeSampleWorkspace(ws, { mediaDir: 'videos', withProject: project });
  const previous = process.env.FFMPEG;
  process.env.FFMPEG = fakeFfmpeg(ws);
  const studio = await startOn(ws);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  // Auto-save is on by default in the page; the older checks below rely on edits staying unsaved until Save, so they start with it off.
  const makeContext = browser.newContext.bind(browser);
  browser.newContext = async (o) => { const c = await makeContext(o); if (!autosave) await c.addInitScript(() => { try { localStorage.setItem('studio-editor-autosave', 'off'); } catch { /* ignore */ } }); return c; };
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
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(0, 0, 0)', 'the page is black whatever the system colour scheme');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `home fits ${width}px`);
      await page.goto(open('#/p/demo'));
      await page.waitForSelector('body[data-ready="demo"]');
      await page.waitForSelector('.vis-item');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `the editor fits ${width}px without sideways scroll`);
      for (const name of ['Split', 'Undo', 'Play', 'Save']) assert.ok(await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().isVisible(), name);
      const box = await page.locator('#timeline').boundingBox();
      assert.ok(box.width <= width && box.width > 300, `the timeline is ${box.width}px wide`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.vis-item.kind-video')).color), 'rgb(232, 236, 246)', 'the timeline is dark in both colour schemes');
      const cursorOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).cursor, sel);
      assert.equal(await cursorOf('#play'), 'pointer', 'buttons show a pointer');
      assert.equal(await cursorOf('#media-select'), 'pointer', 'selects show a pointer');
      assert.equal(await cursorOf('.export summary'), 'pointer', 'the export toggle shows a pointer');
      assert.equal(await cursorOf('.vis-item.kind-video'), 'grab', 'a clip can be grabbed');
      assert.equal(await cursorOf('.vis-item.kind-video .clip-text'), 'grab', 'the clip label does not switch the cursor');
      assert.equal(await cursorOf('.flag'), 'pointer', 'the mute and lock toggles show a pointer');
      assert.equal(await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.timeline-wrap')); return s.backdropFilter !== 'none' || s.webkitBackdropFilter !== 'none'; }), true, 'the timeline is frosted glass');
      await page.keyboard.press('Tab');
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'keyboard focus is visible');
      await context.close();
    }
  });
});

test('duplicating a layer from its label or with Ctrl+Shift+D: a new lane with the same clips, the media picker follows, undo removes it', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const lanes = () => page.locator('.vis-labelset .vis-label').count();
    assert.equal(await lanes(), 4);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('button[aria-label="Duplicate Voice"]')).cursor), 'pointer');
    await page.getByRole('button', { name: 'Duplicate Voice' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-labelset .vis-label').length === 5);
    assert.equal(await page.locator('.vis-item.kind-voice').count(), 2, 'the copy holds the same clip');
    assert.match(await page.locator('#media-layer').innerText(), /Voice copy/, 'the Add media layer list follows');
    await page.locator('.vis-item.kind-music').first().click();
    await page.keyboard.press('Control+Shift+D');
    await page.waitForFunction(() => document.querySelectorAll('.vis-labelset .vis-label').length === 6);
    assert.equal(await page.locator('.vis-item.kind-music').count(), 2, 'Ctrl+Shift+D copies the layer of the selected clip');
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-labelset .vis-label').length === 5);
    await page.locator('#add-layer-kind').selectOption('video');
    await page.locator('#add-layer').click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-labelset .vis-label').length === 6);
    assert.equal(await page.locator('.vis-labelset .vis-label .lane-name', { hasText: 'Video 2' }).count(), 1, 'Add layer makes a new, empty video lane');
    assert.match(await page.locator('#media-layer').innerText(), /Video 2/, 'and it can be chosen in the Add media list');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('right-click menus: empty lane space gives the track type\'s controls, a clip gives its own; click only moves the playhead and double-click edits a subtitle', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const laneAt = async (kind) => { const b = await page.locator(`.vis-foreground .vis-group.kind-${kind}`).first().boundingBox(); return { x: b.x + b.width * 0.93, y: b.y + b.height / 2 }; };
    const menuItems = () => page.locator('[role=menu] [role=menuitem]').allInnerTexts();
    const menuLabel = () => page.locator('[role=menu]').getAttribute('aria-label');
    const time = () => page.locator('#time').innerText();

    let p = await laneAt('subtitle');
    await page.mouse.click(p.x, p.y);
    assert.equal(await page.locator('[role=menu]').count(), 0, 'a single click opens no menu');
    assert.doesNotMatch(await time(), /^0:00\.0 /, 'but it moves the playhead');
    await page.mouse.dblclick(p.x, p.y);
    assert.equal(await page.locator('[role=menu]').count(), 0, 'a double-click on empty space opens no menu');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.locator('[role=menu]').waitFor();
    assert.equal(await menuLabel(), 'Subtitles options');
    const sub = await menuItems();
    assert.ok(sub.some((t) => /Add a subtitle here/.test(t)) && sub.some((t) => /Add another subtitle layer/.test(t)) && !sub.some((t) => /\.webm|\.mp3/.test(t)), `subtitle lane menu: ${sub}`);
    assert.equal(await page.evaluate(() => document.activeElement.textContent.includes('Add a subtitle here')), true, 'the first item has focus');
    await page.keyboard.press('Escape');
    await page.locator('[role=menu]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.vis-item.kind-subtitle').count(), 2, 'Escape changed nothing');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 3);
    await page.keyboard.press('Escape');

    p = await laneAt('video');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.locator('[role=menu]').waitFor();
    const vid = await menuItems();
    assert.ok(vid.some((t) => /Add demo\.webm here/.test(t)) && !vid.some((t) => /voice\.opus|music\.mp3/.test(t)), `video lane menu: ${vid}`);
    await page.keyboard.press('Escape');
    p = await laneAt('voice');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await page.locator('[role=menu]').waitFor();
    const voi = await menuItems();
    assert.ok(voi.some((t) => /voice\.opus/.test(t)) && !voi.some((t) => /demo\.webm/.test(t)), `voice lane menu: ${voi}`);
    assert.equal(await page.getByRole('menuitem', { name: /Paste here/ }).isDisabled(), true, 'nothing copied yet');
    await page.getByRole('menuitem', { name: 'Lock this layer' }).click();
    await page.waitForFunction(() => document.querySelector('.vis-item.kind-voice.locked'));
    await page.locator('#undo').click();
    await page.waitForFunction(() => !document.querySelector('.vis-item.kind-voice.locked'));

    // a clip: its own controls, by type
    await page.locator('.vis-item.kind-music').first().click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    assert.equal(await menuLabel(), 'music clip options');
    const mus = await menuItems();
    for (const want of [/Split at the playhead/, /Copy/, /Duplicate\b/, /Quieter/, /Louder/, /Delete and close the gap/]) assert.ok(mus.some((t) => want.test(t)), `music clip menu has ${want}: ${mus}`);
    await page.getByRole('menuitem', { name: /Louder/ }).click();
    await page.waitForFunction(() => /0\.06/.test(document.getElementById('inspector').innerText));
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    assert.equal(await menuLabel(), 'video clip options');
    const vc = await menuItems();
    assert.ok(!vc.some((t) => /Quieter|Louder|Edit text/.test(t)), `a video clip has no gain or text items: ${vc}`);
    await page.keyboard.press('Escape');
    await page.locator('.vis-item.kind-subtitle', { hasText: 'A second line' }).click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent.includes('Edit text')), true, 'a subtitle menu starts on Edit text');
    await page.keyboard.press('Escape');
    await page.locator('.vis-item.kind-subtitle', { hasText: 'A second line' }).dblclick();
    await page.locator('input.inline-edit').waitFor();
    assert.equal(await page.locator('[role=menu]').count(), 0, 'double-click edits in place, no menu');
    await page.keyboard.press('Escape');
    // the Menu key opens the selected clip's menu
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Shift+F10');
    await page.locator('[role=menu]').waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('keyboard: the player and the timeline are focusable groups; Space/K, arrows, J/L, Ctrl+arrows and [ ] seek from them', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const time = () => page.locator('#time').innerText();
    await page.locator('#player').focus();
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'the focused player shows a ring');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true', 'Space plays from the player');
    await page.keyboard.press('k');
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false', 'K pauses');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    assert.match(await time(), /^0:00\.1 /);
    await page.keyboard.press('Shift+ArrowRight');
    assert.match(await time(), /^0:01\.1 /);
    await page.keyboard.press('l');
    assert.match(await time(), /^0:02\.1 /);
    await page.keyboard.press('j');
    await page.keyboard.press('Control+ArrowRight');
    assert.match(await time(), /^0:06\.1 /, 'Ctrl+Right jumps five seconds');
    await page.locator('#timeline-wrap').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press(']');
    assert.match(await time(), /^0:00\.5 /, 'the next clip edge is the first subtitle at 0.5 s');
    await page.keyboard.press(']');
    assert.match(await time(), /^0:03\.5 /);
    await page.keyboard.press('[');
    assert.match(await time(), /^0:00\.5 /);
    await page.keyboard.press('ArrowLeft');
    assert.match(await time(), /^0:00\.4 /);
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('auto-save: a moment after the last edit the project file is saved once, not on every edit; the checkbox turns it off', opts, async () => {
  await withStudio(async ({ ws, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && /\/api\/editor\/project\/demo$/.test(r.url())) puts.push(Date.now()); });
    const file = () => JSON.parse(fs.readFileSync(path.join(ws, 'demo.studio.json'), 'utf8')).layers[0].clips.length;
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    assert.equal(await page.locator('#autosave').isChecked(), true, 'on by default');
    // three quick edits (each restarts the wait), then nothing for a moment
    await page.locator('.vis-item.kind-video').first().click();
    await page.evaluate(() => document.getElementById('time'));
    for (const at of ['ArrowRight', 'ArrowRight']) await page.keyboard.press(at);
    await page.locator('#split').click();
    await page.locator('.vis-item.kind-subtitle').first().click();
    await page.locator('#duplicate').click();
    await page.locator('.vis-item.kind-music').first().click();
    await page.locator('#duplicate').click();
    assert.match(await page.locator('#save-state').innerText(), /Unsaved, saving soon/);
    assert.equal(file(), 1, 'nothing is written while the edits are still coming');
    await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved', null, { timeout: 8000 });
    assert.equal(file(), 2, 'the split reached the project file');
    assert.equal(puts.length, 1, `one save for the whole burst, got ${puts.length}`);
    // off: edits stay unsaved
    await page.locator('#autosave').uncheck();
    await page.locator('.vis-item.kind-video').last().click();
    await page.locator('#delete').click();
    await page.waitForTimeout(2600);
    assert.match(await page.locator('#save-state').innerText(), /Unsaved changes/);
    assert.equal(file(), 2, 'with auto-save off the file does not change');
    assert.equal(puts.length, 1);
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved');
    assert.equal(file(), 1, 'Save still works');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  }, { autosave: true });
});

test('layers: the toolbar Layers menu adds and deletes, right-click on a lane label opens the lane menu, delete asks first and undo brings the layer back', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const lanes = () => page.locator('.vis-labelset .vis-label').count();
    const waitLanes = (n) => page.waitForFunction((k) => document.querySelectorAll('.vis-labelset .vis-label').length === k, n);
    assert.equal(await lanes(), 4);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('layers-menu')).cursor), 'pointer');
    await page.locator('#layers-menu').click();
    await page.locator('[role=menu]').waitFor();
    assert.equal(await page.locator('[role=menu]').getAttribute('aria-label'), 'Layers');
    assert.equal(await page.getByRole('menuitem', { name: 'Delete layer...' }).isDisabled(), true, 'nothing selected: no layer to delete');
    await page.getByRole('menuitem', { name: 'Add voice layer' }).click();
    await waitLanes(5);
    // delete the layer of the selected music clip: a confirmation first, Cancel changes nothing
    await page.locator('.vis-item.kind-music').first().click();
    await page.locator('#layers-menu').click();
    await page.getByRole('menuitem', { name: 'Delete layer...' }).click();
    const dlg = page.locator('dialog.ask[open]');
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /Delete "Music"\?[\s\S]*Its 1 clip goes with it/i);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await lanes(), 5, 'Cancel deleted nothing');
    await page.locator('#layers-menu').click();
    await page.getByRole('menuitem', { name: 'Delete layer...' }).click();
    await dlg.getByRole('button', { name: 'Delete layer' }).click();
    await waitLanes(4);
    assert.equal(await page.locator('.vis-item.kind-music').count(), 0, 'its clips went with it');
    await page.locator('#undo').click();
    await waitLanes(5);
    assert.equal(await page.locator('.vis-item.kind-music').count(), 1, 'undo brought the layer and its clip back');
    // right-click on a lane label: the lane menu, with its own delete
    await page.locator('.vis-labelset .vis-label', { hasText: 'Subtitles' }).click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    assert.equal(await page.locator('[role=menu]').getAttribute('aria-label'), 'Subtitles options');
    await page.getByRole('menuitem', { name: 'Delete this layer...' }).click();
    await dlg.waitFor();
    assert.match(await dlg.innerText(), /Delete "Subtitles"\?[\s\S]*Its 2 clips go with it/i);
    await dlg.getByRole('button', { name: 'Delete layer' }).click();
    await waitLanes(4);
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('overlapping video clips: allowed, the later one is drawn dashed and under, and the preview shows the earlier one', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    // copy the video clip and paste it 4 s in: it overlaps the original for 6 s
    await page.locator('.vis-item.kind-video').first().click();
    await page.keyboard.press('Control+c');
    await page.locator('#timeline-wrap').focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+v');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-video').length === 2);
    assert.equal(await page.locator('.vis-item.kind-video.under').count(), 1, 'exactly the later clip is under');
    const z = await page.evaluate(() => [...document.querySelectorAll('.vis-item.kind-video')].map((e) => [e.classList.contains('under'), Number(e.style.zIndex)]));
    const under = z.find(([u]) => u);
    const top = z.find(([u]) => !u);
    assert.ok(top[1] > under[1], `the earlier clip has the higher stacking order: ${JSON.stringify(z)}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.vis-item.kind-video.under')).borderStyle), 'dashed');
    // the covered clip's tooltip: hover the part of it that sticks out past the top clip (and is still inside the visible timeline),
    // nudging the pointer until the delayed tooltip shows
    const underBox = await page.locator('.vis-item.kind-video.under').boundingBox();
    const topBox = await page.locator('.vis-item.kind-video:not(.under)').boundingBox();
    const view = await page.locator('#timeline').boundingBox();
    const right = Math.min(underBox.x + underBox.width, view.x + view.width - 12);
    const hoverX = (topBox.x + topBox.width + right) / 2;
    const hoverY = underBox.y + underBox.height / 2;
    const tip = page.locator('.vis-tooltip', { hasText: 'Under an earlier clip' });
    let seen = false;
    for (let i = 0; i < 12 && !seen; i++) {
      await page.mouse.move(hoverX + (i % 2) * 6, hoverY + (i % 3));
      await page.waitForTimeout(500);
      seen = (await tip.count()) > 0 && (await tip.first().isVisible());
    }
    assert.ok(seen, `the covered clip explains itself in a tooltip (under ${JSON.stringify(underBox)}, top ${JSON.stringify(topBox)}, view ${JSON.stringify(view)}, hover ${Math.round(hoverX)},${Math.round(hoverY)})`);
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('horizontal navigation: wheel and swipe scroll the timeline (down or right = later), the slider and PageUp/PageDown scroll it, and the view follows the playhead', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const clipX = async () => Math.round((await page.locator('.vis-item.kind-video').first().boundingBox()).x);
    const settle = () => page.waitForTimeout(450);
    assert.equal(await page.locator('#pan').isVisible(), false, 'nothing to scroll while the whole project fits');
    await page.locator('#timeline-wrap').focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('+');
    await settle();
    assert.equal(await page.locator('#pan').isVisible(), true, 'zoomed in: the scroll slider appears');
    const lane = await page.locator('.vis-foreground .vis-group.kind-music').first().boundingBox();
    await page.mouse.move(lane.x + lane.width / 2, lane.y + lane.height / 2);
    // the first clip starts at 0 s: scrolling later moves it LEFT on screen, earlier moves it right
    let x0 = await clipX();
    await page.mouse.wheel(0, 200);
    await settle();
    const x1 = await clipX();
    assert.ok(x1 < x0, `wheel down scrolls later: ${x0} -> ${x1}`);
    await page.mouse.wheel(150, 0);
    await settle();
    const x2 = await clipX();
    assert.ok(x2 < x1, `swipe right scrolls later: ${x1} -> ${x2}`);
    await page.mouse.wheel(-400, 0);
    await settle();
    assert.ok((await clipX()) > x2, 'swipe left scrolls earlier');
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'the page did not scroll instead');
    // the slider and the keys
    x0 = await clipX();
    await page.locator('#pan').fill('1000');
    await settle();
    assert.ok((await clipX()) < x0, 'the slider at the end shows the later part');
    assert.match(await page.locator('#pan').getAttribute('aria-valuetext'), /^Showing 0:\d\d\.\d to 0:10\.0 of 0:10\.0$/);
    await page.locator('#timeline-wrap').focus();
    x0 = await clipX();
    await page.keyboard.press('PageUp');
    await settle();
    assert.ok((await clipX()) > x0, 'PageUp scrolls back a page');
    // seeking brings the playhead into view
    const inView = () => page.evaluate(() => { const t = document.querySelector('.vis-custom-time').getBoundingClientRect(); const w = document.getElementById('timeline').getBoundingClientRect(); return t.left >= w.left && t.left <= w.right; });
    await page.keyboard.press('Home');
    await settle();
    assert.equal(await inView(), true, 'Home: the playhead is in view');
    await page.keyboard.press('End');
    await settle();
    assert.equal(await inView(), true, 'End: the view followed the playhead to the end');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('multi-select: Shift+click, Cmd+click and Ctrl+A select several clips; batch copy, paste, duplicate and delete; a group drag; each is one undo step', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    const api = async () => (await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: { authorization: `Bearer ${studio.token}` } })).json()).project;
    const subs = async () => (await api()).layers.find((l) => l.kind === 'subtitle').clips.map((c) => [c.id, c.start]);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const inspector = () => page.locator('#inspector').innerText();
    const item = (text) => page.locator('.vis-item.kind-subtitle', { hasText: text });
    const settle = () => page.waitForTimeout(350);

    // Shift+click adds a clip to the selection (Ctrl+click is a right-click on a Mac, so it opens the menu there)
    await item('Hello there').click();
    await item('A second line').click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => /2 clips selected/.test(document.getElementById('inspector').innerText));
    assert.match(await inspector(), /Span\s+0:00\.5 - 0:07\.0/);
    assert.equal(await page.locator('#split').isDisabled(), true, 'split needs exactly one clip');
    assert.equal(await page.locator('#copy').isDisabled(), false);
    assert.equal(await page.locator('.vis-item.vis-selected').count(), 2);
    // Cmd+click toggles a clip out of the selection and back in
    await item('A second line').click({ modifiers: ['Meta'] });
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.vis-selected').length === 1);
    await item('A second line').click({ modifiers: ['Meta'] });
    await page.waitForFunction(() => /2 clips selected/.test(document.getElementById('inspector').innerText));

    // batch copy + paste at the playhead: the two keep their 3.5 s distance, and the new pair is selected
    await page.keyboard.press('Control+c');
    await page.locator('#timeline-wrap').focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+v');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 4);
    assert.deepEqual((await subs()).map(([, s]) => s), [500, 4000, 10000, 13500]);
    assert.match(await inspector(), /2 clips selected/, 'the pasted pair is the selection');
    // Delete removes both in one go, one undo brings both back
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 2);
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 4);
    assert.equal((await subs()).length, 4, 'ONE undo restored both');
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 2);
    assert.equal((await subs()).length, 2, 'the second undo removed the paste');

    // Duplicate: the pair lands right after itself
    await item('Hello there').click();
    await item('A second line').click({ modifiers: ['Shift'] });
    await page.locator('#duplicate').click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 4);
    assert.deepEqual((await subs()).map(([, s]) => s), [500, 4000, 7000, 10500], 'the copy of the block starts where the selection ended');
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelectorAll('.vis-item.kind-subtitle').length === 2);

    // the batch menu on a selected clip
    await item('Hello there').click();
    await item('A second line').click({ modifiers: ['Shift'] });
    await item('Hello there').click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    assert.equal(await page.locator('[role=menu]').getAttribute('aria-label'), '2 clips options');
    assert.equal(await page.getByRole('menuitem', { name: 'Copy 2 clips' }).count(), 1);
    await page.keyboard.press('Escape');

    // a group drag moves both clips by the same distance and is one undo step
    const before = await subs();
    const box = await item('Hello there').boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 30 + 90, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction((b) => document.querySelectorAll('.vis-item').length > 0 && true, before);
    await settle();
    const after = await subs();
    const d1 = after[0][1] - before[0][1];
    const d2 = after[1][1] - before[1][1];
    assert.ok(d1 > 0, `the dragged clip moved: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    assert.equal(d1, d2, 'both clips moved by the same amount');
    await page.locator('#undo').click();
    await settle();
    assert.deepEqual(await subs(), before, 'ONE undo put the whole group back');

    // Ctrl+A selects every clip, Escape clears it; a lane menu selects a whole layer
    await page.locator('#timeline-wrap').focus();
    await page.keyboard.press('Control+a');
    await page.waitForFunction(() => /5 clips selected/.test(document.getElementById('inspector').innerText));
    assert.equal(await page.locator('.vis-item.vis-selected').count(), 5);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => /Select a clip/.test(document.getElementById('inspector').innerText));
    const lane = await page.locator('.vis-foreground .vis-group.kind-subtitle').first().boundingBox();
    await page.mouse.click(lane.x + lane.width * 0.93, lane.y + lane.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: /Select all 2 clips in this layer/ }).click();
    await page.waitForFunction(() => /2 clips selected/.test(document.getElementById('inspector').innerText));
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('player controls: visible by default; the seek bar follows and drives the timeline playhead; mute, CC and full screen work; the preview resizes and remembers its width', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const time = () => page.locator('#time').innerText();
    const seekValue = () => page.locator('#seek').inputValue();
    const canFullscreen = await page.evaluate(() => document.fullscreenEnabled);

    // shown by default: no hover, no click needed
    for (const id of ['play', 'seek', 'mute', 'cc']) assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} is visible`);
    assert.equal(await page.locator('#fullscreen').isVisible(), canFullscreen, 'full screen is offered when the browser can do it');
    assert.equal(await page.locator('#seek').getAttribute('max'), '10000', 'the seek bar spans the whole timeline (10 s), not one clip');

    // the seek bar drives the playhead ...
    await page.locator('#seek').fill('5000');
    assert.match(await time(), /^0:05\.0 \/ 0:10\.0$/);
    assert.equal(await page.locator('#seek').getAttribute('aria-valuetext'), '0:05.0 of 0:10.0');
    // ... and follows every other way of moving it: keys, the ruler, Home and End
    await page.locator('#timeline-wrap').focus();
    await page.keyboard.press('End');
    assert.equal(await seekValue(), '10000');
    await page.keyboard.press('Home');
    assert.equal(await seekValue(), '0');
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await seekValue(), '1000');
    const axis = await page.locator('.vis-time-axis').first().boundingBox();
    await page.mouse.click(axis.x + axis.width * 0.5, axis.y + 8);
    const afterClick = Number(await seekValue());
    assert.ok(afterClick > 3000 && afterClick < 7500, `a click on the ruler moved the seek bar: ${afterClick}`);
    assert.equal((await time()).split(' / ')[0], `0:0${Math.floor(afterClick / 1000)}.${Math.floor((afterClick % 1000) / 100)}`.replace(/^0:0(\d\d)/, '0:$1'), 'the time readout agrees with the bar');

    // CC shows and hides the subtitle line in the preview
    await page.locator('#seek').fill('1000'); // inside the first subtitle (0.5 - 3.5 s)
    assert.equal(await page.locator('#subtitle-overlay').isVisible(), true);
    assert.match(await page.locator('#subtitle-overlay').innerText(), /Hello there/);
    await page.locator('#cc').click();
    assert.equal(await page.locator('#cc').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#subtitle-overlay').isVisible(), false, 'CC off hides the subtitle');
    await page.keyboard.press('c');
    assert.equal(await page.locator('#cc').getAttribute('aria-pressed'), 'true', 'the C key toggles it back');
    assert.equal(await page.locator('#subtitle-overlay').isVisible(), true);

    // mute: a preview-only switch, on the button and on M
    assert.equal(await page.locator('#player').getAttribute('data-muted'), null);
    await page.locator('#mute').click();
    assert.equal(await page.locator('#mute').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#mute').getAttribute('aria-label'), 'Unmute');
    assert.equal(await page.locator('#mute use').getAttribute('href'), '#i-volume-off', 'the icon shows the muted speaker');
    assert.equal(await page.locator('#player').getAttribute('data-muted'), 'true');
    await page.keyboard.press('m');
    assert.equal(await page.locator('#mute').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#mute').getAttribute('aria-label'), 'Mute');
    assert.equal(await page.locator('#mute use').getAttribute('href'), '#i-volume');

    // full screen: the whole preview (picture and controls) goes full screen, and leaving it restores the button
    if (canFullscreen) {
      await page.locator('#fullscreen').click();
      await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === 'stage');
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#seek').isVisible(), true, 'the controls come along');
      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(() => !document.fullscreenElement && document.getElementById('fullscreen').getAttribute('aria-pressed') === 'false');
      assert.equal(await page.locator('#fullscreen').getAttribute('aria-label'), 'Full screen', 'the label is back');
      assert.equal(await page.locator('#fullscreen use').getAttribute('href'), '#i-expand');
    }

    // big by default, resizable with the grip under the controls (drag or keys), it remembers, and it resets
    const stageW = () => page.evaluate(() => Math.round(document.getElementById('picture').getBoundingClientRect().width)); // the picture's width: the panel around it is always the timeline's width
    const stored = () => page.evaluate(() => localStorage.getItem('studio-editor-stage-w'));
    const w0 = await stageW();
    assert.ok(w0 >= 700, `the preview is big by default: ${w0}px wide in a 1280x900 window`);
    const tlBox = await page.locator('#timeline-wrap').boundingBox();
    const panelBox = await page.locator('#stage').boundingBox();
    assert.ok(Math.abs(panelBox.width - tlBox.width) <= 1 && Math.abs(panelBox.x - tlBox.x) <= 1, `the preview panel is as wide as the timeline panel (${panelBox.width} vs ${tlBox.width})`);
    assert.ok(tlBox.y + tlBox.height <= 900, `and the whole timeline is still on screen (it ends at ${Math.round(tlBox.y + tlBox.height)} of 900)`);
    assert.equal(await stored(), null, 'the default is not stored: it follows the window');
    assert.equal(await page.locator('#stage-grip').getAttribute('role'), 'separator');
    await page.locator('#stage-grip').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await stageW(), w0 + 120, 'three presses of Down: 40 px wider each');
    assert.equal(await stored(), String(w0 + 120));
    await page.keyboard.press('ArrowUp');
    assert.equal(await stageW(), w0 + 80);
    await page.keyboard.press('Home');
    assert.equal(await stageW(), 480, 'Home: small');
    await page.keyboard.press('End');
    assert.equal(await stageW(), 1246, 'End: as wide as the panel allows (the timeline\'s width less its border)');
    const time0 = await time();
    await page.keyboard.press('Enter');
    assert.equal(await stageW(), w0, 'Enter: back to the default');
    assert.equal(await stored(), null);
    assert.equal(await time(), time0, 'the grip keys did not move the playhead');
    // dragging the grip down makes the (16:9) picture taller and so wider
    const grip = await page.locator('#stage-grip').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 90, { steps: 8 });
    await page.mouse.up();
    const dragged = await stageW();
    assert.ok(dragged < w0 - 100, `dragging up 90 px made it smaller: ${w0} -> ${dragged}`);
    await page.reload();
    await page.waitForSelector('body[data-ready="demo"]');
    assert.equal(await stageW(), dragged, 'the size came back after a reload');
    await page.locator('#stage-grip').dblclick();
    assert.equal(await stageW(), w0, 'a double-click on the grip resets it');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('volume knobs: master, layer and clip; keys, drag, double-click reset, typing a value; each is one undo step and none of them moves the playhead', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    const api = async () => (await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: { authorization: `Bearer ${studio.token}` } })).json()).project;
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const settle = () => page.waitForTimeout(700); // keys and the wheel send their edit once they settle
    const master = page.locator('#master-knob');
    const text = (loc) => loc.getAttribute('aria-valuetext');
    const time = () => page.locator('#time').innerText();

    // the master knob: a slider that starts at unity
    assert.equal(await master.getAttribute('role'), 'slider');
    assert.equal(await text(master), '0.0 dB');
    assert.equal((await api()).master, undefined);
    const t0 = await time();
    await master.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
    await settle();
    const down = (await api()).master;
    assert.ok(down > 0.6 && down < 0.85, `five steps down is a few dB below unity: ${down}`);
    assert.match(await text(master), /^-[23]\.\d dB$/);
    assert.equal(await time(), t0, 'the arrow keys belong to the knob while it has focus: the playhead did not move');
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.getElementById('master-knob').getAttribute('aria-valuetext') === '0.0 dB');
    assert.equal((await api()).master, undefined, 'ONE undo took the burst of key presses back');
    await page.locator('#redo').click();
    await page.waitForFunction(() => document.getElementById('master-knob').getAttribute('aria-valuetext') !== '0.0 dB');

    // double-click resets to unity (and removes the field)
    await master.dblclick();
    await page.waitForFunction(() => document.getElementById('master-knob').getAttribute('aria-valuetext') === '0.0 dB');
    assert.equal((await api()).master, undefined);

    // dragging up turns it up
    const box = await master.locator('svg').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 30, { steps: 6 });
    await page.mouse.up();
    await settle();
    const up = (await api()).master;
    assert.ok(up > 1.5 && up <= 4, `dragging up 30 px turned it well above unity: ${up}`);

    // typing a value in dB from the right-click menu
    await master.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Type a value in dB/ }).click();
    const dlg = page.locator('dialog.ask[open]');
    await dlg.locator('input').fill('-6');
    await dlg.getByRole('button', { name: 'Set' }).click();
    await page.waitForFunction(() => document.getElementById('master-knob').getAttribute('aria-valuetext') === '-6.0 dB');
    assert.ok(Math.abs((await api()).master - 0.5012) < 0.001, '-6 dB is a gain of 0.5012');
    await master.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Silence' }).click();
    await page.waitForFunction(() => document.getElementById('master-knob').getAttribute('aria-valuetext') === '-inf dB');
    assert.equal((await api()).master, 0);

    // a layer knob on the voice and music lanes (not on video or subtitles), and a clip knob in the inspector
    assert.equal(await page.locator('.vis-labelset .knob[aria-label$="volume"]').count(), 2, 'voice and music have a volume knob each');
    assert.equal(await page.locator('.vis-labelset .knob[aria-label$="pan"]').count(), 2, 'and a pan knob each');
    // a pan knob: linear from -1 (left) to 1 (right), starts centred, keys move it, double-click centres it again, right-click has hard left and right
    const voicePan = page.locator('.vis-labelset .knob[aria-label="Voice pan"]');
    assert.equal(await voicePan.getAttribute('aria-valuetext'), 'C');
    await voicePan.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await settle();
    const panned = (await api()).layers.find((l) => l.id === 'voice').pan;
    assert.ok(panned > 0.05 && panned < 0.2, `five steps right of centre: ${panned}`);
    assert.match(await voicePan.getAttribute('aria-valuetext'), /^R \d+%$/);
    await page.locator('.vis-labelset .knob[aria-label="Voice pan"]').dblclick();
    await page.waitForFunction(() => document.querySelector('.vis-labelset .knob[aria-label="Voice pan"]').getAttribute('aria-valuetext') === 'C');
    assert.equal((await api()).layers.find((l) => l.id === 'voice').pan, undefined, 'centre leaves no field');
    await page.locator('.vis-labelset .knob[aria-label="Voice pan"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hard left' }).click();
    await page.waitForFunction(() => document.querySelector('.vis-labelset .knob[aria-label="Voice pan"]').getAttribute('aria-valuetext') === 'L 100%');
    assert.equal((await api()).layers.find((l) => l.id === 'voice').pan, -1);
    await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelector('.vis-labelset .knob[aria-label="Voice pan"]').getAttribute('aria-valuetext') === 'C');
    const voiceKnob = page.locator('.vis-labelset .knob[aria-label="Voice volume"]');
    await voiceKnob.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await settle();
    const voiceLayer = (await api()).layers.find((l) => l.id === 'voice');
    assert.ok(voiceLayer.gain > 0.8 && voiceLayer.gain < 0.95, `the voice layer volume: ${voiceLayer.gain}`);
    await page.locator('.vis-item.kind-voice').first().click();
    const clipKnob = page.locator('#clip-knob');
    await clipKnob.waitFor();
    await clipKnob.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await settle();
    const clipGain = (await api()).layers.find((l) => l.id === 'voice').clips[0].gain;
    assert.ok(clipGain > 0.7 && clipGain < 0.9, `the clip gain: ${clipGain}`);
    assert.match(await page.locator('#inspector').innerText(), new RegExp(`Gain ${clipGain.toFixed(2)}`));
    // a locked layer's knob is frozen
    await page.getByRole('button', { name: 'Lock Voice' }).click();
    await page.waitForFunction(() => document.querySelector('.vis-labelset .knob[aria-label="Voice volume"]').getAttribute('aria-disabled') === 'true');
    const before = (await api()).layers.find((l) => l.id === 'voice').gain;
    await page.locator('.vis-labelset .knob[aria-label="Voice volume"]').focus({ timeout: 1000 }).catch(() => {});
    await page.keyboard.press('ArrowDown');
    await settle();
    assert.equal((await api()).layers.find((l) => l.id === 'voice').gain, before, 'a locked layer keeps its volume');

    // playing exercises the Web Audio graph with all of that applied
    await page.locator('#player').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('icon buttons: every control is an icon with an accessible name and a tooltip; play and mute swap their icon; ripple is a toggle', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const ids = ['split', 'copy', 'paste', 'duplicate', 'delete', 'ripple', 'undo', 'redo', 'zoom-out', 'zoom-in', 'fit', 'layers-menu', 'play', 'mute', 'cc', 'fullscreen', 'rename-here'];
    for (const id of ids) {
      const b = page.locator(`#${id}`);
      if (id === 'fullscreen' && !(await page.evaluate(() => document.fullscreenEnabled))) continue;
      assert.equal(await b.locator('svg.ico use').count(), 1, `${id} has an icon`);
      assert.match((await b.getAttribute('aria-label')) || '', /\S/, `${id} has an accessible name`);
      assert.match((await b.getAttribute('title')) || '', /\S/, `${id} has a tooltip`);
      assert.equal((await b.innerText()).trim(), '', `${id} shows no text label`);
      const box = await b.boundingBox();
      assert.ok(box.width >= 26 && box.width <= 40 && Math.abs(box.width - box.height) <= 4, `${id} is a compact square: ${box.width}x${box.height}`);
    }
    // every icon is centred in its button (an old text-button rule once squeezed them 3-5 px off to the right)
    const off = await page.evaluate(() => [...document.querySelectorAll('button svg.ico, summary svg.ico')].filter((i) => i.parentElement.tagName === 'BUTTON' && !i.parentElement.textContent.trim()).map((i) => {
      const b = i.parentElement.getBoundingClientRect();
      const r = i.getBoundingClientRect();
      return { name: i.parentElement.getAttribute('aria-label') || i.parentElement.id, dx: Math.abs((r.left + r.width / 2) - (b.left + b.width / 2)), dy: Math.abs((r.top + r.height / 2) - (b.top + b.height / 2)) };
    }).filter((x) => x.dx > 1 || x.dy > 1));
    assert.deepEqual(off, [], 'icons that are not centred in their button');
    // and the controls of one row share one centre line
    const rowCentres = await page.evaluate(() => [...document.querySelectorAll('.transport > *')].map((el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); }));
    assert.ok(Math.max(...rowCentres) - Math.min(...rowCentres) <= 1, `the player controls sit on one line: ${rowCentres}`);
    // the lane buttons are icons too, with their names kept
    for (const name of ['Mute Video', 'Lock Voice', 'Duplicate Music']) assert.equal(await page.getByRole('button', { name }).locator('svg.ico').count(), 1, name);
    assert.equal(await page.getByRole('button', { name: 'Mute Video' }).locator('use').getAttribute('href'), '#i-eye', 'a video lane hides, so it shows an eye');
    assert.equal(await page.getByRole('button', { name: 'Mute Voice' }).locator('use').getAttribute('href'), '#i-volume', 'a voice lane silences, so it shows a speaker');
    // play: the icon shows what pressing it does
    assert.equal(await page.locator('#play use').getAttribute('href'), '#i-play');
    await page.locator('#play').click();
    assert.equal(await page.locator('#play use').getAttribute('href'), '#i-pause');
    assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Pause');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Play');
    // ripple is a toggle button
    assert.equal(await page.locator('#ripple').getAttribute('aria-pressed'), 'false');
    await page.locator('#ripple').click();
    assert.equal(await page.locator('#ripple').getAttribute('aria-pressed'), 'true');
    // the names still work as roles for people who look buttons up by name
    for (const name of ['Split', 'Undo', 'Redo', 'Copy', 'Layers']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, name);
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('the logo: a chrome X in shadow that catches a beam of light and snips now and then, and holds still for reduced motion', opts, async () => {
  await withStudio(async ({ browser, open }) => {
    const names = (page) => page.evaluate(() => ['.logo-beam', '.logo-blade.a', '.logo-blade.b'].map((s) => getComputedStyle(document.querySelector(s)).animationName));
    const normal = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
    const errors = watch(normal);
    await normal.goto(open());
    await normal.waitForSelector('.brand');
    assert.deepEqual(await names(normal), ['logo-beam', 'logo-snip-a', 'logo-snip-b'], 'three slow animations');
    assert.equal(await normal.locator('.brand .logo').count(), 1);
    assert.equal(await normal.locator('.brand .logo [data-part="metal"]').count(), 2, 'two chrome blades');
    assert.equal(await normal.locator('.brand').getAttribute('aria-label'), 'Edward, home', 'the mark is decoration; the link is named');
    assert.match(await normal.locator('link[rel=icon]').getAttribute('href'), /^data:image\/svg\+xml,/);
    const still = await (await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 900, height: 600 } })).newPage();
    await still.goto(open());
    await still.waitForSelector('.brand');
    assert.deepEqual(await names(still), ['none', 'none', 'none'], 'nothing moves when the person asks for reduced motion');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('lines in the preview: an opacity line fades the picture as drawn, a note says when the preview cannot blend, and volume, mute and pan lines play without error', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const auth = { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' };
    let current = await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: auth })).json(); // opens the session
    const op = async (name, args) => {
      const r = await (await fetch(`${studio.url}/api/editor/project/demo/ops`, { method: 'POST', headers: auth, body: JSON.stringify({ op: name, args, rev: current.rev }) })).json();
      assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
      current = r;
      return r;
    };
    // an opacity line on the video clip, 0 -> 1 over its 10 s; volume, mute and pan lines on the voice clip
    const o = await op('addAutomation', { clipId: 'c1', param: 'opacity' });
    const oid = o.project.layers.find((l) => l.kind === 'automation').id;
    await op('movePoint', { layerId: oid, index: 0, t: 0, v: 0 });
    await op('addPoint', { layerId: oid, t: 10000, v: 1 });
    for (const [param, pts] of [['gain', [[5000, 0.2]]], ['mute', [[6000, 1, 'hold']]], ['pan', [[0, -1], [8000, 1]]]]) {
      const r = await op('addAutomation', { clipId: 'c2', param });
      const id = r.newLayerId;
      if (param === 'pan') await op('movePoint', { layerId: id, index: 0, t: 0, v: -1 });
      for (const [t, v, curve] of pts.filter(([t]) => t > 0 || param !== 'pan')) await op('addPoint', { layerId: id, t, v, ...(curve ? { curve } : {}) });
    }
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    assert.equal(await page.locator('.vis-item.kind-video').count(), 1);
    assert.equal(await page.locator('.vis-labelset .vis-label', { hasText: 'demo.webm: Opacity' }).count(), 1, 'the line has a layer of its own, linked by name');
    const opacityAt = async (ms) => { await page.locator('#seek').fill(String(ms)); return Number(await page.locator('#video').evaluate((v) => v.style.opacity)); };
    assert.ok(Math.abs((await opacityAt(0)) - 0) < 0.01, 'transparent at the start of the line');
    assert.ok(Math.abs((await opacityAt(5000)) - 0.5) < 0.02, 'half way along the ramp: half opaque');
    assert.ok(Math.abs((await opacityAt(10000)) - 1) < 0.02 || Math.abs((await opacityAt(9900)) - 0.99) < 0.02, 'opaque at the end');
    assert.equal(await page.locator('#preview-note').isVisible(), false, 'nothing under the clip: the preview is exact');
    // put a second video clip under it: now the preview can only fade to black, and it says so
    await op('copyClip', { clipId: 'c1', toStartMs: 3000 });
    await page.reload();
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    await page.locator('#seek').fill('2000');
    assert.equal(await page.locator('#preview-note').isVisible(), false, 'only one clip here');
    await page.locator('#seek').fill('5000');
    assert.equal(await page.locator('#preview-note').isVisible(), true);
    assert.match(await page.locator('#preview-note').innerText(), /export blends the clip underneath/);
    // playing runs the Web Audio graph with the volume, mute and pan lines
    await page.locator('#seek').fill('5500');
    await page.locator('#player').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
    await page.keyboard.press('Space');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('drawing automation lines: start one from the clip menu, add, drag, nudge, delete and re-curve points, draw freehand and straight, snap, copy, paste, bake, and undo', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 1300 } })).newPage();
    const errors = watch(page);
    const api = async () => (await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: { authorization: `Bearer ${studio.token}` } })).json()).project;
    const lineOf = async (clipId, param) => (await api()).layers.find((l) => l.kind === 'automation' && l.link.clipId === clipId && l.link.param === param);
    const settle = () => page.waitForTimeout(650);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const box = async (param) => { const l = page.locator(`.line[data-param="${param}"]`); await l.scrollIntoViewIfNeeded(); return l.boundingBox(); };

    // 1. the clip menu offers the lines its kind can have, and starts one on a lane of its own under the clip's layer
    await page.locator('.vis-item.kind-voice').first().click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    const menu = await page.locator('[role=menu] [role=menuitem]').allInnerTexts();
    assert.ok(menu.some((t) => /Draw the volume line/.test(t)) && menu.some((t) => /Draw the pan line/.test(t)) && menu.some((t) => /Draw the mute line/.test(t)), `a voice clip can have volume, pan and mute lines: ${menu}`);
    assert.ok(!menu.some((t) => /opacity line/.test(t)), 'but no opacity line');
    await page.getByRole('menuitem', { name: 'Draw the volume line' }).click();
    await page.waitForSelector('.line[data-param="gain"]');
    const order = await page.locator('.vis-labelset .vis-label .lane-name').allInnerTexts();
    assert.deepEqual(order, ['Video', 'Voice', 'demo.voice.opus: Volume', 'Music', 'Subtitles'], 'the line\'s lane is right under its clip\'s layer, pushing the others down');
    await page.waitForFunction(() => document.activeElement.classList.contains('pt') && document.activeElement.dataset.index === '0', null, { timeout: 3000 });
    let ln = await lineOf('c2', 'gain');
    assert.deepEqual(ln.points.map((p) => [p.t, p.v]), [[0, 1]], 'one point, at the clip\'s current volume, so nothing changes yet');

    // 2. pencil: click the lane to add a point where you clicked
    let b = await box('gain');
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await settle();
    ln = await lineOf('c2', 'gain');
    assert.equal(ln.points.length, 2);
    assert.ok(Math.abs(ln.points[1].t - 5000) < 250, `added at about 5 s: ${ln.points[1].t}`);
    assert.ok(ln.points[1].v > 0.1 && ln.points[1].v < 0.9, `about half way up the lane is a quiet-ish level: ${ln.points[1].v}`);
    await page.waitForFunction(() => document.activeElement.classList.contains('pt') && document.activeElement.dataset.index === '1', null, { timeout: 3000 }); // focus moved to the new point

    // 3. drag a point: time and value change, in one undo step
    const before = ln.points[1];
    const dot = page.locator('.line[data-param="gain"] .pt').nth(1);
    let d = await dot.boundingBox();
    await page.mouse.move(d.x + 6, d.y + 6);
    await page.mouse.down();
    await page.mouse.move(d.x + 6 + 90, d.y + 6 - 12, { steps: 8 });
    assert.equal(await page.locator('.line[data-param="gain"] .readout').isVisible(), true, 'a readout follows the point while it moves');
    await page.mouse.up();
    await settle();
    ln = await lineOf('c2', 'gain');
    assert.ok(ln.points[1].t > before.t + 300 && ln.points[1].v > before.v, `moved later and louder: ${JSON.stringify(before)} -> ${JSON.stringify(ln.points[1])}`);
    await page.locator('#undo').click();
    await settle();
    assert.equal((await lineOf('c2', 'gain')).points[1].t, before.t, 'ONE undo put the point back');
    await page.locator('#redo').click();
    await settle();

    // 4. the keyboard: arrows nudge (a frame in time, 1% in value), C cycles the curve, Delete removes
    const t1 = (await lineOf('c2', 'gain')).points[1];
    await page.locator('.line[data-param="gain"] .pt').nth(1).focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    await settle();
    const nudged = (await lineOf('c2', 'gain')).points[1];
    assert.equal(nudged.t - t1.t, 3 * 33, 'three frames later (30 fps)');
    assert.ok(nudged.v > t1.v, 'a little louder');
    assert.equal(await page.locator('#time').innerText().then((s) => s.split(' / ')[0]), '0:00.0', 'the arrows belonged to the point: the playhead did not move');
    await page.keyboard.press('c');
    await settle();
    assert.notEqual((await lineOf('c2', 'gain')).points[1].curve, 'linear', 'C moved the point to the next curve');
    // right-click a point: its curve and delete
    await page.locator('.line[data-param="gain"] .pt').nth(1).click({ button: 'right' });
    await page.locator('[role=menu]').waitFor();
    assert.equal(await page.locator('[role=menu]').getAttribute('aria-label'), 'Volume line options');
    await page.getByRole('menuitem', { name: 'Ease out' }).click();
    await settle();
    assert.equal((await lineOf('c2', 'gain')).points[1].curve, 'ease-out');
    await page.locator('.line[data-param="gain"] .pt').nth(1).focus();
    await page.keyboard.press('Delete');
    await settle();
    assert.equal((await lineOf('c2', 'gain')).points.length, 1, 'Delete removed the point');
    await page.locator('.line[data-param="gain"] .pt').nth(0).dblclick();
    await settle();
    assert.equal((await lineOf('c2', 'gain')).points.length, 1, 'the last point cannot be removed: a line keeps one');

    // 5. snapping: a point dropped near the playhead lands exactly on it (Alt turns snapping off)
    await page.locator('#seek').fill('3000');
    b = await box('gain');
    await page.mouse.click(b.x + b.width * 0.6, b.y + b.height * 0.3);
    await settle();
    const added = (await lineOf('c2', 'gain')).points[1];
    d = await page.locator('.line[data-param="gain"] .pt').nth(1).boundingBox();
    b = await box('gain');
    const x3000 = b.x + b.width * 0.3;
    await page.mouse.move(d.x + 6, d.y + 6);
    await page.mouse.down();
    await page.mouse.move(x3000 + 3, d.y + 6, { steps: 10 });
    await page.mouse.up();
    await settle();
    assert.equal((await lineOf('c2', 'gain')).points[1].t, 3000, `snapped to the playhead at 3 s (from ${added.t})`);
    await page.locator('#undo').click();
    await settle();

    // 6. freehand: draw a wobbly stroke, it becomes a few points, not hundreds
    await page.locator('#tool-freehand').click();
    assert.equal(await page.locator('#tolerance').isVisible(), true, 'the simplify slider appears for freehand');
    b = await box('gain');
    await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.7);
    await page.mouse.down();
    for (let i = 0; i <= 60; i++) await page.mouse.move(b.x + b.width * (0.1 + i * 0.012), b.y + b.height * (0.5 + 0.3 * Math.sin(i / 8)));
    await page.mouse.up();
    await settle();
    ln = await lineOf('c2', 'gain');
    assert.ok(ln.points.length >= 4 && ln.points.length <= 25, `a 60-sample stroke became ${ln.points.length} points`);
    assert.ok(ln.points.every((p, i) => i === 0 || p.t > ln.points[i - 1].t), 'in strict time order');

    // 7. straight line tool: drag from one place to another
    await page.locator('#tool-line').click();
    assert.equal(await page.locator('#tolerance').isVisible(), false);
    b = await box('gain');
    await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.7, b.y + b.height * 0.3, { steps: 6 });
    await page.mouse.up();
    await settle();
    ln = await lineOf('c2', 'gain');
    const segStart = ln.points.find((p) => Math.abs(p.t - 2000) < 200);
    const segEnd = ln.points.find((p) => Math.abs(p.t - 7000) < 200);
    assert.ok(segStart && segEnd && segEnd.v > segStart.v, `a straight segment from about 2 s (quiet) to 7 s (louder): ${JSON.stringify(ln.points.map((p) => [p.t, p.v]))}`);
    assert.ok(ln.points.filter((p) => p.t > segStart.t && p.t < segEnd.t).length === 0, 'and nothing else between its ends');
    await page.locator('#tool-pencil').click();

    // 8. a mute line is steps: click the top half for muted, the bottom for sound
    await page.locator('.vis-item.kind-voice').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Draw the mute line' }).click();
    await page.waitForSelector('.line[data-param="mute"]');
    b = await box('mute');
    await page.mouse.click(b.x + b.width * 0.4, b.y + b.height * 0.2);
    await settle();
    await page.mouse.click(b.x + b.width * 0.7, b.y + b.height * 0.85);
    await settle();
    const mu = await lineOf('c2', 'mute');
    assert.deepEqual(mu.points.map((p) => [p.v, p.curve]).slice(1), [[1, 'hold'], [0, 'hold']], 'muted (1) then sound (0), both as steps');

    // 9. bypass, lock and delete on the line's own lane
    await page.getByRole('button', { name: /^Bypass demo\.voice\.opus: Mute/ }).click();
    await settle();
    assert.equal((await lineOf('c2', 'mute')).muted, true, 'bypassed: the clip plays as if the line were not there');
    await page.getByRole('button', { name: /^Lock demo\.voice\.opus: Mute/ }).click();
    await settle();
    b = await box('mute');
    await page.mouse.click(b.x + b.width * 0.9, b.y + b.height * 0.2);
    await settle();
    assert.equal((await lineOf('c2', 'mute')).points.length, 3, 'a locked line takes no new points');
    await page.getByRole('button', { name: /^Delete demo\.voice\.opus: Mute/ }).click();
    await settle();
    assert.ok(await lineOf('c2', 'mute'), 'a locked line cannot be deleted either');
    await page.getByRole('button', { name: /^Lock demo\.voice\.opus: Mute/ }).click();
    await settle();
    await page.getByRole('button', { name: /^Delete demo\.voice\.opus: Mute/ }).click();
    await settle();
    assert.equal(await lineOf('c2', 'mute'), undefined, 'the line is gone');
    assert.equal((await api()).layers.some((l) => l.id === 'voice'), true, 'the clip is not');

    // 10. copy the volume line and paste it onto the music clip; bake the original into a constant
    await page.locator('.line[data-param="gain"]').click({ button: 'right', position: { x: 300, y: 10 } });
    await page.getByRole('menuitem', { name: 'Copy this line' }).click();
    await page.locator('.vis-item.kind-music').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Paste the copied volume line here/ }).click();
    await page.waitForSelector('.line[data-param="gain"] >> nth=1');
    assert.ok(await lineOf('c3', 'gain'), 'the music clip has its own copy');
    assert.equal((await lineOf('c3', 'gain')).points.length, (await lineOf('c2', 'gain')).points.length, 'the same drawing');
    await page.locator('.line[data-layer="' + (await lineOf('c2', 'gain')).id + '"]').click({ button: 'right', position: { x: 300, y: 10 } });
    await page.getByRole('menuitem', { name: 'Use the average' }).click();
    await settle();
    assert.equal(await lineOf('c2', 'gain'), undefined, 'baked: the line is gone');
    const baked = (await api()).layers.find((l) => l.id === 'voice').clips[0].gain;
    assert.ok(baked > 0 && baked < 4 && baked !== 1, `the clip has its own volume now: ${baked}`);

    // 11. "Automate" from a knob, and the clip's pan knob
    await page.locator('.vis-item.kind-voice').first().click();
    await page.locator('#clip-pan-knob').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Automate pan (draw a line)' }).click();
    await page.waitForSelector('.line[data-param="pan"]');
    assert.ok(await lineOf('c2', 'pan'), 'the knob started a pan line');
    await page.locator('.vis-item.kind-voice').first().click();
    await page.locator('#clip-pan-knob').focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
    await settle();
    assert.ok((await api()).layers.find((l) => l.id === 'voice').clips[0].pan < -0.05, 'the clip pan knob moves the constant');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('the preview plays a clip at its speed: the video and the sound run at the clip\'s rate, and a normal clip stays at 1', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => { window.__audios = []; const A = window.Audio; window.Audio = function (...a) { const x = new A(...a); window.__audios.push(x); return x; }; });
    const page = await ctx.newPage();
    const errors = watch(page);
    const auth = { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' };
    const get = async () => (await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: auth })).json());
    const op = async (name, args) => { const r = await (await fetch(`${studio.url}/api/editor/project/demo/ops`, { method: 'POST', headers: auth, body: JSON.stringify({ op: name, args, rev: (await get()).rev }) })).json(); assert.equal(r.ok, true, JSON.stringify(r)); return r.project; };
    const before = (await get()).project;
    const video = before.layers.find((l) => l.kind === 'video').clips[0];
    const voice = before.layers.find((l) => l.kind === 'voice').clips[0];
    await op('setClipSpeed', { clipId: video.id, speed: 2 });
    const after = await op('setClipSpeed', { clipId: voice.id, speed: 0.5 });
    assert.equal(after.layers.find((l) => l.kind === 'video').clips[0].duration, Math.round(video.duration / 2), 'the model halves the video\'s slot');
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    await page.locator('#seek').fill('1000');
    assert.equal(await page.evaluate(() => document.getElementById('video').playbackRate), 2, 'the video plays at 2x');
    await page.waitForFunction(() => window.__audios.some((a) => a.playbackRate === 0.5), null, { timeout: 3000 });
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('speed from the clip menu: half, double and a custom speed change the slot on the timeline, warn when the picture and the narration no longer line up, and undo in one step', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    const project = async () => (await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: { authorization: `Bearer ${studio.token}` } })).json()).project;
    const clipOf = async (kind) => (await project()).layers.find((l) => l.kind === kind).clips[0];
    const settle = () => page.waitForTimeout(650);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    const v0 = await clipOf('video');
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    const items = await page.locator('[role=menu] [role=menuitem]').allInnerTexts();
    for (const want of [/Half speed/, /Normal speed/, /Double speed/, /Custom speed/]) assert.ok(items.some((t) => want.test(t)), `the clip menu offers ${want}: ${items}`);
    assert.equal(await page.getByRole('menuitem', { name: 'Normal speed (1x)' }).isDisabled(), true, 'the current speed is not offered again');
    await page.getByRole('menuitem', { name: 'Double speed (2x)' }).click();
    await settle();
    let v = await clipOf('video');
    assert.equal(v.speed, 2);
    assert.equal(v.duration, Math.round(v0.duration / 2), 'twice as fast takes half the time on the timeline');
    assert.match(await page.locator('#toast').innerText(), /video clip runs at 2x, but the voice it overlaps .* is at 1x/, 'the picture and the narration no longer line up: the user is told');
    await page.locator('.vis-item.kind-video').first().click();
    assert.match(await page.locator('#inspector').innerText(), /Speed\s*2x/, 'the inspector shows the speed');
    // one undo puts the length and the speed back
    await page.locator('#undo').click();
    await settle();
    v = await clipOf('video');
    assert.equal(v.speed, undefined);
    assert.equal(v.duration, v0.duration, 'ONE undo restored the length');
    // a custom speed through the dialog; the same on the voice clip is in sync, so no warning
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Custom speed...' }).click();
    await page.locator('dialog.ask input').fill('4x');
    await page.getByRole('button', { name: 'Set speed' }).click();
    await settle();
    v = await clipOf('video');
    assert.equal(v.speed, 4);
    await page.locator('#toast').evaluate((el) => { el.hidden = true; el.textContent = ''; });
    await page.locator('.vis-item.kind-voice').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Custom speed...' }).click();
    await page.locator('dialog.ask input').fill('4');
    await page.getByRole('button', { name: 'Set speed' }).click();
    await settle();
    assert.equal((await clipOf('voice')).speed, 4);
    assert.doesNotMatch(await page.locator('#toast').innerText(), /out of sync/, 'both at 4x: nothing to warn about');
    // a bad answer is refused with a message and changes nothing
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Custom speed...' }).click();
    await page.locator('dialog.ask input').fill('fast');
    await page.getByRole('button', { name: 'Set speed' }).click();
    await page.waitForFunction(() => /Speed is a number from 0\.25 to 16/.test(document.getElementById('toast').textContent), null, { timeout: 3000 });
    assert.equal((await clipOf('video')).speed, 4);
    // subtitle clips have no speed
    await page.locator('.vis-item.kind-subtitle').first().click({ button: 'right' });
    assert.ok(!(await page.locator('[role=menu] [role=menuitem]').allInnerTexts()).some((t) => /speed/i.test(t)), 'a subtitle clip has no speed items');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('zoom from the clip menu and in the preview: zoom in from the playhead, a custom amount, remove it; the picture is scaled and shifted in the preview and clipped to the frame; undo restores it', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    const clip = async () => (await (await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: { authorization: `Bearer ${studio.token}` } })).json()).project.layers.find((l) => l.kind === 'video').clips[0]);
    const settle = () => page.waitForTimeout(650);
    const transform = () => page.evaluate(() => document.getElementById('video').style.transform);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    assert.equal(await transform(), '', 'no zoom, no transform');
    await page.locator('#seek').fill('2000');
    await page.locator('.vis-item.kind-voice').first().click({ button: 'right' });
    assert.ok(!(await page.locator('[role=menu] [role=menuitem]').allInnerTexts()).some((t) => /zoom/i.test(t)), 'only video clips have a zoom');
    await page.keyboard.press('Escape');
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Zoom in 2x from the playhead' }).click();
    await settle();
    let z = (await clip()).zoom;
    assert.equal(z.scale, 2);
    assert.ok(Math.abs(z.at - 2000) <= 40, `it starts at the playhead (2 s into the clip): ${z.at}`);
    await page.locator('#seek').fill('5000'); // well after the ramp
    const t = await transform();
    assert.match(t, /^scale\(2\) translate\(-25%, -25%\)$/, `fully zoomed, centred: the window is the middle half: ${t}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('picture')).overflow), 'hidden', 'the zoomed picture is clipped to the frame');
    await page.locator('#seek').fill('500');
    assert.equal(await transform(), '', 'before the zoom starts the picture is untouched');
    await page.locator('.vis-item.kind-video').first().click();
    assert.match(await page.locator('#inspector').innerText(), /Zoom\s*2x from/, 'the inspector shows the zoom');
    // a custom amount keeps where it starts; a bad one is refused
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Custom zoom...' }).click();
    await page.locator('dialog.ask input').fill('9');
    await page.getByRole('button', { name: 'Set zoom' }).click();
    await page.waitForFunction(() => /Zoom is a number from 1\.05 to 8/.test(document.getElementById('toast').textContent), null, { timeout: 3000 });
    assert.equal((await clip()).zoom.scale, 2, 'nothing changed');
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Custom zoom...' }).click();
    await page.locator('dialog.ask input').fill('4x');
    await page.getByRole('button', { name: 'Set zoom' }).click();
    await settle();
    z = (await clip()).zoom;
    assert.equal(z.scale, 4);
    assert.ok(Math.abs(z.at - 2000) <= 40, 'it still starts where it did');
    // remove, then undo brings it back in one step
    await page.locator('.vis-item.kind-video').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove the zoom' }).click();
    await settle();
    assert.equal((await clip()).zoom, undefined);
    await page.locator('#undo').click();
    await settle();
    assert.equal((await clip()).zoom.scale, 4, 'ONE undo brought the zoom back');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});

test('notes: add one at the playhead, see its flag on the ruler and its row, edit, mark done, jump to it, delete; each is one undo step and the notes are saved with the project', opts, async () => {
  await withStudio(async ({ studio, browser, open }) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errors = watch(page);
    const notes = async () => (await (await (await fetch(`${studio.url}/api/editor/project/demo`, { headers: { authorization: `Bearer ${studio.token}` } })).json()).project.notes);
    const settle = () => page.waitForTimeout(650);
    await page.goto(open('#/p/demo'));
    await page.waitForSelector('body[data-ready="demo"]');
    await page.waitForSelector('.vis-item');
    assert.equal(await page.locator('#note-empty').isVisible(), true, 'a hint shows while there are no notes');
    assert.equal(await page.locator('.note-mark').count(), 0);
    // adding: an empty note is refused, a real one lands at the playhead
    await page.locator('#add-note').click();
    assert.match(await page.locator('#toast').innerText(), /Write the note first/);
    await page.locator('#seek').fill('4000');
    await page.locator('#note-text').fill('  tighten this pause  ');
    await page.locator('#add-note').click();
    await settle();
    let n = await notes();
    assert.deepEqual(n.map((x) => [x.id, x.at, x.text]), [['n1', 4000, 'tighten this pause']]);
    assert.equal(await page.locator('#note-text').inputValue(), '', 'the field is cleared');
    assert.equal(await page.locator('#note-empty').isVisible(), false);
    assert.equal(await page.locator('.note-list li').count(), 1);
    assert.equal(await page.locator('.note-list .note-time').innerText(), '0:04.0');
    // the flag sits on the ruler at 4 s: 40% of the way along a 10 s timeline
    assert.equal(await page.locator('.note-mark').count(), 1, 'a flag on the ruler');
    const at = await page.evaluate(() => { const c = document.querySelector('#timeline .vis-panel.vis-center').getBoundingClientRect(); const m = document.querySelector('.note-mark').getBoundingClientRect(); return (m.left + m.width / 2 - c.left) / c.width; });
    assert.ok(at > 0.3 && at < 0.5, `the flag is about 40% along the timeline: ${at}`);
    // a second note earlier in time sorts first
    await page.locator('#seek').fill('1000');
    await page.locator('#note-text').fill('intro too long');
    await page.locator('#note-text').press('Enter');
    await settle();
    n = await notes();
    assert.deepEqual(n.map((x) => x.id), ['n2', 'n1'], 'time order');
    assert.deepEqual(await page.locator('.note-list li input[type=text]').evaluateAll((els) => els.map((e) => e.value)), ['intro too long', 'tighten this pause']);
    // typing in the note box does not trigger shortcuts (S would split, Space would play)
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    // edit in place
    const first = page.locator('.note-list li input[type=text]').first();
    await first.fill('intro is far too long');
    await first.press('Tab');
    await settle();
    assert.equal((await notes())[0].text, 'intro is far too long');
    // done
    await page.locator('.note-list li input[type=checkbox]').first().check();
    await settle();
    assert.equal((await notes())[0].done, true);
    assert.equal(await page.locator('.note-mark.done').count(), 1, 'a done note is drawn differently');
    // jump: the time button moves the playhead
    await page.locator('#seek').fill('9000');
    await page.locator('.note-list .note-time').nth(1).click();
    assert.match(await page.locator('#time').innerText(), /^0:04\.0/);
    // the flag jumps and focuses its row
    await page.locator('#seek').fill('9000');
    await page.locator('.note-mark').first().click();
    assert.match(await page.locator('#time').innerText(), /^0:01\.0/);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.note), 'n2', 'the note text is focused');
    // undo takes the done mark back, then the edit; delete and undo
    await page.locator('#undo').click();
    await settle();
    assert.equal((await notes())[0].done, undefined, 'ONE undo took the done mark back');
    await page.locator('.note-list li button[aria-label^="Delete the note"]').first().click();
    await settle();
    assert.deepEqual((await notes()).map((x) => x.id), ['n1']);
    assert.equal(await page.locator('.note-mark').count(), 1);
    await page.locator('#undo').click();
    await settle();
    assert.equal((await notes()).length, 2, 'undo brings the note back');
    // saved with the project: a reload finds them
    await page.locator('#save').click();
    await page.waitForFunction(() => document.getElementById('save-state').dataset.state === 'saved', null, { timeout: 5000 });
    await page.reload();
    await page.waitForSelector('body[data-ready="demo"]');
    assert.equal(await page.locator('.note-list li').count(), 2, 'the notes came back after a reload');
    assert.deepEqual(errors, [], 'no script errors or CSP violations');
  });
});
