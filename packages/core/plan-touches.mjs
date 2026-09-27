// #470 -- the files a writing plan step will create, worked out from its own arguments, so a plan built in the
// Cockpit can declare them (the approval gate refuses any file a plan did not declare, approvalGate.mjs check 2).
// Deterministic and read-only: it computes the same paths the generators write (`layerTargetFile`, `createFeature`)
// without touching the disk, and never calls a model. A flow it cannot derive exactly answers `null`, never a guess:
// an undeclared file is refused loudly at approval, a wrongly declared one would be trusted silently.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { LAYER_ORDER, layerTargetFile, pascalCase } from './generators.mjs';
import { shapeTouches } from './shapes.mjs';
import { proofTouches } from './proof.mjs';
import { routeEntryTouches, dependencyTouches } from './wiring.mjs';
import { envTouches } from './env.mjs';
import { wrapProviderTouches } from './provider-wrap.mjs';
import { guardTouches } from './guard.mjs';
import { storeTouches } from './store.mjs';
import { handlerTouches } from './handler.mjs';

const isName = (v) => typeof v === 'string' && v.trim().length > 0;
const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const shapeArgs = (args) => ({ shape: args.shape, name: args.name, feature: args.feature, entity: args.entity, fields: args.fields, source: args.source, steps: args.steps, states: args.states });

/**
 * Prepend `types.ts`/`index.ts` to `files` when `feature`'s folder doesn't exist yet — the plan-preview side of #677:
 * `create.unit`/`create.layer` now scaffold a missing feature before writing into it (generators.mjs's
 * `ensureFeatureExists`), so the plan step's own declared scope must say so too, or the approval gate would refuse a
 * file the step is actually about to write. A path the flow's own touches already lists (a shaped domain layer already
 * touches `types.ts`) is not duplicated; declaring it a 'create' there instead of a 'modify' is left to that flow's own
 * touches, this only adds what would otherwise be missing entirely.
 */
function withMissingFeatureTouches(root, config, feature, files) {
  if (!files) return null;
  const base = path.join(config.features?.root || 'features', feature);
  if (fs.existsSync(path.join(root, base))) return files;
  const already = new Set(files.map((f) => f.path));
  const featureFiles = ['types.ts', 'index.ts']
    .map((f) => ({ path: rel(root, path.join(root, base, f)), change: 'create' }))
    .filter((f) => !already.has(f.path));
  return [...featureFiles, ...files];
}

/** Flows whose written files are derived here. Every other writing flow answers `null` until its output is pinned by a test. */
export const DERIVED_FLOWS = Object.freeze(['create.feature', 'create.unit', 'create.layer', 'create.proof', 'create.route', 'add.dependency', 'add.env', 'wrap.provider', 'guard.route', 'create.store', 'create.handler']);

/**
 * The project-relative files a writing plan step will create, derived from its own arguments without touching the disk.
 *
 * @param {string} root Project root (its architecture.yml decides the features folder).
 * @param {string} flowId A plan flow id (`create.unit`, ...).
 * @param {Record<string, unknown>} [args] The step's arguments.
 * @returns {{path: string, change: 'create'|'modify', layer?: string}[] | null} Project-relative POSIX paths the step will create,
 *   or `null` when the flow is not derived or the arguments do not name a valid unit yet (the validator says why).
 */
export function expectedFiles(root, flowId, args = {}) {
  try {
    const config = loadConfig(root);
    if (flowId === 'create.feature') {
      if (!isName(args.name)) return null;
      pascalCase(args.name); // the generator's own identifier check: an illegal name writes nothing
      const base = path.join(config.features?.root || 'features', args.name);
      return ['types.ts', 'index.ts'].map((f) => ({ path: rel(root, path.join(root, base, f)), change: 'create' }));
    }
    if (flowId === 'create.unit') {
      if (!isName(args.name) || !isName(args.feature) || !LAYER_ORDER.includes(args.layer)) return null;
      // #619: a shaped unit writes every file its shape lists for the layer (and the feature's types.ts for the domain layer).
      // #677: plus the feature's own types.ts/index.ts first, when the feature doesn't exist yet.
      if (args.shape !== undefined) return withMissingFeatureTouches(root, config, args.feature, shapeTouches(root, { ...shapeArgs(args), layer: args.layer }));
      return withMissingFeatureTouches(root, config, args.feature, [{ path: rel(root, layerTargetFile(root, args.layer, args.name, args.feature, config)), change: 'create', layer: args.layer }]);
    }
    if (flowId === 'create.layer') {
      const layers = asList(args.layers);
      if (!isName(args.name) || !isName(args.feature) || !layers.length || !layers.every((l) => LAYER_ORDER.includes(l))) return null;
      if (args.shape !== undefined) {
        const shaped = LAYER_ORDER.filter((l) => layers.includes(l)).map((l) => shapeTouches(root, { ...shapeArgs(args), layer: l }));
        return shaped.every(Boolean) ? withMissingFeatureTouches(root, config, args.feature, shaped.flat()) : null;
      }
      // Generated in canonical order, whatever order the step lists them in (generateVertical). #677: plus the
      // feature's own types.ts/index.ts first, when the feature doesn't exist yet.
      return withMissingFeatureTouches(
        root,
        config,
        args.feature,
        LAYER_ORDER.filter((l) => layers.includes(l)).map((l) => ({ path: rel(root, layerTargetFile(root, l, args.name, args.feature, config)), change: 'create', layer: l })),
      );
    }
    // #623: the proof of a shaped screen writes its test file (when its kind applies to this project) and declares the test regions.
    if (flowId === 'create.proof') {
      if (!isName(args.name) || !isName(args.feature)) return null;
      return proofTouches(root, { name: args.name, feature: args.feature, kind: args.kind, shape: args.shape, entity: args.entity, fields: args.fields, source: args.source, steps: args.steps, states: args.states });
    }
    // #654: the route entry a screen is wired into (Next.js creates a page.tsx, react-spa modifies src/App.tsx), and the one line added to package.json.
    if (flowId === 'create.route') return routeEntryTouches(root, { name: args.name, feature: args.feature, route: args.route });
    if (flowId === 'add.dependency') return dependencyTouches(root, { name: args.name, version: args.version });
    // #632: the one file an environment variable is added to. #631: the controller that renders the element a provider wraps (a refusal derives nothing).
    if (flowId === 'add.env') return envTouches(root, { name: args.name, scope: args.scope, value: args.value, comment: args.comment });
    if (flowId === 'wrap.provider') return wrapProviderTouches(root, { name: args.name, feature: args.feature, provider: args.provider });
    // #629: the units of a route guard, the barrel and types it updates, the route entry it edits and its proof (the public access writes nothing).
    if (flowId === 'guard.route') return guardTouches(root, { name: args.name, feature: args.feature, access: args.access, roles: args.roles, redirect: args.redirect, route: args.route });
    // #630: the reducer and the hook of a client-state store, the types and barrel it updates and its proof.
    if (flowId === 'create.store') return storeTouches(root, { name: args.name, feature: args.feature, shape: args.shape, entity: args.entity, fields: args.fields });
    // #625: the route handler, its domain unit and service, the types and barrel it updates and its proof (a react-spa project has no handler: nothing is derived).
    if (flowId === 'create.handler') return handlerTouches(root, { name: args.name, feature: args.feature, method: args.method, path: args.path, service: args.service, entity: args.entity, fields: args.fields });
    return null;
  } catch {
    return null;
  }
}
