import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, findProjectRoot, DEFAULT_RULES, DEFAULT_LAYERS, REACT_SPA_LAYERS, FRAMEWORKS, normalizeFramework, layersForFramework, DATA_LAYER_PROVIDERS, normalizeDataLayerProvider, normalizeLayers } from '../packages/core/config.mjs';
import { ConstructError, EXIT_CODES } from '../packages/core/diagnostics.mjs';
import { makeTempDir } from '../test-utils/tmpdir.mjs';

function tmpProject() {
  return makeTempDir('construct-config-');
}

test('loadConfig returns defaults when architecture.yml is absent', () => {
  const dir = tmpProject();
  const config = loadConfig(dir);
  assert.equal(config.version, 1);
  assert.equal(config.preset, 'strict-nextjs');
  assert.deepEqual(config.rules, DEFAULT_RULES);
  assert.deepEqual(config.exceptions, []);
  // No architecture.yml at all still normalizes to the nextjs default —
  // full backward compatibility for every project that predates `framework`.
  assert.equal(config.project.framework, 'nextjs');
  assert.deepEqual(config.layers, DEFAULT_LAYERS);
});

test('loadConfig defaults project.framework to nextjs when architecture.yml has no project section', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules: {}\n');
  const config = loadConfig(dir);
  assert.equal(config.project.framework, 'nextjs');
  assert.deepEqual(config.layers, DEFAULT_LAYERS);
});

test('loadConfig reads and normalizes project.framework: react-spa', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'project:\n  framework: react-spa\n');
  const config = loadConfig(dir);
  assert.equal(config.project.framework, 'react-spa');
  assert.deepEqual(config.layers, REACT_SPA_LAYERS);
  assert.equal(config.layers.route.pattern, 'src/App.tsx');
  // Everything else in the layer graph is unchanged from the nextjs shape.
  assert.deepEqual(config.layers.controller, DEFAULT_LAYERS.controller);
});

// #699 -- loadConfig used to unconditionally overwrite `layers` with layersForFramework(framework),
// so a project's own `layers:` block in architecture.yml had NO effect on the config it actually
// got back (only loadLayerGraph, used by the enforcer, ever merged it). These pin down the fix:
// loadConfig's `layers` must reflect the override, exactly like loadLayerGraph's does.
test('loadConfig merges a `layers:` override into config.layers instead of discarding it', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'architecture.yml'),
    'layers:\n  service:\n    pattern: "features/*/service/**"\n',
  );
  const config = loadConfig(dir);
  assert.equal(config.layers.service.pattern, 'features/*/service/**');
  // canImport wasn't touched by the override, so it must still be the framework default.
  assert.deepEqual(config.layers.service.canImport, DEFAULT_LAYERS.service.canImport);
  // Every other layer is untouched.
  assert.deepEqual(config.layers.controller, DEFAULT_LAYERS.controller);
});

test('loadConfig\'s `layers:` override extends canImport additively via addCanImport, same as loadLayerGraph', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'architecture.yml'),
    'layers:\n  component:\n    addCanImport: [domain]\n',
  );
  const config = loadConfig(dir);
  assert.ok(config.layers.component.canImport.includes('domain'));
  assert.ok(config.layers.component.canImport.includes('component')); // original edges preserved
});

test('loadConfig rejects a non-mapping `layers:` value with a diagnostic naming the field', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'layers: "not-a-mapping"\n');
  assert.throws(
    () => loadConfig(dir),
    (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /layers/);
      return true;
    },
  );
});

test('loadConfig rejects a `layers:` override whose canImport edge points at a nonexistent layer', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'architecture.yml'),
    'layers:\n  service:\n    canImport: [nonexistent]\n',
  );
  assert.throws(
    () => loadConfig(dir),
    (err) => {
      assert.ok(err instanceof ConstructError);
      assert.match(err.message, /service -> nonexistent/);
      return true;
    },
  );
});

test('normalizeLayers returns the framework base unchanged when `layers:` is absent', () => {
  assert.deepEqual(normalizeLayers(undefined, 'nextjs'), DEFAULT_LAYERS);
  assert.deepEqual(normalizeLayers(null, 'react-spa'), REACT_SPA_LAYERS);
});

test('loadConfig throws a ConstructError with a clear message for an unknown framework', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'project:\n  framework: sveltekit\n');
  assert.throws(
    () => loadConfig(dir),
    (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /Unknown project\.framework 'sveltekit'/);
      assert.match(err.message, /nextjs, react-spa/);
      return true;
    },
  );
});

test('normalizeFramework defaults undefined/null to nextjs and validates against FRAMEWORKS', () => {
  assert.equal(normalizeFramework(undefined), 'nextjs');
  assert.equal(normalizeFramework(null), 'nextjs');
  assert.equal(normalizeFramework('react-spa'), 'react-spa');
  assert.deepEqual(FRAMEWORKS, ['nextjs', 'react-spa']);
  assert.throws(() => normalizeFramework('remix'), ConstructError);
});

// Ticket 7.5 — project.dataLayer.provider (mirrors the framework tests above).

