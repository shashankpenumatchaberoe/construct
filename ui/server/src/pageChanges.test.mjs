import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describePageChange, adoptOwnWrite } from './pageChanges.mjs';
import { createChangeTracker } from '../../../packages/core/file-change-tracker.mjs';
import { makeTempDir } from '../../../test-utils/tmpdir.mjs';

test('external write is reported with a diff; own write is not', () => {
  const dir = makeTempDir('page-changes-');
  const abs = path.join(dir, 'P.tsx');
  const tracker = createChangeTracker();
  fs.writeFileSync(abs, 'a\nb\n');
  assert.equal(describePageChange(abs, tracker).change, null);
  fs.writeFileSync(abs, 'a\nB\n');
  const { change } = describePageChange(abs, tracker);
  assert.deepEqual(change.stats, { added: 1, removed: 1 });
  assert.ok(change.rows.some((r) => r.kind === 'added' && r.text === 'B'));
  // still reported on the next poll until dismissed
  assert.ok(describePageChange(abs, tracker).change);
  // the editor's own save clears it and is not re-reported
  fs.writeFileSync(abs, 'a\nC\n');
  adoptOwnWrite(abs, 'a\nC\n', tracker);
  assert.equal(describePageChange(abs, tracker).change, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// #538: two different projects can scaffold the same relative page path (both "auth/pages/LoginPage.tsx").
// The tracker must key by absPath, or opening project B's copy first is compared against a baseline left
// behind by project A's — a false "external change" the moment the tree loads, not a real edit by anyone.
test('same-name file in a different project does not collide with a stale baseline', () => {
  const dirA = makeTempDir('page-changes-a-');
  const dirB = makeTempDir('page-changes-b-');
  const absA = path.join(dirA, 'LoginPage.tsx');
  const absB = path.join(dirB, 'LoginPage.tsx');
  const tracker = createChangeTracker();

  fs.writeFileSync(absA, 'export default function LoginPage() { return null; }\n');
  assert.equal(describePageChange(absA, tracker).change, null); // project A's baseline

  fs.writeFileSync(absB, 'export default function LoginPage({ title }) { return title; }\n');
  assert.equal(describePageChange(absB, tracker).change, null); // project B's own baseline, unrelated to A's content

  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});
