// #470 -- expectedFiles() must name exactly the files the real generators write. The test runs the real generators in a
// throwaway project and compares, so a template or path change that drifts from the derivation fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFeature, generateLayer, generateVertical } from '../packages/core/generators.mjs';
import { expectedFiles, DERIVED_FLOWS } from '../packages/core/plan-touches.mjs';
import { PLAN_FLOWS } from '../packages/core/plan.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

const tree = (root) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};
const paths = (list) => list.map((f) => f.path).sort();
const added = (root, before) => tree(root).filter((f) => !before.includes(f));

test('create.feature: derives exactly the files createFeature writes', () => {
  const root = makeTempDir('og470-');
  const before = tree(root);
  const want = expectedFiles(root, 'create.feature', { name: 'wishlist' });
  createFeature(root, 'wishlist');
  assert.deepEqual(paths(want), added(root, before));
  assert.ok(want.every((f) => f.change === 'create'));
});

test('create.unit: derives exactly the file generateLayer writes, for every layer', () => {
  const root = makeTempDir('og470-');
  createFeature(root, 'wishlist');
  for (const layer of ['domain', 'service', 'workflow', 'hook', 'component', 'page']) {
    const before = tree(root);
    const want = expectedFiles(root, 'create.unit', { layer, name: 'itemRules', feature: 'wishlist' });
    generateLayer(root, layer, 'itemRules', 'wishlist');
    assert.deepEqual(paths(want), added(root, before), layer);
    assert.equal(want[0].layer, layer);
  }
});

test('create.layer: derives the files generateVertical writes, in any listed order, as a list or a comma string', () => {
  const root = makeTempDir('og470-');
  createFeature(root, 'wishlist');
  const before = tree(root);
  const want = expectedFiles(root, 'create.layer', { name: 'cart', feature: 'wishlist', layers: 'page, domain,service' });
  generateVertical(root, 'cart', 'wishlist', ['page', 'domain', 'service']);
  assert.deepEqual(paths(want), added(root, before));
  assert.deepEqual(want.map((f) => f.layer), ['domain', 'service', 'page'], 'canonical layer order, like the generator');
  assert.deepEqual(expectedFiles(root, 'create.layer', { name: 'cart', feature: 'wishlist', layers: ['service', 'domain', 'page'] }), want);
});

// #677 -- a feature that doesn't exist yet is scaffolded first (generators.mjs's ensureFeatureExists), so the
// plan preview must declare its types.ts/index.ts too, or the approval gate would refuse a file the step is
// actually about to write.
test('#677: create.unit derives the feature\'s types.ts/index.ts too when the feature does not exist yet', () => {
  const root = makeTempDir('og677-');
  const before = tree(root);
  const want = expectedFiles(root, 'create.unit', { layer: 'domain', name: 'itemRules', feature: 'wishlist' });
  generateLayer(root, 'domain', 'itemRules', 'wishlist');
  assert.deepEqual(paths(want), added(root, before));
  assert.ok(want.some((f) => f.path === 'features/wishlist/types.ts' && f.change === 'create'));
  assert.ok(want.some((f) => f.path === 'features/wishlist/index.ts' && f.change === 'create'));
});

test('#677: create.layer derives the feature\'s types.ts/index.ts too when the feature does not exist yet', () => {
  const root = makeTempDir('og677-');
  const before = tree(root);
  const want = expectedFiles(root, 'create.layer', { name: 'cart', feature: 'wishlist', layers: 'domain,service' });
  generateVertical(root, 'cart', 'wishlist', ['domain', 'service']);
  assert.deepEqual(paths(want), added(root, before));
  assert.ok(want.some((f) => f.path === 'features/wishlist/types.ts' && f.change === 'create'));
  assert.ok(want.some((f) => f.path === 'features/wishlist/index.ts' && f.change === 'create'));
});

test('#677: an already-existing feature is not re-declared (nothing new to create)', () => {
  const root = makeTempDir('og677-');
  createFeature(root, 'wishlist');
  const want = expectedFiles(root, 'create.unit', { layer: 'domain', name: 'itemRules', feature: 'wishlist' });
  assert.equal(want.length, 1);
  assert.equal(want[0].path, 'features/wishlist/domain/ItemRules.tsx');
});

test('the features folder comes from architecture.yml', () => {
  const root = makeTempDir('og470-');
  fs.writeFileSync(path.join(root, 'architecture.yml'), 'features:\n  root: src/features\n');
  // Feature created ahead of time, so this test stays about the custom root, independent of #677's
  // missing-feature prepend (covered separately above).
  createFeature(root, 'billing');
  const before = tree(root);
  const want = expectedFiles(root, 'create.unit', { layer: 'domain', name: 'x', feature: 'billing' });
  assert.equal(want[0].path, 'src/features/billing/domain/X.tsx');
  generateLayer(root, 'domain', 'x', 'billing');
  assert.ok(added(root, before).includes(want[0].path));
});

test('an incomplete or illegal step derives nothing (null), never a guess; other flows are not derived', () => {
  const root = makeTempDir('og470-');
  assert.equal(expectedFiles(root, 'create.unit', { layer: 'domain', name: 'x' }), null, 'no feature yet');
  assert.equal(expectedFiles(root, 'create.unit', { layer: 'nope', name: 'x', feature: 'f' }), null);
  assert.equal(expectedFiles(root, 'create.layer', { name: 'x', feature: 'f', layers: '' }), null);
  assert.equal(expectedFiles(root, 'create.layer', { name: 'x', feature: 'f', layers: 'domain,bogus' }), null);
  assert.equal(expectedFiles(root, 'create.feature', { name: '   ' }), null);
  assert.equal(expectedFiles(root, 'create.feature', { name: '1 bad name!' }), null, 'the generator would refuse it, so nothing is declared');
  assert.equal(expectedFiles(root, 'refactor.move', { name: 'x', feature: 'f', from: 'domain', to: 'service' }), null);
  assert.equal(expectedFiles(root, 'summarize.list', {}), null);
  for (const id of DERIVED_FLOWS) assert.ok(PLAN_FLOWS[id]?.writes, `${id} is a real writing flow`);
});
