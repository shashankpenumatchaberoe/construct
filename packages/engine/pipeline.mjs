// Ticket 7.1 -- Context Envelope pipeline runner.
//
// `runPipeline(root, inputEnvelope)` is the pure orchestration behind
// `construct pipeline run`: it renders every requested step's generated file
// content (via generators.mjs's renderLayer -- no disk write yet), stages
// all of them in one transactionalWriter transaction, and commits once.
// Either every step's file lands on disk together, or (if the combined
// result fails construct validate's own enforcer set) none of them do --
// there is no partially-applied pipeline run.
import { renderLayer } from '../core/generators.mjs';
import { aggregateValidation } from '../core/registry.mjs';
import { createTransaction } from './transactionalWriter.mjs';
import { createEnvelope } from './envelope.mjs';
import { rel } from '../core/fs.mjs';
import { loadConfig } from '../core/config.mjs';
import { makeViolation } from '../core/diagnostics.mjs';
import { assertFeature } from '../core/block-kit.mjs';
import { DEFAULT_ENFORCERS } from './defaultEnforcers.mjs';

/** Merge freshly-committed step outputs into the envelope's `layers` map:
 * { layer: [file, file, ...] }, deduped, sorted for deterministic output. */
function mergeLayers(existingLayers, committedByLayer) {
  const merged = { ...existingLayers };
  for (const [layer, files] of Object.entries(committedByLayer)) {
    const prior = merged[layer] || [];
    merged[layer] = [...new Set([...prior, ...files])].sort();
  }
  return merged;
}

/**
 * Run the generator steps of a Context Envelope as one transaction: every step renders its layer file, all files are written together and validated, and the whole change is committed or rolled back. The envelope comes back updated (see `@returns`).
 *
 * @param {string} root - project root.
 * @param {object} inputEnvelope - a Context Envelope, optionally carrying a
 *   `steps: [{layer, name}, ...]` list of generator steps to run against
 *   `inputEnvelope.feature`. Already schema-validated by the caller
 *   (packages/core/cli.mjs's `pipeline` command uses envelope.mjs's validateEnvelope).
 * @returns {object} the resulting Context Envelope (`status`: 'committed' |
 *   'aborted', `steps` always cleared, `layers`/`diagnostics` updated).
 *
 * @example
 * const out = runPipeline(root, { version: 1, feature: 'billing', status: 'pending', layers: [], steps: [{ layer: 'service', name: 'invoice' }] });
 * out.status; // => 'committed'
 */
export function runPipeline(root, inputEnvelope) {
  const feature = inputEnvelope.feature;
  const steps = inputEnvelope.steps || [];
  const base = createEnvelope(feature, {
    unboundSlots: inputEnvelope.unboundSlots || [],
    events: inputEnvelope.events || [],
    layers: inputEnvelope.layers || {},
  });

  // A step renders into an existing feature slice; unlike `create.unit`/`create.layer` (#677),
  // pipeline.run can't auto-scaffold the feature here -- there's nothing to stage that "creates
  // a feature" inside the all-or-nothing transaction below, only generator-step files. Refuse up
  // front with the same clear, actionable message block-kit.mjs's `assertFeature` gives
  // create.store/create.handler/guard.route, instead of letting a nonexistent feature slice fall
  // through to commit-time validation and surface as a bare SLICE-001 (#727).
  if (steps.length) {
    try {
      assertFeature(root, feature);
    } catch (err) {
      const featuresRoot = loadConfig(root).features?.root || 'features';
      return {
        ...base,
        status: 'aborted',
        diagnostics: [makeViolation({
          rule: 'SLICE-001',
          module: 'separation-of-concerns',
          severity: 'error',
          file: `${featuresRoot}/${feature}/`,
          line: 1,
          message: err.message,
          why: 'A generator step can only render into a feature slice that already exists; pipeline.run refuses instead of auto-creating one inside its transaction.',
          expected: [`${featuresRoot}/${feature}/`],
          suggestedFix: `construct create feature ${feature}`,
        })],
      };
    }
  }

  const txn = createTransaction(root);
  const renderedByLayer = {};

  for (const step of steps) {
    const { file, content } = renderLayer(root, step.layer, step.name, feature);
    const relPath = rel(root, file);
    txn.writeFile(relPath, content);
    (renderedByLayer[step.layer] ||= []).push(relPath);
  }

  const { committed, violations } = txn.commit({
    validate: (shadowRoot) => aggregateValidation(shadowRoot, DEFAULT_ENFORCERS),
  });

  if (committed) {
    return {
      ...base,
      status: 'committed',
      layers: mergeLayers(base.layers, renderedByLayer),
      diagnostics: [],
    };
  }
  return {
    ...base,
    status: 'aborted',
    diagnostics: violations,
  };
}
