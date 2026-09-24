// Project management: create (blank or from a job), list, save with a rev, duplicate, rename, delete to .trash, autosave recovery,
// portable bundles, and that nothing ever leaves the workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { ERR, validateProject } from '../src/editor/project.mjs';
import { sampleProject, writeSampleWorkspace } from '../src/editor/sample.mjs';
import { BUNDLE_FORMAT, checkSlug, openStore, slugify } from '../src/editor/store.mjs';

const fresh = (opts) => {
  const dir = fs.realpathSync(makeTempDir('studio-editor-store-'));
  writeSampleWorkspace(dir, opts);
  return { dir, store: openStore(dir, { now: () => Date.UTC(2026, 8, 24, 10, 0, 0) }) };
};
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const codeAsync = async (p) => { try { await p; } catch (e) { return e.code; } return null; };
const none = (c, a, o, cb) => cb(new Error('no ffprobe'), '', '');

test('slugs: checkSlug refuses paths; slugify makes a safe name from free text', () => {
  for (const bad of ['../x', 'a/b', '/etc', '', '.hidden', 'a b', 'x'.repeat(65), null, 5]) assert.equal(code(() => checkSlug(bad)), ERR.BAD_SLUG, String(bad));
  assert.equal(checkSlug('my-demo.v2'), 'my-demo.v2');
  assert.equal(slugify('My Demo!'), 'my-demo');
  assert.equal(slugify('../../etc'), 'etc');
  assert.equal(slugify('   '), null);
});

test('create a blank project, or one from a Studio job; a taken name is EXISTS', async () => {
  const { dir, store } = fresh({ withProject: false });
  const blank = await store.createProject({ name: 'My first demo' });
  assert.equal(blank.slug, 'my-first-demo');
  assert.equal(validateProject(blank.project).ok, true);
  assert.deepEqual(blank.project.layers.map((l) => l.kind), ['video', 'voice', 'music', 'subtitle']);
  assert.ok(fs.existsSync(path.join(dir, 'my-first-demo.studio.json')));
  assert.equal(await codeAsync(store.createProject({ name: 'My first demo' })), ERR.EXISTS);
  fs.writeFileSync(path.join(dir, 'demo.captions.json'), JSON.stringify([{ text: 'Hi', start: 1 }]));
  const job = await store.createProject({ name: 'From the job', from: 'demo' }, { execFile: (c, a, o, cb) => cb(new Error('x'), '', '') });
  assert.equal(job.slug, 'from-the-job');
  assert.equal(job.project.layers[0].clips[0].src, 'demo.webm');
  assert.equal(job.project.layers[3].clips[0].text, 'Hi');
  assert.equal(await codeAsync(store.createProject({ name: 'x', from: 'missing' }, { execFile: none })), ERR.NO_VIDEO);
  assert.equal(await codeAsync(store.createProject({ name: 'x', from: '../demo' })), ERR.BAD_SLUG);
  assert.equal(await codeAsync(store.createProject({ name: '!!!' })), ERR.BAD_SLUG);
  assert.equal(await codeAsync(store.createProject({ slug: '../evil' })), ERR.BAD_SLUG);
  assert.deepEqual(store.jobs().map((j) => [j.slug, j.captions, j.voice, j.music, j.hasProject]), [['demo', true, true, true, false]]);
});

test('list: name, modified time, duration and clip counts per kind, newest first; a broken file is listed as broken, not fatal', () => {
  const { dir, store } = fresh();
  fs.writeFileSync(path.join(dir, 'broken.studio.json'), '{nope');
  fs.writeFileSync(path.join(dir, 'a b.studio.json'), '{}');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
  const list = store.list();
  const demo = list.find((p) => p.slug === 'demo');
  assert.deepEqual([demo.name, demo.durationMs, demo.rev], ['Demo', 10000, 1]);
  assert.deepEqual(demo.counts, { video: 1, voice: 1, music: 1, subtitle: 2 });
  assert.deepEqual(demo.layers.map((l) => l.clips), [1, 1, 1, 2]);
  assert.match(demo.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(list.find((p) => p.slug === 'broken').broken, true);
  assert.equal(list.some((p) => p.slug === 'a b'), false);
});

test('save needs the rev: a stale rev is 409 STALE_REV with the current copy, a missing one REV_REQUIRED, an invalid project is refused', () => {
  const { store } = fresh();
  const p = sampleProject();
  p.layers[3].clips[0].text = 'edited';
  const saved = store.save('demo', p, 1);
  assert.equal(saved.rev, 2);
  assert.equal(store.need('demo').project.layers[3].clips[0].text, 'edited');
  let err;
  try { store.save('demo', p, 1); } catch (e) { err = e; }
  assert.equal(err.code, ERR.STALE_REV);
  assert.equal(err.status, 409);
  assert.equal(err.current.rev, 2, 'the current copy comes back with the error');
  assert.equal(code(() => store.save('demo', p, undefined)), ERR.REV_REQUIRED);
  assert.equal(code(() => store.save('demo', { ...p, layers: [] , version: 9 }, 2)), ERR.BAD_VERSION);
  assert.equal(code(() => store.save('nope', p, 1)), ERR.NOT_FOUND);
  assert.equal(code(() => store.save('../demo', p, 1)), ERR.BAD_SLUG);
  const bad = sampleProject();
  bad.layers[0].clips[0].src = '../../etc/passwd';
  assert.equal(code(() => store.save('demo', bad, 2)), ERR.BAD_SRC);
});

test('duplicate: a copy under a unique -copy name with its own rev; the source is untouched', () => {
  const { dir, store } = fresh();
  const a = store.duplicate('demo');
  const b = store.duplicate('demo', { name: 'Second try' });
  assert.deepEqual([a.slug, b.slug], ['demo-copy', 'demo-copy-2']);
  assert.equal(a.project.name, 'Demo copy');
  assert.equal(b.project.name, 'Second try');
  assert.equal(a.project.rev, 1);
  assert.deepEqual(a.project.layers, sampleProject().layers);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'demo.studio.json'), 'utf8')), sampleProject());
  assert.equal(code(() => store.duplicate('missing')), ERR.NOT_FOUND);
});

