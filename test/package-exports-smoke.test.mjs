// #698 -- packages/core exported only a handful of subpaths (`.`, `./plan`, `./validate`,
// `./summarize`, `./impact`, `./generate`) and packages/engine had NO package.json at all, so
// nothing in it could be imported by package name from outside this monorepo: a sibling tool
// (Trace/line-matcher) had to reach in via relative paths across a workspace boundary. This test
// proves the fix at the level that actually matters to that sibling tool: a real
// `import('@line/construct-core/<subpath>')` / `import('@line/construct-engine/<subpath>')` --
// package specifier, never a relative path -- resolves and returns the documented exports. The
// public/internal reasoning per module lives in docs/capabilities.md, "Public npm surface".
//
// What this test depends on and why it can't be a fully isolated fixture install (unlike
// test/typed-contracts-publish.test.mjs's npm-pack-and-install-in-a-tmpdir approach): most of the
// files exported here (unlike the self-contained typed-contracts/*.ts sources) import across the
// packages/core <-> packages/engine <-> packages/ast boundary with RELATIVE paths (`../core/...`,
// `../ast/...`) -- pre-existing structural debt (see docs/capabilities.md row 1) that #698 did not
// take on. Packing packages/engine alone into an isolated node_modules/@line/construct-engine and
// installing it with nothing else present would make every one of those relative imports resolve
// to a nonexistent node_modules/@line/core or node_modules/@line/ast and fail -- not because the
// exports map is wrong, but because the fixture is missing its siblings. So this test instead
// resolves through the REAL workspace linkage (node_modules/@line/construct-core and
// node_modules/@line/construct-engine symlinked next to their siblings), which is exactly the
// topology a real installed consumer gets from npm workspaces / `npm install`. In a fresh worktree
// that linkage does not exist by default and must be set up per docs/DELEGATION.md's "Setup in a
// fresh worktree" (including overlaying the `@line/*` entries onto the worktree's OWN packages/*,
// not the main checkout's) -- if the very first resolution check below fails, that setup is the
// first thing to check, not a regression in this change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PKG_DIRS = {
  '@line/construct-core': path.join(REPO_ROOT, 'packages', 'core'),
  '@line/construct-engine': path.join(REPO_ROOT, 'packages', 'engine'),
};

// The subpaths #698 adds, with a couple of representative named exports each -- enough to catch a
// typo'd filename in the exports map (resolves, but to the wrong module) or an export renamed out
// from under the map, without re-typing every export every one of these files has.
const NEW_SUBPATHS = {
  '@line/construct-core/llm': ['callLlm', 'PROVIDERS'],
  '@line/construct-core/text-diff': ['buildDiffView'],
  '@line/construct-core/diagnostics': ['ConstructError', 'EXIT_CODES'],
  '@line/construct-core/dir-browser': ['listDirectories', 'DirBrowseError'],
  '@line/construct-core/file-change-tracker': ['createChangeTracker'],

  '@line/construct-engine/impact': ['analyzeImpact', 'impactFromChangedFiles'],
  '@line/construct-engine/transactional-writer': ['createTransaction'],
  '@line/construct-engine/envelope': ['createEnvelope', 'validateEnvelope'],
  '@line/construct-engine/pipeline': ['runPipeline'],
  '@line/construct-engine/workflow-generator': ['eventsToEnvelope', 'parseTypeString'],
  '@line/construct-engine/controller-binder': ['extractPropsInterfaceMembers'],
  '@line/construct-engine/page-transformer': ['transformPristineSource'],
  '@line/construct-engine/default-enforcers': ['DEFAULT_ENFORCERS'],
  '@line/construct-engine/workflow-narrator': ['humanize', 'stateLabel'],
  '@line/construct-engine/workflow-scenarios': ['graphOf'],
  '@line/construct-engine/workflow-explain': ['explainMachine'],
  '@line/construct-engine/workflow-source': ['workflowsDirOf', 'readWorkflowSource'],
  '@line/construct-engine/workflow-editor': ['editWorkflow'],
  '@line/construct-engine/workflow-context': ['setupObjectOf'],
  '@line/construct-engine/unit-summary': ['SCHEMA_VERSION', 'DETAILS'],
  '@line/construct-engine/scope-links': ['importOfTag'],
  '@line/construct-engine/jsx-source-annotator': ['annotateJsxSource', 'CX_SRC_ATTR'],
  '@line/construct-engine/preview-bridge': ['installPreviewBridge', 'PREVIEW_MESSAGE_TYPE'],
  '@line/construct-engine/preview-vite-plugin': ['constructPreview'],
  '@line/construct-engine/process-machine': ['PROCESS_STATES'],
  '@line/construct-engine/process-model': ['PROCESS_VERSION'],
  '@line/construct-engine/process-store': ['resolveStateDir'],
  '@line/construct-engine/process-engine': ['createProcessEngine'],
  '@line/construct-engine/commit-message': ['SCHEMA_VERSION', 'SERIAL_DIGITS'],
  '@line/construct-engine/pr-health': ['SCHEMA_VERSION', 'FLOW_SCENARIO_MAX'],
  '@line/construct-engine/git-trees': ['resolveCommit', 'changedFiles'],
};

