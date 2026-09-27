// Epic 1.1 — Layer Graph Definition
//
// Canonical layer graph (extends DEFAULT_LAYERS from config.mjs), project-level
// override support via architecture.yml's `layers:` key, and a graph-validity
// checker (no cycles, every referenced layer exists).
//
// `mergeLayers`/`validateGraph`/`PSEUDO_LAYERS` now live in config.mjs (#699), so that
// loadConfig()'s own `layers` field can share the exact same merge+validate path as
// loadLayerGraph() below instead of drifting from it; they're re-exported here unchanged so
// existing importers of this module (and its tests) don't need to move.
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { DEFAULT_LAYERS, normalizeFramework, normalizeLayers, mergeLayers, validateGraph, PSEUDO_LAYERS } from './config.mjs';
import { globToRegExp } from './glob.mjs';
import { matchFrozen, readFrozenGlobs } from './frozen.mjs';
import { rel } from './fs.mjs';

export { PSEUDO_LAYERS, mergeLayers, validateGraph };

// Re-exported for convenience so consumers of this module don't also need to
// reach into config.mjs.
export const CANONICAL_LAYERS = DEFAULT_LAYERS;

/**
 * Load the effective layer graph for a project: the base graph for its
 * `project.framework` (nextjs by default — see config.mjs's
 * layersForFramework) merged with any `layers:` override in
 * architecture.yml, validated for correctness. Mirrors the way loadConfig()
 * reads architecture.yml (they share config.mjs's normalizeLayers).
 *
 * @param {string} root Project root; `architecture.yml` is optional.
 * @returns {Record<string, {pattern?: string, canImport: string[]}>} The validated layer graph: layer name to file pattern and the layers it may import.
 * @throws {Error} When the merged graph is invalid (unknown layer in `canImport`, and so on).
 * @since 0.8
 */
export function loadLayerGraph(root) {
  const file = path.join(root, 'architecture.yml');
  if (!fs.existsSync(file)) {
    validateGraph(DEFAULT_LAYERS);
    return DEFAULT_LAYERS;
  }
  const c = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  return normalizeLayers(c.layers, normalizeFramework(c.project?.framework));
}

/** Is `from` allowed to import `to`? Same-layer imports are always allowed. */
export function canImport(layers, from, to) {
  if (from === to) return true;
  return !!(layers[from] && layers[from].canImport && layers[from].canImport.includes(to));
}

/**
 * THE layer classifier (#174): the first layer in `graph` whose `pattern` glob matches the
 * project-relative path, or null. Driven entirely by the (framework + `layers:` override) graph,
 * so a custom pattern classifies files the same way everywhere -- the enforcers, `parseFile`
 * summaries, the readability checks.
 *
 * @param {string} relPath Project-relative path, forward slashes.
 * @param {Record<string, {pattern?: string}>} graph Layer graph from `loadLayerGraph`.
 * @returns {string|null} The first layer whose pattern matches, or `null` when the file belongs to no layer.
 *
 * @example
 * classifyFile('features/plan/services/planApi.ts', loadLayerGraph(root)); // => 'service'
 */
export function classifyFile(relPath, graph) {
  for (const [layer, def] of Object.entries(graph)) {
    if (def.pattern && globToRegExp(def.pattern).test(relPath)) return layer;
  }
  return null;
}

/**
 * Classify a file of the project at `root` the way the enforcers see it: through the project's
 * layer graph, and a file inside a configured `frozen:` region is externally authored, so it is
 * never classified (null). Pass `{ graph, frozenGlobs }` when classifying many files so the
 * graph/config are loaded once; otherwise they are loaded from `root`.
 *
 * @param {string} root Project root.
 * @param {string} filePath Absolute or project-relative file path.
 * @param {object} [options]
 * @param {object} [options.graph] Pre-loaded layer graph (avoids re-reading config per file).
 * @param {string[]} [options.frozenGlobs] Pre-loaded frozen globs.
 * @returns {string|null} The layer name, or `null` for unclassified and frozen files.
 */
export function classifyProjectFile(root, filePath, { graph, frozenGlobs } = {}) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const g = graph || loadLayerGraph(root);
  const frozen = frozenGlobs || readFrozenGlobs(root);
  if (frozen.length && matchFrozen(root, abs, frozen)) return null;
  return classifyFile(rel(root, abs), g);
}
