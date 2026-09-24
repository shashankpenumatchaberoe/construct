// @line/studio packaging: package.json shape, the vendoring of packages/tools/media, escape detection, the files whitelist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';
import { DEFAULT_SOURCE, PACKAGE_ROOT, PackError, declaredDependencies, listVendorable, scanFile, vendorMedia } from '../scripts/pack.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, '..', '..', 'package.json'), 'utf8'));
const cliPkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, '..', 'cli', 'package.json'), 'utf8'));
const write = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };

test('package.json: name, version, bin, engines, private registry, dependencies', () => {
  assert.equal(pkg.name, '@line/studio');
  assert.equal(pkg.version, rootPkg.version, 'versioned with the repository');
  assert.equal(pkg.version, cliPkg.version, 'versioned like packages/cli');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.bin, { studio: './bin/studio.mjs' });
  assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'bin', 'studio.mjs')));
  assert.equal(pkg.engines.node, '>=20');
  assert.deepEqual(pkg.publishConfig, cliPkg.publishConfig, 'same private registry and restricted access as @line/construct');
  assert.equal(pkg.publishConfig.registry, 'https://npm.pkg.github.com');
  assert.equal(pkg.publishConfig.access, 'restricted');
  assert.equal(pkg.private, undefined, 'must be publishable to the private registry');
  assert.ok(pkg.dependencies.playwright && pkg.dependencies.subtitle);
  assert.equal(pkg.devDependencies, undefined, 'a packed tool has no dev dependencies');
  assert.equal(pkg.scripts.pack, 'node scripts/pack.mjs');
  assert.match(pkg.scripts.prepack, /pack\.mjs --vendor-only/, 'a bare `npm pack` vendors first');
  for (const f of ['README.md', 'LICENSE']) assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, f)), f);
});

test('the dependencies are exactly the bare packages the vendored media tools import (plus playwright for recording)', () => {
  const imported = new Set();
  for (const f of listVendorable(DEFAULT_SOURCE).filter((x) => x.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(DEFAULT_SOURCE, f), 'utf8');
    for (const m of text.matchAll(/^import\s[^'"]*?['"]([^'"./][^'"]*)['"]/gm)) if (!m[1].startsWith('node:')) imported.add(m[1]);
  }
  assert.deepEqual([...imported], ['subtitle']);
  for (const d of imported) assert.ok(declaredDependencies().has(d), `${d} declared`);
});

test('files whitelist: only bin, src, vendor, README and LICENSE ship; `npm pack --dry-run` lists the vendored media and nothing else', () => {
  assert.deepEqual(pkg.files, ['bin', 'src', 'vendor', 'README.md', 'LICENSE']);
  const v = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'pack.mjs'), '--vendor-only'], { encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const packed = JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();
  for (const p of packed) assert.match(p, /^(bin\/|src\/|vendor\/media\/|README\.md$|LICENSE$|package\.json$)/, `unexpected file in the tarball: ${p}`);
  assert.ok(!packed.some((p) => /node_modules|\.media-cache|\.tgz$|^test\/|^scripts\/|__pycache__/.test(p)));
  for (const f of ['bin/studio.mjs', 'bin/cli.mjs', 'bin/doctor.mjs', 'package.json', 'README.md', 'LICENSE']) assert.ok(packed.includes(f), f);
  for (const f of listVendorable(DEFAULT_SOURCE)) assert.ok(packed.includes(`vendor/media/${f}`), `vendor/media/${f} ships`);
});

test('vendorMedia copies *.mjs/*.sh/*.py, skips node_modules, caches and tests, keeps the exec bit and leaves the source untouched', () => {
  const src = makeTempDir('studio-src-');
  const out = makeTempDir('studio-vendor-');
  write(src, 'a.mjs', "import fs from 'node:fs';\nexport const x = fs;\n");
  const sh = write(src, 'run.sh', '#!/usr/bin/env bash\necho hi\n');
  fs.chmodSync(sh, 0o755);
  write(src, 'h.py', 'print(1)\n');
  write(src, 'notes.md', 'no');
  write(src, 'data.json', '{}');
  write(src, 'node_modules/dep/index.mjs', 'export {}');
  write(src, '__pycache__/h.py', 'x');
  write(src, '.cache/c.mjs', 'export {}');
  write(src, 'test/t.mjs', 'export {}');
  const files = vendorMedia({ sourceDir: src, vendorDir: out, allowedDeps: new Set() });
  assert.deepEqual(files, ['a.mjs', 'h.py', 'run.sh']);
  assert.deepEqual(fs.readdirSync(path.join(out, 'media')).sort(), ['a.mjs', 'h.py', 'run.sh']);
  assert.equal(fs.statSync(path.join(out, 'media', 'run.sh')).mode & 0o111, 0o111, 'exec bit kept');
  assert.equal(fs.readFileSync(path.join(out, 'media', 'a.mjs'), 'utf8'), fs.readFileSync(path.join(src, 'a.mjs'), 'utf8'), 'copied byte for byte');
  assert.ok(fs.existsSync(path.join(src, 'a.mjs')), 'a copy, never a move');
  vendorMedia({ sourceDir: src, vendorDir: out, allowedDeps: new Set() }); // idempotent: a second run replaces the copy
});

test('the real packages/tools/media vendors clean and stays where it is', () => {
  const out = makeTempDir('studio-real-');
  const before = listVendorable(DEFAULT_SOURCE);
  assert.ok(before.length >= 12 && before.includes('lib.mjs') && before.includes('add-audio.sh') && before.includes('clone_voice.py'));
  assert.deepEqual(vendorMedia({ vendorDir: out }), before);
  assert.deepEqual(listVendorable(DEFAULT_SOURCE), before);
});

test('escape detection: a planted import outside vendor/ fails the pack and leaves no vendored copy', () => {
  const src = makeTempDir('studio-bad-src-');
  const out = makeTempDir('studio-bad-out-');
  write(src, 'ok.mjs', "export const ok = 1;\n");
  write(src, 'bad.mjs', "import { thing } from '../../core/index.mjs';\nexport default thing;\n");
  assert.throws(() => vendorMedia({ sourceDir: src, vendorDir: out, allowedDeps: new Set() }), (e) => e instanceof PackError && /bad\.mjs:1: imports "\.\.\/\.\.\/core\/index\.mjs", outside vendor\//.test(e.message));
  assert.equal(fs.existsSync(path.join(out, 'media')), false);
  // the same through the command line: non-zero exit, the reason on stderr
  const r = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'scripts', 'pack.mjs'), '--vendor-only', '--source', src, '--vendor', out], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not self-contained/);
});