test('loadConfig defaults project.dataLayer.provider to fetchBaseQuery when unset', () => {
  const dir = tmpProject();
  const config = loadConfig(dir);
  assert.equal(config.project.dataLayer.provider, 'fetchBaseQuery');
});

test('loadConfig defaults project.dataLayer.provider to fetchBaseQuery when architecture.yml is absent', () => {
  const dir = tmpProject();
  const config = loadConfig(dir);
  assert.equal(config.project.dataLayer.provider, 'fetchBaseQuery');
});

test('loadConfig reads and normalizes project.dataLayer.provider: axios', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'project:\n  dataLayer:\n    provider: axios\n');
  const config = loadConfig(dir);
  assert.equal(config.project.dataLayer.provider, 'axios');
});

test('loadConfig reads and normalizes project.dataLayer.provider: mock', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'project:\n  dataLayer:\n    provider: mock\n');
  const config = loadConfig(dir);
  assert.equal(config.project.dataLayer.provider, 'mock');
});

test('loadConfig throws a ConstructError with a clear message for an unknown dataLayer.provider', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'project:\n  dataLayer:\n    provider: graphql\n');
  assert.throws(
    () => loadConfig(dir),
    (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /Unknown project\.dataLayer\.provider 'graphql'/);
      assert.match(err.message, /fetchBaseQuery, axios, mock/);
      return true;
    },
  );
});

test('normalizeDataLayerProvider defaults undefined/null to fetchBaseQuery and validates against DATA_LAYER_PROVIDERS', () => {
  assert.equal(normalizeDataLayerProvider(undefined), 'fetchBaseQuery');
  assert.equal(normalizeDataLayerProvider(null), 'fetchBaseQuery');
  assert.equal(normalizeDataLayerProvider('axios'), 'axios');
  assert.equal(normalizeDataLayerProvider('mock'), 'mock');
  assert.deepEqual(DATA_LAYER_PROVIDERS, ['fetchBaseQuery', 'axios', 'mock']);
  assert.throws(() => normalizeDataLayerProvider('graphql'), ConstructError);
});

test('layersForFramework returns the react-spa route pattern with everything else identical to DEFAULT_LAYERS', () => {
  const layers = layersForFramework('react-spa');
  assert.equal(layers.route.pattern, 'src/App.tsx');
  assert.deepEqual(layers.route.canImport, DEFAULT_LAYERS.route.canImport);
  for (const layer of ['controller', 'workflow', 'hook', 'service', 'domain', 'page', 'component', 'expression']) {
    assert.deepEqual(layers[layer], DEFAULT_LAYERS[layer]);
  }
});

test('layersForFramework falls back to DEFAULT_LAYERS for nextjs (and unrecognized input)', () => {
  assert.deepEqual(layersForFramework('nextjs'), DEFAULT_LAYERS);
});

test('loadConfig merges a valid architecture.yml, overriding severities', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'architecture.yml'),
    'rules:\n  PAGE-004: warning\n  PURE-001: off\n',
  );
  const config = loadConfig(dir);
  assert.equal(config.rules['PAGE-004'].severity, 'warning');
  assert.equal(config.rules['PURE-001'].severity, 'off');
  // Unrelated rule defaults are preserved, including their descriptive name.
  assert.equal(config.rules['ROUTE-001'].severity, 'error');
  assert.equal(config.rules['PAGE-004'].name, DEFAULT_RULES['PAGE-004'].name);
});

test('loadConfig accepts an object-form rule entry carrying extra fields', () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, 'architecture.yml'),
    'rules:\n  PAGE-004: { severity: warning, note: "temporary" }\n',
  );
  const config = loadConfig(dir);
  assert.equal(config.rules['PAGE-004'].severity, 'warning');
  assert.equal(config.rules['PAGE-004'].note, 'temporary');
});

test('loadConfig throws a ConstructError on malformed YAML', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  PAGE-004: [error\n');
  assert.throws(
    () => loadConfig(dir),
    (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /Failed to parse architecture\.yml/);
      return true;
    },
  );
});

test('loadConfig throws with a "did you mean" suggestion for an unknown rule id', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  PAGE-04: error\n');
  assert.throws(
    () => loadConfig(dir),
    (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /Unknown rule 'PAGE-04'/);
      assert.match(err.message, /did you mean 'PAGE-004'\?/);
      return true;
    },
  );
});

test('loadConfig throws for an invalid severity value', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules:\n  PAGE-004: critical\n');
  assert.throws(
    () => loadConfig(dir),
    (err) => {
      assert.ok(err instanceof ConstructError);
      assert.equal(err.exitCode, EXIT_CODES.USAGE_ERROR);
      assert.match(err.message, /Invalid severity 'critical'/);
      return true;
    },
  );
});

test('findProjectRoot discovers a monorepo parent config from a nested subdirectory', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'architecture.yml'), 'rules: {}\n');
  const nested = path.join(dir, 'packages', 'app', 'src');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), dir);
});

test('findProjectRoot returns null when no architecture.yml exists up to the filesystem root', () => {
  const dir = tmpProject(); // freshly created tmp dir has no architecture.yml, and neither does its os.tmpdir() ancestry
  assert.equal(findProjectRoot(dir), null);
});