test('rename moves the project and its recovery copy; a taken name is EXISTS, a stale rev STALE_REV, a path BAD_SLUG', () => {
  const { dir, store } = fresh();
  store.duplicate('demo');
  store.writeAutosave('demo', sampleProject());
  assert.equal(code(() => store.rename('demo', 'demo-copy', 1)), ERR.EXISTS, 'no overwrite on a collision');
  assert.ok(fs.existsSync(path.join(dir, 'demo.studio.json')), 'the source survives a refused rename');
  assert.equal(code(() => store.rename('demo', 'other', 7)), ERR.STALE_REV);
  assert.equal(code(() => store.rename('demo', '../out', 1)), ERR.BAD_SLUG);
  assert.equal(code(() => store.rename('demo', '/abs', 1)), ERR.BAD_SLUG);
  assert.equal(code(() => store.rename('demo', 'other', undefined)), ERR.REV_REQUIRED);
  const r = store.rename('demo', 'renamed', 1);
  assert.equal(r.slug, 'renamed');
  assert.equal(r.project.name, 'Demo', 'a custom name stays; only an auto name follows the slug');
  assert.equal(r.project.rev, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'demo.studio.json')));
  assert.ok(fs.existsSync(path.join(dir, 'renamed.studio.json')));
  assert.ok(fs.existsSync(path.join(dir, 'renamed.studio.autosave.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'demo.studio.autosave.json')));
  assert.equal(store.rename('renamed', 'renamed', 2).project.rev, 2, 'renaming to itself changes nothing');
});

test('delete moves the project to .trash inside the workspace; it needs the confirm text and the rev, and erases nothing', () => {
  const { dir, store } = fresh();
  store.writeAutosave('demo', sampleProject());
  assert.equal(code(() => store.trash('demo', { rev: 1 })), ERR.CONFIRM_REQUIRED);
  assert.equal(code(() => store.trash('demo', { confirm: 'other', rev: 1 })), ERR.CONFIRM_REQUIRED);
  assert.equal(code(() => store.trash('demo', { confirm: 'demo' })), ERR.REV_REQUIRED);
  assert.equal(code(() => store.trash('demo', { confirm: 'demo', rev: 5 })), ERR.STALE_REV);
  assert.ok(fs.existsSync(path.join(dir, 'demo.studio.json')), 'nothing happened yet');
  const out = store.trash('demo', { confirm: 'demo', rev: 1 });
  assert.equal(out.trashed, 'demo.2026-09-24T10-00-00-000Z.studio.json');
  assert.ok(!fs.existsSync(path.join(dir, 'demo.studio.json')));
  assert.deepEqual(fs.readdirSync(path.join(dir, '.trash')).sort(), ['demo.2026-09-24T10-00-00-000Z.studio.autosave.json', 'demo.2026-09-24T10-00-00-000Z.studio.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.trash', out.trashed), 'utf8')), sampleProject(), 'content intact');
  assert.ok(fs.existsSync(path.join(dir, 'demo.webm')), 'media is never touched');
  assert.equal(store.list().length, 0);
  assert.equal(code(() => store.trash('../demo', { confirm: '../demo', rev: 1 })), ERR.BAD_SLUG);
});