test('escape detection: undeclared packages, absolute paths, dynamic imports and ../../ path constructions', () => {
  const dir = makeTempDir('studio-scan-');
  const vendorRoot = dir;
  const allowedDeps = new Set(['subtitle']);
  const scan = (rel, text) => scanFile(write(dir, rel, text), { vendorRoot, allowedDeps });
  assert.deepEqual(scan('media/fine.mjs', "import { stringifySync } from 'subtitle';\nimport fs from 'node:fs';\nimport path from 'path';\nimport { a } from './sibling.mjs';\nimport { b } from '../other/b.mjs';\nconst up = path.resolve(HERE, '..');\nconst args = [...rest, 'loading...'];\n"), []);
  assert.match(scan('media/dep.mjs', "import lodash from 'lodash';\n")[0], /"lodash", not a declared dependency/);
  assert.match(scan('media/scoped.mjs', "import x from '@scope/pkg/sub';\n")[0], /"@scope\/pkg\/sub", not a declared dependency/);
  assert.match(scan('media/abs.mjs', "import x from '/etc/x.mjs';\n")[0], /absolute path or URL/);
  assert.match(scan('media/dyn.mjs', "const m = await import('../../x.mjs');\n")[0], /outside vendor\//);
  assert.match(scan('media/req.mjs', "const m = require('left-pad');\n")[0], /left-pad/);
  assert.match(scan('media/exp.mjs', "export { y } from '../../y.mjs';\n")[0], /outside vendor\//);
  assert.match(scan('media/repo.mjs', "export const REPO = path.resolve(HERE, '..', '..', '..');\n")[0], /climbs 3 directories up/);
  assert.match(scan('media/str.mjs', "const p = path.join(HERE, '../../site');\n")[0], /climbs 2 directories up/);
  assert.match(scan('media/run.sh', 'cat "$(dirname "$0")/../../x"\n')[0], /climbs 2 directories up/);
  assert.deepEqual(scan('media/optout.mjs', "export const REPO = path.resolve(HERE, '..', '..', '..'); // studio-pack: escape-ok (STUDIO_ROOT replaces it)\n"), []);
  assert.deepEqual(scan('media/comment.mjs', "// import x from '../../nope.mjs';  path.resolve(HERE, '..', '..', '..')\nexport {};\n"), []);
  assert.equal(scan('a/b/deep.mjs', "const p = path.join(HERE, '..', '..');\n").length, 0, 'inside vendor/ from two levels down');
  assert.equal(scan('a/b/deep2.mjs', "const p = path.join(HERE, '..', '..', '..');\n").length, 1, 'one more than the depth escapes');
});

test('the marker in packages/tools/media/lib.mjs is the only escape, and removing it fails the pack (the check sees the real file)', () => {
  const src = makeTempDir('studio-lib-src-');
  const out = makeTempDir('studio-lib-out-');
  const lib = fs.readFileSync(path.join(DEFAULT_SOURCE, 'lib.mjs'), 'utf8');
  assert.match(lib, /studio-pack: escape-ok/);
  fs.writeFileSync(path.join(src, 'lib.mjs'), lib.replace(' // studio-pack: escape-ok (repo checkout only; STUDIO_ROOT replaces it)', ''));
  assert.throws(() => vendorMedia({ sourceDir: src, vendorDir: out, allowedDeps: new Set(['subtitle']) }), /lib\.mjs:\d+: climbs 3 directories up/);
});

test('packages/tools/media honours STUDIO_ROOT and STUDIO_VIDEO_DIR, so a vendored copy never derives paths from its own location', () => {
  const ws = makeTempDir('studio-ws-');
  const code = "import('" + new URL('../../tools/media/lib.mjs', import.meta.url).href + "').then((m) => console.log(JSON.stringify({ REPO: m.REPO, VIDEO_DIR: m.VIDEO_DIR, CLIP_CACHE: m.CLIP_CACHE })))";
  const run = (env) => JSON.parse(spawnSync(process.execPath, ['-e', code], { env: { ...process.env, STUDIO_ROOT: '', STUDIO_VIDEO_DIR: '', ...env }, encoding: 'utf8' }).stdout);
  const inRepo = run({});
  assert.equal(inRepo.VIDEO_DIR, path.join(inRepo.REPO, 'site', 'assets', 'video'), 'unset: the repo layout, unchanged');
  assert.equal(inRepo.REPO, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
  const packed = run({ STUDIO_ROOT: ws, STUDIO_VIDEO_DIR: path.join(ws, 'videos') });
  assert.deepEqual(packed, { REPO: ws, VIDEO_DIR: path.join(ws, 'videos'), CLIP_CACHE: path.join(ws, '.media-cache') });
});
