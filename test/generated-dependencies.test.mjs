// #678 -- the one deterministic check every generator that can emit a bare import runs after writing its files:
// "generated imports ⊆ declared dependencies". Unit-level coverage for the pure pieces (bareImportPackages,
// missingGeneratedDependencies, ensureGeneratedDependencies); the CLI wiring (--shape adding @line/construct-core
// for real) is covered end to end in test/shapes.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bareImportPackages, ensureGeneratedDependencies, KNOWN_GENERATED_DEPENDENCIES, missingGeneratedDependencies } from '../packages/core/generated-dependencies.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const writePkg = (dir, pkg) => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
const writeFile = (dir, name, content) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

test('bareImportPackages: only non-relative, non-node: specifiers, subpaths collapsed to the package root', () => {
  const source = [
    "import { defineDomain } from '@line/construct-core/typed-contracts';",
    "import { setup } from 'xstate';",
    "import fs from 'node:fs';",
    "import local from './sibling.ts';",
    "import abs from '/etc/passwd';",
    "import 'side-effect-pkg';",
  ].join('\n');
  assert.deepEqual([...bareImportPackages(source)].sort(), ['@line/construct-core', 'side-effect-pkg', 'xstate']);
});

test('missingGeneratedDependencies: null with no package.json, else exactly the undeclared bare imports, sorted', () => {
  const dir = makeTempDir('construct-gendeps-');
  const file = writeFile(dir, 'unit.ts', "import { defineDomain } from '@line/construct-core/typed-contracts';\nimport { setup } from 'xstate';\n");
  assert.equal(missingGeneratedDependencies(dir, [file]), null, 'no package.json to check against');

  writePkg(dir, { name: 'p', dependencies: { xstate: '^5.0.0' } });
  assert.deepEqual(missingGeneratedDependencies(dir, [file]), ['@line/construct-core'], 'xstate is already declared, so only the other one is missing');

  writePkg(dir, { name: 'p', dependencies: { xstate: '^5.0.0', '@line/construct-core': '^0.9.0' } });
  assert.deepEqual(missingGeneratedDependencies(dir, [file]), [], 'both declared: nothing missing');
});

test('ensureGeneratedDependencies: adds a known "dependencies" package through addDependency, leaves an already-present one alone', () => {
  const dir = makeTempDir('construct-gendeps-');
  writePkg(dir, { name: 'p', version: '1.0.0', dependencies: { react: '^19.0.0' } });
  const file = writeFile(dir, 'unit.ts', "import { defineDomain } from '@line/construct-core/typed-contracts';\n");

  const first = ensureGeneratedDependencies(dir, [file]);
  assert.equal(first.notes.length, 0);
  assert.equal(first.added.length, 1);
  assert.equal(first.added[0].name, '@line/construct-core');
  assert.match(first.added[0].line, /^"@line\/construct-core": "\^\d+\.\d+\.\d+"$/);

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['@line/construct-core'], 'the line was actually written to package.json');
  assert.equal(pkg.dependencies.react, '^19.0.0', 'an already-present dependency is untouched');

  // Idempotent: a second call finds it already declared, so nothing changes and nothing is reported as added.
  const second = ensureGeneratedDependencies(dir, [file]);
  assert.deepEqual(second, { added: [], notes: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), pkg, 'package.json is byte-for-byte the same shape (same deps)');
});

test('ensureGeneratedDependencies: a dev-only known package (e.g. @playwright/test) is reported as a note, never written into "dependencies"', () => {
  const dir = makeTempDir('construct-gendeps-');
  writePkg(dir, { name: 'p', dependencies: {} });
  const file = writeFile(dir, 'spec.ts', "import { test, expect } from '@playwright/test';\n");
  const { added, notes } = ensureGeneratedDependencies(dir, [file]);
  assert.deepEqual(added, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /@playwright\/test/);
  assert.match(notes[0], /npm install -D/);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@playwright/test'], undefined, 'never silently placed into "dependencies"');
});

test('ensureGeneratedDependencies: an unknown bare import is reported, never guessed at with a made-up version', () => {
  const dir = makeTempDir('construct-gendeps-');
  writePkg(dir, { name: 'p', dependencies: {} });
  const file = writeFile(dir, 'unit.ts', "import { widget } from 'some-random-package';\n");
  const { added, notes } = ensureGeneratedDependencies(dir, [file]);
  assert.deepEqual(added, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /some-random-package/);
});

test('ensureGeneratedDependencies: no package.json at all is reported, not thrown', () => {
  const dir = makeTempDir('construct-gendeps-');
  const file = writeFile(dir, 'unit.ts', "import { defineDomain } from '@line/construct-core/typed-contracts';\n");
  const { added, notes } = ensureGeneratedDependencies(dir, [file]);
  assert.deepEqual(added, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /no readable package\.json/);
});

test('the known registry only auto-writes "dependencies" packages; every "devDependencies" entry is reported, never added', () => {
  const dependenciesSection = Object.entries(KNOWN_GENERATED_DEPENDENCIES).filter(([, v]) => v.section === 'dependencies').map(([k]) => k);
  const devSection = Object.entries(KNOWN_GENERATED_DEPENDENCIES).filter(([, v]) => v.section === 'devDependencies').map(([k]) => k);
  assert.deepEqual(dependenciesSection.sort(), ['@line/construct-core', 'xstate', 'zod'].sort());
  assert.deepEqual(devSection.sort(), ['@playwright/test', '@xstate/graph'].sort());
});