test('autosave: a recovery copy newer than the save and different from it is offered; saving or discarding clears it', () => {
  const { dir, store } = fresh();
  assert.equal(store.recoverable('demo'), null, 'nothing yet');
  const edited = sampleProject();
  edited.layers[3].clips[0].text = 'unsaved words';
  store.writeAutosave('demo', edited);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, 'demo.studio.json'), past, past);
  const rec = store.recoverable('demo');
  assert.equal(rec.project.layers[3].clips[0].text, 'unsaved words');
  assert.match(rec.updatedAt, /^\d{4}-/);
  fs.utimesSync(path.join(dir, 'demo.studio.autosave.json'), new Date(past.getTime() - 5000), new Date(past.getTime() - 5000));
  assert.equal(store.recoverable('demo'), null, 'an older recovery copy is not offered');
  const now = new Date();
  fs.utimesSync(path.join(dir, 'demo.studio.autosave.json'), now, now);
  assert.ok(store.recoverable('demo'));
  store.writeAutosave('demo', sampleProject());
  fs.utimesSync(path.join(dir, 'demo.studio.autosave.json'), now, now);
  assert.equal(store.recoverable('demo'), null, 'identical to the save: nothing to recover');
  store.writeAutosave('demo', edited);
  store.save('demo', edited, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'demo.studio.autosave.json')), 'a save clears the recovery copy');
  store.writeAutosave('demo', edited);
  store.clearAutosave('demo');
  assert.equal(store.readAutosave('demo'), null);
  fs.writeFileSync(path.join(dir, 'demo.studio.autosave.json'), '{corrupt');
  assert.throws(() => store.readAutosave('demo'), (e) => e.code === ERR.CORRUPT);
  assert.equal(code(() => store.writeAutosave('nope', sampleProject())), ERR.NOT_FOUND);
});

test('export gives one JSON bundle naming media by bare names and whether each is present; import makes a new project from it', () => {
  const { dir, store } = fresh();
  fs.rmSync(path.join(dir, 'demo.music.mp3'));
  const bundle = store.exportBundle('demo');
  assert.equal(bundle.format, BUNDLE_FORMAT);
  assert.deepEqual(bundle.media, [{ name: 'demo.music.mp3', present: false }, { name: 'demo.voice.opus', present: true }, { name: 'demo.webm', present: true }]);
  assert.ok(!JSON.stringify(bundle).includes(dir), 'no absolute path leaves the workspace');
  const sent = JSON.parse(JSON.stringify(bundle));
  const made = store.importBundle(sent);
  assert.equal(made.slug, 'demo-2', 'a name in use gets a suffix');
  assert.deepEqual(made.missing, ['demo.music.mp3']);
  assert.equal(made.project.rev, 1);
  assert.equal(store.importBundle(sent, { slug: 'chosen', name: 'Chosen name' }).project.name, 'Chosen name');
  assert.equal(code(() => store.importBundle(sent, { slug: 'chosen' })), ERR.EXISTS);
  assert.equal(code(() => store.importBundle(sent, { slug: '../up' })), ERR.BAD_SLUG);
});

test('import rejects ../ and absolute names in the media list or in a clip, and anything that is not a bundle', () => {
  const { dir, store } = fresh();
  const good = () => JSON.parse(JSON.stringify(store.exportBundle('demo')));
  for (const evil of ['../secret.webm', '/etc/passwd', 'a/b.webm', 'C:\\x.webm', '..', 'videos/x.webm', 'x.sh']) {
    const b1 = good();
    b1.media.push({ name: evil, present: true });
    assert.equal(code(() => store.importBundle(b1)), ERR.BAD_BUNDLE, `media ${evil}`);
    const b2 = good();
    b2.project.layers[0].clips[0].src = evil;
    assert.equal(code(() => store.importBundle(b2)), ERR.BAD_BUNDLE, `clip ${evil}`);
  }
  for (const junk of [null, 5, {}, { format: 'other', version: 1 }, { format: BUNDLE_FORMAT, version: 2 }, { ...good(), media: 'x' }, { ...good(), project: { version: 1 } }]) assert.equal(code(() => store.importBundle(junk)), ERR.BAD_BUNDLE);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.studio.json')), ['demo.studio.json'], 'nothing was written by the refused imports');
});

test('files are only ever read and written inside the workspace: a project file that is a link is refused, a rename target cannot be a path', () => {
  const { dir, store } = fresh();
  const outside = fs.realpathSync(makeTempDir('studio-editor-store-out-'));
  fs.writeFileSync(path.join(outside, 'x.studio.json'), JSON.stringify(sampleProject()));
  fs.symlinkSync(path.join(outside, 'x.studio.json'), path.join(dir, 'linked.studio.json'));
  assert.equal(code(() => store.load('linked')), ERR.CORRUPT, 'a linked project is refused');
  assert.equal(store.list().some((p) => p.slug === 'linked'), false, 'a link is not listed');
  store.save('demo', sampleProject(), 1);
  assert.deepEqual(fs.readdirSync(outside), ['x.studio.json']);
  assert.equal(code(() => store.rename('demo', '../../escape', 2)), ERR.BAD_SLUG);
  assert.equal(code(() => store.need('../../etc/passwd')), ERR.BAD_SLUG);
});