function readPkgJson(pkgName) {
  return JSON.parse(fs.readFileSync(path.join(PKG_DIRS[pkgName], 'package.json'), 'utf8'));
}

function pkgNameOf(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function subpathOf(specifier) {
  const name = pkgNameOf(specifier);
  return `.${specifier.slice(name.length)}`;
}

/** Real `npm pack --dry-run --json` -- no tarball written, no install, no network. */
function packDryRun(dir) {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 0, `npm pack --dry-run failed in ${dir}:\n${res.stderr}`);
  const [{ files }] = JSON.parse(res.stdout);
  return files.map((f) => f.path);
}

test('every new subpath in packages/{core,engine}/package.json exports points at a file that exists', () => {
  for (const specifier of Object.keys(NEW_SUBPATHS)) {
    const pkgName = pkgNameOf(specifier);
    const pkg = readPkgJson(pkgName);
    const entry = pkg.exports[subpathOf(specifier)];
    assert.ok(entry, `${pkgName}'s exports map should have an entry for ${subpathOf(specifier)}`);
    const target = typeof entry === 'string' ? entry : entry.default || entry.import;
    assert.ok(fs.existsSync(path.join(PKG_DIRS[pkgName], target)), `${target} (for ${specifier}) should exist on disk`);
  }
});

test('npm pack --dry-run ships every file the new subpaths point at', () => {
  const packed = { '@line/construct-core': packDryRun(PKG_DIRS['@line/construct-core']), '@line/construct-engine': packDryRun(PKG_DIRS['@line/construct-engine']) };
  for (const specifier of Object.keys(NEW_SUBPATHS)) {
    const pkgName = pkgNameOf(specifier);
    const pkg = readPkgJson(pkgName);
    const entry = pkg.exports[subpathOf(specifier)];
    const target = (typeof entry === 'string' ? entry : entry.default || entry.import).replace(/^\.\//, '');
    assert.ok(packed[pkgName].includes(target), `${target} (for ${specifier}) should be in ${pkgName}'s packed file list, not just present on disk`);
  }
  // packages/engine's units/ directory is internal (no subpath of its own -- see
  // docs/capabilities.md, "Public npm surface") but unitSummary.mjs needs it at runtime.
  assert.ok(packed['@line/construct-engine'].some((f) => f.startsWith('units/')), "packages/engine's packed files should include units/ (unitSummary.mjs's internal composition)");
});

test('packages/{core,engine} resolve by package name in this workspace (not just relative paths)', () => {
  let resolvedRoot;
  try {
    resolvedRoot = fileURLToPath(import.meta.resolve('@line/construct-core/package.json'));
  } catch (e) {
    assert.fail(`@line/construct-core did not resolve at all -- this worktree's node_modules/@line/construct-core link is missing or points elsewhere. See docs/DELEGATION.md, "Setup in a fresh worktree" (the @line/* overlay step). Original error: ${e.message}`);
  }
  assert.equal(
    fs.realpathSync(resolvedRoot),
    fs.realpathSync(path.join(PKG_DIRS['@line/construct-core'], 'package.json')),
    "@line/construct-core resolved to a DIFFERENT copy than this worktree's own packages/core -- almost certainly the main checkout's node_modules/@line/construct-core (docs/DELEGATION.md warns this is the default). Overlay node_modules/@line/construct-core onto this worktree's packages/core before trusting this test.",
  );
});

for (const [specifier, expectedExports] of Object.entries(NEW_SUBPATHS)) {
  test(`${specifier} imports by package name and exposes ${expectedExports.join(', ')}`, async () => {
    const resolvedUrl = import.meta.resolve(specifier);
    assert.match(resolvedUrl, /^file:\/\//, `${specifier} should resolve to a real file`);
    const mod = await import(specifier);
    for (const name of expectedExports) {
      assert.ok(name in mod, `${specifier} should export ${name}, got: ${Object.keys(mod).join(', ')}`);
    }
  });
}
