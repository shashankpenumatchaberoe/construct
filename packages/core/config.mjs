import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ConstructError, EXIT_CODES } from './diagnostics.mjs';
import { normalizeFrozen } from './frozen.mjs';
import { normalizeNonLayer } from './nonLayer.mjs';

export const DEFAULT_LAYERS = {
  route: { pattern: 'app/**/page.tsx', canImport: ['controller'] },
  controller: { pattern: 'features/*/controllers/**', canImport: ['workflow', 'hook', 'service', 'page', 'component', 'domain', 'types'] },
  workflow: { pattern: 'features/*/workflows/**', canImport: ['service', 'domain', 'types'] },
  hook: { pattern: 'features/*/hooks/**', canImport: ['workflow', 'service', 'domain', 'types'] },
  service: { pattern: 'features/*/services/**', canImport: ['domain', 'types'] },
  domain: { pattern: 'features/*/domain/**', canImport: ['types'] },
  page: { pattern: 'features/*/pages/**', canImport: ['component', 'types'] },
  component: { pattern: 'features/*/components/**', canImport: ['component', 'types'] },
  // #503 (part of #500's Phase 1 typed-contracts epic) -- control-flow units that wrap JSX
  // nodes (If/Switch/ForEach/Show, per #499's design). canImport is DELIBERATELY identical to
  // component's own (['component', 'types']) -- "mirrors component's own canImport" per #503's
  // brief -- so an Expression may compose other component units but never reach into
  // workflow/service/domain/controller, exactly like a component can't. Purely additive: no
  // existing project has a `features/*/expressions/**` file today, so this new pattern/layer
  // changes classification for zero pre-existing files.
  expression: { pattern: 'features/*/expressions/**', canImport: ['component', 'types'] },
};

// Every layer graph below shares the same feature-internal shape
// (controller/workflow/hook/service/domain/page/component all live under
// `features/*/<folder>/**`, framework-agnostic) — the only thing that
// actually differs per target framework is where the "route" layer's entry
// points physically live and how they're structured. Next.js App Router
// uses file-system routing (one `page.tsx` per route folder under `app/`);
// a react-spa target has no such per-route file — routing is centralized in
// one file (by convention `src/App.tsx`, mirroring `ui/client/src/App.jsx`'s
// real shape: a single file with a react-router `<Routes>` table mapping
// URL paths straight to controller elements) that this pattern must match
// instead. Every field other than `route` is intentionally identical to
// DEFAULT_LAYERS above.
export const REACT_SPA_LAYERS = { ...DEFAULT_LAYERS, route: { pattern: 'src/App.tsx', canImport: ['controller'] } };

// Recognized `project.framework` values in architecture.yml. `nextjs` stays
// the default so every project that predates this option (or simply never
// sets it) keeps behaving exactly as before.
export const FRAMEWORKS = ['nextjs', 'react-spa'];
const DEFAULT_FRAMEWORK = 'nextjs';

const LAYERS_BY_FRAMEWORK = {
  nextjs: DEFAULT_LAYERS,
  'react-spa': REACT_SPA_LAYERS,
};

/**
 * Validate and normalize a `project.framework` value from architecture.yml.
 * Absent/undefined normalizes to the default ('nextjs') for full backward
 * compatibility with every project written before this option existed.
 *
 * @param {string|null|undefined} raw The `project.framework` value from `architecture.yml`.
 * @returns {string} A supported framework id; `'nextjs'` when `raw` is absent.
 * @throws {Error} A usage error naming the supported frameworks when `raw` is unknown.
 *
 * @example
 * normalizeFramework(undefined); // => 'nextjs'
 * normalizeFramework('react-spa'); // => 'react-spa'
 */
export function normalizeFramework(raw) {
  if (raw === undefined || raw === null) return DEFAULT_FRAMEWORK;
  if (typeof raw !== 'string' || !FRAMEWORKS.includes(raw)) {
    throw usageError(
      `Unknown project.framework '${raw}' in architecture.yml — expected one of: ${FRAMEWORKS.join(', ')}.`,
    );
  }
  return raw;
}

// Ticket 7.5 — recognized `project.dataLayer.provider` values. Selects which
// transport adapter the service generator instantiates as `baseQuery` in
// `features/core/services/client.ts`: RTKQ's own `fetchBaseQuery` (the
// default, so a project that never sets this keeps getting exactly what it
// would have gotten before this option existed), a hand-rolled Axios
// adapter, or a network-free mock adapter for tests/demos.
export const DATA_LAYER_PROVIDERS = ['fetchBaseQuery', 'axios', 'mock'];
const DEFAULT_DATA_LAYER_PROVIDER = 'fetchBaseQuery';

/**
 * Validate and normalize a `project.dataLayer.provider` value from
 * architecture.yml. Absent/undefined normalizes to the default
 * ('fetchBaseQuery'), mirroring normalizeFramework's backward-compatible
 * shape above.
 */
export function normalizeDataLayerProvider(raw) {
  if (raw === undefined || raw === null) return DEFAULT_DATA_LAYER_PROVIDER;
  if (typeof raw !== 'string' || !DATA_LAYER_PROVIDERS.includes(raw)) {
    throw usageError(
      `Unknown project.dataLayer.provider '${raw}' in architecture.yml — expected one of: ${DATA_LAYER_PROVIDERS.join(', ')}.`,
    );
  }
  return raw;
}

// #541 -- recognized `project.execution.mode` values: WHICH implementation runs a core activity for the
// Cockpit. 'engine' (the default, so a project that never sets this behaves exactly as before) calls the
// packages/core + packages/engine functions in-process; 'cli' runs the real `construct` binary as a
// subprocess and parses its `--format json` output. Same shape and same backward-compatible default as
// project.dataLayer.provider above; the CLI itself ignores it (it always is the CLI).
export const EXECUTION_MODES = ['engine', 'cli'];
export const DEFAULT_EXECUTION_MODE = 'engine';

/**
 * Validate and normalize a `project.execution.mode` value from architecture.yml. Absent/undefined
 * normalizes to 'engine'.
 *
 * @param {string|null|undefined} raw The `project.execution.mode` value from `architecture.yml`.
 * @returns {'engine'|'cli'} A supported execution mode; `'engine'` when `raw` is absent.
 * @throws {Error} A usage error naming the supported modes when `raw` is unknown.
 * @since 0.9
 *
 * @example
 * normalizeExecutionMode(undefined); // => 'engine'
 * normalizeExecutionMode('cli'); // => 'cli'
 */
export function normalizeExecutionMode(raw) {
  if (raw === undefined || raw === null) return DEFAULT_EXECUTION_MODE;
  if (typeof raw !== 'string' || !EXECUTION_MODES.includes(raw)) {
    throw usageError(
      `Unknown project.execution.mode '${raw}' in architecture.yml — expected one of: ${EXECUTION_MODES.join(', ')}.`,
    );
  }
  return raw;
}

/** #643 -- the recognized top-level `traces` values in architecture.yml: whether the chain records `decision-trace.v1` records. */
export const TRACES_SETTINGS = ['on', 'off'];
/** Recording defaults to on: a trace is local (the state directory, outside the project), holds no path or secret, and never leaves the machine unless the owner exports it. */
export const DEFAULT_TRACES = 'on';

/**
 * Validate and normalize the top-level `traces:` value of architecture.yml (the per-project switch for decision traces,
 * #643). Absent normalizes to `on`; YAML `on`/`off` and `true`/`false` are all accepted.
 *
 * @param {string|boolean|null|undefined} raw The `traces` value from `architecture.yml`.
 * @returns {'on'|'off'} The setting; `'on'` when `raw` is absent.
 * @throws {Error} A usage error naming the allowed values when `raw` is anything else.
 * @since 0.10
 *
 * @example
 * normalizeTraces(undefined); // => 'on'
 * normalizeTraces(false); // => 'off'
 */
export function normalizeTraces(raw) {
  if (raw === undefined || raw === null) return DEFAULT_TRACES;
  if (raw === true || raw === 'on') return 'on';
  if (raw === false || raw === 'off') return 'off';
  throw usageError(`Unknown traces '${raw}' in architecture.yml — expected one of: ${TRACES_SETTINGS.join(', ')}.`);
}

/** #633 -- the defaults of the top-level `decision:` setting in architecture.yml: which decision provider suggests the next option in a chain. */
export const DEFAULT_DECISION = Object.freeze({ provider: 'rules', plugin: null, timeoutMs: 3000 });
const DECISION_KEYS = ['provider', 'plugin', 'timeoutMs'];
const DECISION_NAME = /^[a-z][a-z0-9._-]{0,39}$/;

/**
 * Validate and normalize the top-level `decision:` value of architecture.yml (#633): `{ provider: rules|off|<name>, plugin:
 * <path relative to the project>, timeoutMs }`. Absent normalizes to `{ provider: 'rules', plugin: null, timeoutMs: 3000 }`.
 * This only checks the SHAPE (a name, a relative path, a number of milliseconds between 100 and 30000); that the plugin file
 * stays inside the project and honours the provider contract is checked when it is loaded (`decision-plugin.mjs`), and it is
 * loaded only when its provider is named and is not `rules` or `off`.
 *
 * @param {unknown} raw The `decision` value from `architecture.yml`.
 * @returns {{ provider: string | null, plugin: string | null, timeoutMs: number }} The setting (`provider` is null when only a plugin is named: its own name applies once it is loaded).
 * @throws {Error} A usage error naming the problem when `raw` is not that shape.
 * @since 0.10
 *
 * @example
 * normalizeDecision(undefined); // => { provider: 'rules', plugin: null, timeoutMs: 3000 }
 * normalizeDecision({ provider: 'jev', plugin: 'tools/jev.mjs' }); // => { provider: 'jev', plugin: 'tools/jev.mjs', timeoutMs: 3000 }
 */
export function normalizeDecision(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_DECISION };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw usageError("decision in architecture.yml must be a mapping like { provider: rules, plugin: tools/jev.mjs, timeoutMs: 3000 }.");
  const unknown = Object.keys(raw).find((k) => !DECISION_KEYS.includes(k));
  if (unknown) throw usageError(`Unknown decision.${unknown} in architecture.yml — expected: ${DECISION_KEYS.join(', ')}.`);
  const plugin = raw.plugin ?? null;
  if (plugin !== null && (typeof plugin !== 'string' || !plugin.trim() || plugin.includes('\0'))) throw usageError('decision.plugin in architecture.yml must be a file path relative to the project, for example tools/jev.mjs.');
  const provider = raw.provider ?? (plugin ? undefined : DEFAULT_DECISION.provider);
  // A plugin with no provider named means "that plugin": its own name is read when it is loaded.
  if (provider !== undefined && (typeof provider !== 'string' || !DECISION_NAME.test(provider))) throw usageError(`decision.provider '${provider}' in architecture.yml must be rules, off or a plugin name (lowercase letters, digits, . _ -).`);
  const timeoutMs = raw.timeoutMs ?? DEFAULT_DECISION.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw usageError(`decision.timeoutMs '${timeoutMs}' in architecture.yml must be a whole number of milliseconds between 100 and 30000.`);
  return { provider: provider ?? null, plugin: plugin?.trim() ?? null, timeoutMs };
}

/** The canonical base layer graph for a given (already-normalized) framework
 * value — the shape #66/#67 and architecture-graph.mjs's loadLayerGraph
 * branch on before applying any project-level `layers:` override. */
export function layersForFramework(framework) {
  return LAYERS_BY_FRAMEWORK[framework] || DEFAULT_LAYERS;
}

// Names that are valid `canImport` targets but are not themselves layers with
// files to classify (e.g. a feature's types.ts). Never subject to cycle
// detection or "does this layer exist" checks. (Re-exported by
// architecture-graph.mjs, which historically owned this constant.)
export const PSEUDO_LAYERS = new Set(['types']);

/**
 * Merge a project's `layers:` override/extension on top of the canonical
 * defaults. A layer entry may:
 *  - fully replace `canImport` by specifying it directly, or
 *  - additively extend the base layer's `canImport` via `addCanImport`.
 * New layer names not present in the base graph may also be introduced,
 * provided they declare both `pattern` and `canImport`.
 *
 * @param {Record<string, {pattern?: string, canImport: string[]}>} base The canonical base layer graph (e.g. from `layersForFramework`).
 * @param {Record<string, {pattern?: string, canImport?: string[], addCanImport?: string[]}>} [overrides] The project's `layers:` override/extension from `architecture.yml`.
 * @returns {Record<string, {pattern?: string, canImport: string[]}>} The merged layer graph (not yet validated; pass to `validateGraph`).
 */
export function mergeLayers(base, overrides = {}) {
  /** @type {Record<string, {pattern?: string, canImport: string[]}>} */
  const merged = {};
  for (const [name, def] of Object.entries(base)) {
    merged[name] = { ...def, canImport: [...(def.canImport || [])] };
  }
  for (const [name, def] of Object.entries(overrides || {})) {
    const existing = merged[name] || { canImport: [] };
    const { addCanImport, ...defRest } = def;
    const canImport = Array.isArray(def.canImport)
      ? [...def.canImport]
      : [...new Set([...(existing.canImport || []), ...(addCanImport || [])])];
    merged[name] = { ...existing, ...defRest, canImport };
  }
  return merged;
}

/**
 * Validate a layer graph: every layer must declare a canImport array, every
 * edge must point at either a known layer or a pseudo-layer (e.g. `types`),
 * and the graph (ignoring pseudo-layers and same-layer self-edges, which are
 * always permitted) must be acyclic. Throws a ConstructError naming the
 * exact bad edge/cycle on failure.
 *
 * @param {Record<string, {pattern?: string, canImport: string[]}>} layers The layer graph to validate (e.g. from `mergeLayers`).
 * @returns {true} `true` when the graph is well-formed and acyclic.
 * @throws {Error} A ConstructError naming the missing canImport array, unknown edge target, or cycle.
 */
export function validateGraph(layers) {
  const names = new Set(Object.keys(layers));

  for (const [name, def] of Object.entries(layers)) {
    if (!def || !Array.isArray(def.canImport)) {
      throw new ConstructError(
        `Invalid architecture graph: layer "${name}" is missing a canImport array.`,
        { exitCode: EXIT_CODES.USAGE_ERROR },
      );
    }
    for (const target of def.canImport) {
      if (PSEUDO_LAYERS.has(target)) continue;
      if (!names.has(target)) {
        throw new ConstructError(
          `Invalid architecture graph: layer "${name}" declares canImport edge "${name} -> ${target}", but layer "${target}" does not exist.`,
          { exitCode: EXIT_CODES.USAGE_ERROR },
        );
      }
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...names].map((n) => [n, WHITE]));

  function visit(node, stack) {
    color.set(node, GRAY);
    for (const target of layers[node].canImport) {
      if (PSEUDO_LAYERS.has(target) || target === node) continue;
      if (color.get(target) === GRAY) {
        throw new ConstructError(
          `Invalid architecture graph: cycle detected (${[...stack, node, target].join(' -> ')}).`,
          { exitCode: EXIT_CODES.USAGE_ERROR },
        );
      }
      if (color.get(target) === WHITE) visit(target, [...stack, node]);
    }
    color.set(node, BLACK);
  }

  for (const name of names) {
    if (color.get(name) === WHITE) visit(name, []);
  }

  return true;
}

/**
 * Resolve the effective layer graph for a project: the framework's base layers (`layersForFramework`)
 * merged with any `layers:` override from architecture.yml (`mergeLayers`), then validated
 * (`validateGraph`) so a malformed override — an unknown `canImport` edge, a cycle, a non-mapping
 * value — is rejected with a clear diagnostic naming the `layers` field instead of silently landing
 * in the effective config or being dropped (#699). Absent `layers:` returns the framework base
 * unchanged, so a project that never sets it keeps behaving exactly as before.
 *
 * @param {unknown} raw The `layers` value from `architecture.yml`.
 * @param {string} framework An already-normalized `project.framework` value.
 * @returns {Record<string, {pattern?: string, canImport: string[]}>} The merged, validated layer graph.
 * @throws {Error} A usage error when `layers` is not a mapping, or the merged graph is invalid.
 * @since 0.10
 *
 * @example
 * normalizeLayers({ service: { pattern: 'features/*\/service/**' } }, 'nextjs').service.pattern; // => 'features/*\/service/**'
 */
export function normalizeLayers(raw, framework) {
  const base = layersForFramework(framework);
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw usageError('layers in architecture.yml must be a mapping of layer name to { pattern, canImport }.');
  }
  const merged = mergeLayers(base, /** @type {Record<string, {pattern?: string, canImport?: string[], addCanImport?: string[]}>} */ (raw));
  validateGraph(merged);
  return merged;
}

// Rule severities AND non-architecture thresholds (e.g. a future readability
// rule like 'READ-002-max-loc') live in this same uniform map. A value is
// either a bare severity string ('error' | 'warning' | 'off') or an object
// that at minimum carries `severity`, plus whatever extra fields the owning
// enforcer needs (e.g. { severity: 'warning', maxLoc: 200 }).
export const DEFAULT_RULES = {
  'ROUTE-001': { severity: 'error', name: 'Routes delegate to controllers' },
  'ROUTE-002': { severity: 'error', name: 'Routes cannot own business logic or effects' },
  // #597 -- PAGE-001/COMPONENT-001/PURE-001 each got a real detector (architecture-enforcer.mjs, see the
  // block above PAGE_001_STATE_HOOKS). PAGE-001 and COMPONENT-001 now default to 'warning' (was 'error'):
  // a new detector must not turn an existing project red without it opting in, and every generated
  // architecture.yml lists them explicitly, so those projects keep 'error'.
  'PAGE-001': { severity: 'warning', name: 'Pages hold no state or effect of their own (presentation-only)' },
  'PAGE-002': { severity: 'error', name: 'Pages cannot import workflows' },
  'PAGE-003': { severity: 'error', name: 'Pages cannot import services' },
  'PAGE-004': { severity: 'error', name: 'Pages cannot call fetch' },
  'PAGE-005': { severity: 'error', name: 'Pages cannot import domain logic' },
  'PAGE-006': { severity: 'error', name: 'Pages cannot use application state/machines' },
  // #510 -- the hooks/ layer's first real rule: a hook named use<Name>Provider must really be
  // built through defineProvider(...). This is what makes PAGE-006's narrowing (below) sound —
  // a page may import a hook by this naming convention alone specifically because HOOK-002
  // holds the convention itself accountable.
  'HOOK-002': { severity: 'error', name: 'A hook named use<Name>Provider must be built through defineProvider(...)' },
  // #504 -- the hooks/ layer's other real rule, alongside HOOK-002: a hook named
  // use<Name>State must be built through useTrackedState(...) (packages/core/typed-contracts/
  // trackedState.ts) and may contain only that state declaration plus its directly-coupled
  // setters/derivations -- nothing unrelated. This is the concrete fix for the dogfood-found
  // (#490) useCanvasEditor.tsx failure class: unrelated business logic (there, HTML5 canvas
  // drawing code) filled into a hook with nothing in the rule engine to stop it.
  'HOOK-001': { severity: 'error', name: 'A hook named use<Name>State must be built through useTrackedState(...), with nothing unrelated alongside it' },
  'COMPONENT-001': { severity: 'warning', name: 'Components own no application state machine (presentation-only)' },
  'COMPONENT-002': { severity: 'error', name: 'Components cannot import controllers' },
  'COMPONENT-003': { severity: 'error', name: 'Components cannot import workflows/services/domain' },
  // #508 (part of #500's typed-contracts epic) -- mirrors the still-unbuilt
  // PAGE-008/PAGE-009 (#505) applied to defineComponent instead of
  // definePage. Heuristic, AST-shape rules (packages/ast/jsxComplexity.mjs),
  // not the typed-factory mechanism itself -- default severity is
  // 'warning', not 'error', deliberately: real hand-written components (see
  // fixtures/frozen-presentation's project-bad/HomeShell.tsx, a `.map()`
  // render) already exist that this shape-detector correctly flags, and a
  // silent severity bump to 'error' for existing projects is exactly the
  // kind of non-additive breakage #500 phase 1 rules out. A project can
  // still opt into 'error' itself via architecture.yml.
  'COMPONENT-005': { severity: 'warning', name: 'Components cannot contain inline conditional/loop logic in JSX — must be a named @expression unit' },
  'COMPONENT-006': { severity: 'warning', name: "Component-level JSX complexity budget (nesting depth / inline conditional-or-loop branch count), separate from any one Expression's own cap" },
  // Numeric threshold overrides for COMPONENT-006, same `numeric: true`
  // escape-hatch shape as 'READ-002-max-loc' above.
  'COMPONENT-006-max-depth': { name: "Override for COMPONENT-006's max JSX nesting depth", numeric: true },
  'COMPONENT-006-max-branches': { name: "Override for COMPONENT-006's max inline conditional/loop branch count", numeric: true },
  // #505 -- mirrors COMPONENT-005/006 exactly, applied to the page layer instead of
  // component (same detection helpers, packages/ast/jsxComplexity.mjs). Default severity is
  // 'warning' for the same reason as COMPONENT-005/006: a real existing fixture
  // (fixtures/frozen-presentation/project-bad/features/cpo/pages/CpoHome.tsx, a `.map()`
  // render) already has inline loop logic in a page's JSX, so a silent 'error' default would
  // have broken it -- exactly the non-additive breakage #500 phase 1 rules out.
  'PAGE-008': { severity: 'warning', name: 'Pages cannot contain inline conditional/loop logic in JSX — must be a named @expression unit' },
  'PAGE-009': { severity: 'warning', name: "Page-level JSX complexity budget (nesting depth / inline conditional-or-loop branch count), separate from any one Expression's own cap" },
  'PAGE-009-max-depth': { name: "Override for PAGE-009's max JSX nesting depth", numeric: true },
  'PAGE-009-max-branches': { name: "Override for PAGE-009's max inline conditional/loop branch count", numeric: true },
  // #503 (part of #500's Phase 1) -- the new `expression` layer's own rules (control-flow units
  // that wrap JSX nodes, per #499's design). Unlike COMPONENT-005/006, these default to 'error'
  // where they are structural (EXPR-001/004/005/006): no existing project has a
  // `features/*/expressions/**` file today, so there is no legacy-code false-positive risk the
  // way there was for COMPONENT-005/006 landing on already-existing components -- an Expression
  // file only ever exists once a project deliberately opts into this layer. EXPR-002/003 stay
  // 'warning' (a numeric complexity budget and a naming heuristic are guidance, not a hard
  // shape ban, the same category COMPONENT-006 and READ-001 already use).
  'EXPR-001': { severity: 'error', name: 'Expressions are pure (no side effects)' },
  'EXPR-002': { severity: 'warning', name: "An Expression's own JSX complexity budget (nesting depth / inline conditional-or-loop branch count)" },
  'EXPR-002-max-depth': { name: "Override for EXPR-002's max JSX nesting depth", numeric: true },
  'EXPR-002-max-branches': { name: "Override for EXPR-002's max inline conditional/loop branch count", numeric: true },
  'EXPR-003': { severity: 'warning', name: 'Expressions need an unambiguous, non-trivial name — not the bare name of their control-flow kind' },
  'EXPR-004': { severity: 'error', name: 'Expressions cannot contain hand-authored JSX beyond wrapping/passthrough' },
  'EXPR-005': { severity: 'error', name: 'Expressions must accept children and return JSX' },
  'EXPR-006': { severity: 'error', name: 'Expressions must be built through defineExpression(...) (the shared Template<Props> type)' },
  'WORKFLOW-001': { severity: 'error', name: 'Workflows cannot import React/UI' },
  // Epic #185 (#190) -- reuse the workflow narrator's health findings (packages/engine/workflowScenarios.mjs).
  'WORKFLOW-002': { severity: 'warning', name: 'Workflow states must be reachable from the initial state' },
  'WORKFLOW-003': { severity: 'warning', name: 'Non-final workflow states must have a way out' },
  'WORKFLOW-004': { severity: 'off', name: 'Every non-final workflow state must decide every event the machine handles (transition or explicit ignore)' },
  // #573/#581 -- a workflow's or hook's state must not be a bag of co-occurring status flags
  // (`isLoading` + `isError`, or a flag next to both `error` and `data`) that can express states
  // which cannot happen; a discriminated union on one `status` field is the fix. Off by default
  // (same phasing as DOMAIN-002/WORKFLOW-004: additive and flag-gated until dogfood evidence);
  // opt in with `rules: { STATE-001: warning }`.
  'STATE-001': { severity: 'off', name: 'Workflow/hook state is a discriminated union on one status field, not a bag of co-occurring loading/error/data flags' },
  // Ticket 7.4 (#114) -- genuinely new, per the epic's reconciliation notes (no existing
  // rule covers this): a controller's whole job is composing/wiring already-generated
  // layers together (import a page, import a hook, pass matched handlers down) -- never
  // a raw fetch() call or its own conditional/loop business logic, both of which belong
  // one layer down (service/hook/workflow/domain).
  'CONTROLLER-001': { severity: 'error', name: 'Controllers must compose (import + wire only) — no business logic or raw fetch()' },
  // #23 -- only evaluated when architecture.yml declares `frozen:` globs; see
  // frozen-detector.mjs for the exact (deterministic) heuristic and its option
  // fields (minDuplicateElements / similarity / maxOwnElements).
  'PAGE-007': { severity: 'warning', name: 'Pages wrap frozen (externally-authored) markup instead of reimplementing it' },
  'COMPONENT-004': { severity: 'warning', name: 'Components wrap frozen (externally-authored) markup instead of reimplementing it' },
  'CONTROLLER-002': { severity: 'warning', name: 'Controllers wrap frozen (externally-authored) markup instead of reimplementing it' },
  'SERVICE-001': { severity: 'error', name: 'Services own external effects' },
  'SERVICE-002': { severity: 'error', name: 'Services cannot import React/UI' },
  // #594 (part of #577) -- supersede-and-abort: a fetch() with no `signal` in its init, or a
  // defineService() fn whose first parameter type has no `signal: AbortSignal`, lets a stale
  // response land after its request was superseded (docs/staleness-by-layer.md's Service row).
  // Flag-gated off by default like DOMAIN-002/WORKFLOW-004/STATE-001 -- see the gating note on
  // SERVICE-003 in architecture-enforcer.mjs.
  'SERVICE-003': { severity: 'off', name: 'Services forward the caller\'s AbortSignal to fetch() so a superseded request never lands' },
  // #667/#668/#669 (part of #577) -- the Controller, Hook and Route rows of
  // docs/staleness-by-layer.md. Flag-gated off by default like SERVICE-003 -- see the gating
  // notes in architecture-enforcer.mjs.
  'CONTROLLER-003': { severity: 'off', name: 'A controller holds no state of its own (no useState/useRef/useEffect/useMemo/useCallback), so it binds the hook\'s live value, never a stale copy' },
  'HOOK-003': { severity: 'off', name: 'A useEffect that starts a listener, timer, subscription or request returns its cleanup, so it never outlives its hook' },
  'ROUTE-003': { severity: 'off', name: 'A route forwards params/searchParams whole instead of reading them, so a raw URL string never travels inward' },
  'DOMAIN-001': { severity: 'error', name: 'Domain is pure' },
  // #506 -- an allowlist alternative to DOMAIN-001's name-based denylist, additive alongside
  // it for now (#500 phase 1; removing DOMAIN-001 is phase 4 work). Default severity is
  // 'off' deliberately: this is the "flag-gated alternate implementation" #506 asks for while
  // it's unproven -- it is stricter than DOMAIN-001 in a way DOMAIN-001's own denylist fixture
  // (features/bad/domain/Domain001.ts's `fetch('/x')`) already demonstrates (a genuine effect
  // legitimately trips *both* rules at once), and turning it on by default would multiply
  // every existing DOMAIN-001 violation into two without any project opting in. A project (or
  // this repo's own dogfooding, once #506 is "proven" per #500 phase 2) turns it on with
  // `rules: { DOMAIN-002: error }` (or 'warning') in architecture.yml.
  'DOMAIN-002': { severity: 'off', name: 'Domain code may only reference its own parameters/local bindings, type-only imports, and a small set of JS built-ins (allowlist, not denylist)' },
  // #644 -- a file marked 'use client', and every file only it pulls in, ships to the browser, so it
  // may not import server-only code: a `service`-layer module, the `server-only` package, a database
  // or external-SDK adapter (default list in packages/core/client-boundary.mjs, extended by this
  // rule's `serverOnly: [...]` option), or a module that reads a non-public process.env variable.
  // Default severity is 'off', same reasoning as DOMAIN-002/READ-004: existing projects (this repo's
  // fixtures, and real apps whose client hooks call browser-safe services) are not silently turned
  // red. `construct init` opts NEW projects in at 'error' (NEW_PROJECT_RULE_SEVERITIES below); an
  // existing project opts in with `rules: { CLIENT-001: error }`.
  'CLIENT-001': { severity: 'off', name: "A 'use client' file cannot import server-only code" },
  'SLICE-001': { severity: 'error', name: 'Feature internals are isolated' },
  'SLICE-002': { severity: 'error', name: 'Cross-feature imports use public index.ts' },
  'MODULE-001': { severity: 'error', name: 'One primary module per file' },
  'PURE-001': { severity: 'warning', name: 'Domain functions should be deterministic (no Math.random, Date.now, new Date(), performance.now, crypto id)' },
  'DRY-001': { severity: 'warning', name: 'Business knowledge has one source of truth' },
  'SOC-001': { severity: 'error', name: 'Every responsibility has an architectural owner' },
  'SLICE-003': { severity: 'warning', name: 'Public API (index.ts) stays in sync with actual feature exports' },
  // #509 -- a component or Provider re-exported cross-feature must be a distinct wrapper, not a
  // raw re-export/alias of the internal unit (the release point for sharing, per #499).
  'SLICE-004': { severity: 'error', name: 'Cross-feature component/provider re-exports must be a distinct wrapper' },
  'READ-001': { severity: 'error', name: 'Components/controllers are PascalCase; hooks are use-prefixed camelCase' },
  'READ-002': { severity: 'error', name: 'Files and functions stay under their length threshold' },
  'READ-003': { severity: 'warning', name: 'Public API exports document intent with JSDoc' },
  // Not a rule with a severity — a numeric threshold override consumed directly by
  // readability-enforcer.mjs (via readRawRules, not this merged/validated map).
  // Registered here (numeric: true) purely so normalizeRules doesn't reject the key as
  // unknown or demand a severity-string/options-object shape for it (see normalizeRules
  // below, and readRawRules' doc comment for why the actual value bypasses validation).
  'READ-002-max-loc': { name: "Override for READ-002's max-lines-per-file threshold", numeric: true },
  // #512 (part of #500 phase 1) -- a unit's filename should carry its layer as a suffix
  // (Name.layer.ext, e.g. AddWidget.domain.ts) matching the folder it lives in (the hook
  // layer splits further into .provider.ts/.state.ts/.hook.ts per which factory the file
  // calls, per #499's design) -- a cheap string-match check, no tsc/AST pass needed, so it
  // can run live on every keystroke. The route layer is exempt (its filename is
  // framework-dictated, not something Construct's convention is free to rename) and is
  // naturally never reached here anyway, since validateReadability only walks
  // features/*/**, never app/**/page.tsx or src/App.tsx.
  //
  // Default severity is 'off', same reasoning as DOMAIN-002 above: every existing fixture
  // in this repo (fixtures/architecture-valid*, fixtures/frozen-presentation) and this
  // project's own packages/core/typed-contracts/ file names predate this convention and
  // would ALL fail it if defaulted to 'error' or even 'warning' -- a silent default bump
  // is exactly the non-additive breakage #500 phase 1 rules out. `construct create` is
  // expected to emit this convention automatically going forward; a project opts in to
  // enforcing it on hand-written/legacy files with `rules: { READ-004: warning }` (or
  // 'error') in architecture.yml once it's ready to rename its own files.
  'READ-004': { severity: 'off', name: 'A unit\'s filename encodes its layer as a suffix (Name.layer.ext)' },
  // #495 -- a real TypeScript type-check (the project's own node_modules/typescript, `tsc
  // --noEmit -p tsconfig.json`; packages/core/type-check.mjs), because an --llm fill can produce code
  // that parses and matches its layer but does not compile (#490: `Cannot find name 'useRef'`),
  // which neither the rule engine nor a transpile-only `vite build` catches. Default severity is
  // 'off', same reasoning as DOMAIN-002/READ-004 above: it spawns tsc (seconds, not the
  // millisecond string/AST checks) and would fail any project or fixture that has type errors or
  // no TypeScript, so it is strictly opt-in: `rules: { TYPE-001: error }` in architecture.yml, or
  // an options object `{ severity: error, tsconfig: tsconfig.app.json, timeoutMs: 120000 }`.
  'TYPE-001': { severity: 'off', name: 'Code must type-check (a real tsc --noEmit run with the project\'s own TypeScript)' },
  'IMPORT-001': { severity: 'error', name: 'Relative imports must resolve to a file that exists' },
  'EXCEPTION-EXPIRED': { severity: 'warning', name: 'Time-boxed exceptions must be renewed or removed once they expire' },
  // #473 -- cross-references a component's declared props (react-docgen) against every real JSX
  // call site of it in the project (src/engine/propLinks.mjs). Ships at 'info' by owner decision
  // (2026-09-22): a real, worth-seeing gap, never a hard validation failure. A project may still
  // raise or silence it like any other rule.
  'PROP-LINK': { severity: 'info', name: 'A required prop is never passed at some call site, or a call site passes an undeclared prop' },
};

/**
 * Rules that ship OFF in `DEFAULT_RULES` (so an existing project's result never changes) but that
 * `construct init` scaffolds at a real severity in a NEW project's `architecture.yml`.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const NEW_PROJECT_RULE_SEVERITIES = Object.freeze({ 'CLIENT-001': 'error' });

const VALID_SEVERITIES = new Set(['error', 'warning', 'info', 'off']);

// Plain Levenshtein edit distance, used only to produce "did you mean" hints.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function closestRuleId(unknownId, knownIds) {
  const upper = unknownId.toUpperCase();
  let best = null;
  let bestScore = Infinity;
  for (const id of knownIds) {
    // Prefer substring relationships (typo'd suffix/prefix) over raw distance.
    const substringBonus = id.toUpperCase().includes(upper) || upper.includes(id.toUpperCase()) ? -2 : 0;
    const score = levenshtein(upper, id.toUpperCase()) + substringBonus;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

function usageError(message) {
  return new ConstructError(message, { exitCode: EXIT_CODES.USAGE_ERROR });
}

/**
 * Merge and validate a user-supplied `rules` map from architecture.yml
 * against DEFAULT_RULES. Throws a ConstructError (USAGE_ERROR) with a
 * "did you mean" suggestion for unknown rule ids, and for invalid severities.
 */
export function normalizeRules(userRules, defaults = DEFAULT_RULES) {
  const knownIds = Object.keys(defaults);
  const merged = { ...defaults };
  for (const [ruleId, value] of Object.entries(userRules || {})) {
    if (!(ruleId in defaults)) {
      const suggestion = closestRuleId(ruleId, knownIds);
      throw usageError(
        `Unknown rule '${ruleId}' in architecture.yml` + (suggestion ? ` — did you mean '${suggestion}'?` : ''),
      );
    }
    const base = defaults[ruleId];
    let entry;
    // A `numeric: true` default (e.g. 'READ-002-max-loc') is a threshold override, not a
    // severity-bearing rule — a bare number is its valid shape, and it's exempt from the
    // severity-string/options-object/VALID_SEVERITIES checks below entirely.
    if (base.numeric && typeof value === 'number') {
      merged[ruleId] = { ...base, value };
      continue;
    }
    if (typeof value === 'string') {
      entry = { ...base, severity: value };
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      entry = { ...base, ...value };
    } else {
      throw usageError(
        base.numeric
          ? `Invalid configuration for '${ruleId}' in architecture.yml — expected a number.`
          : `Invalid configuration for rule '${ruleId}' in architecture.yml — expected a severity string or an options object.`,
      );
    }
    if (!VALID_SEVERITIES.has(entry.severity)) {
      throw usageError(
        `Invalid severity '${entry.severity}' for rule '${ruleId}' in architecture.yml — expected one of: error, warning, off.`,
      );
    }
    merged[ruleId] = entry;
  }
  return merged;
}

/**
 * Walk up from `startDir` looking for the nearest `architecture.yml`,
 * stopping at the filesystem root. Returns the containing directory, or
 * null if none is found. Supports monorepos where a subpackage has no
 * config of its own and should inherit the parent's.
 *
 * @param {string} startDir Directory to start from.
 * @returns {string|null} The nearest ancestor directory (or `startDir` itself) that holds an `architecture.yml`, or `null` when there is none.
 * @since 0.8
 *
 * @example
 * findProjectRoot('/work/app/features/plan'); // => '/work/app'
 */
export function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'architecture.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Read the raw, unvalidated `rules` map from architecture.yml (or `{}` if the file is
 * missing or malformed) — for a caller that needs an ad-hoc threshold value under a key
 * that isn't a normalized rule id in DEFAULT_RULES (e.g. readability-enforcer.mjs's
 * `READ-002-max-loc: <number>` override), without going through normalizeRules' strict
 * id/severity-shape validation (which only accepts a severity string or an options
 * object per key — not a bare number). Everything that *is* a real rule id should go
 * through loadConfig()/normalizeRules instead; this exists specifically so that escape
 * hatch doesn't force every non-rule config knob through the same strict shape. */
export function readRawRules(root) {
  const file = path.join(root, 'architecture.yml');
  if (!fs.existsSync(file)) return {};
  try {
    const c = yaml.load(fs.readFileSync(file, 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? (c.rules || {}) : {};
  } catch {
    return {};
  }
}

/**
 * Load and normalize a project's `architecture.yml`. A missing file yields the built-in defaults (strict Next.js preset); a present one is merged over them: rules are normalized to severities, the layer graph is chosen from `project.framework` and merged with any `layers:` override (`normalizeLayers`; #699 — it used to be silently discarded here), and `frozen` / `nonLayer` globs are normalized.
 *
 * @param {string} root Project root that contains (or should contain) `architecture.yml`.
 * @returns {{version:number, preset:string, project:object, features:{root:string}, layers:object, rules:object, exceptions:object[], frozen:string[], nonLayer:string[]}} The effective configuration.
 * @throws {Error} A usage error when the file is not valid YAML or is not a mapping at the top level.
 * @since 0.8
 *
 * @example
 * const config = loadConfig(process.cwd());
 * config.rules['PAGE-001'].severity; // => 'error' unless architecture.yml overrides it
 */
export function loadConfig(root) {
  const file = path.join(root, 'architecture.yml');
  if (!fs.existsSync(file)) {
    return {
      version: 1,
      preset: 'strict-nextjs',
      project: { framework: DEFAULT_FRAMEWORK, dataLayer: { provider: DEFAULT_DATA_LAYER_PROVIDER }, execution: { mode: DEFAULT_EXECUTION_MODE } },
      features: { root: 'features' },
      traces: DEFAULT_TRACES,
      decision: { ...DEFAULT_DECISION },
      layers: DEFAULT_LAYERS,
      rules: DEFAULT_RULES,
      exceptions: [],
      frozen: [],
      nonLayer: [],
    };
  }

  let c;
  try {
    c = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  } catch (e) {
    throw usageError(`Failed to parse architecture.yml: ${e.message}`);
  }
  if (typeof c !== 'object' || Array.isArray(c)) {
    throw usageError('architecture.yml must be a YAML mapping (object) at the top level.');
  }

  const rules = normalizeRules(c.rules, DEFAULT_RULES);
  const framework = normalizeFramework(c.project?.framework);
  const dataLayerProvider = normalizeDataLayerProvider(c.project?.dataLayer?.provider);
  const executionMode = normalizeExecutionMode(c.project?.execution?.mode);

  return {
    version: 1,
    preset: 'strict-nextjs',
    ...c,
    project: {
      ...(c.project || {}),
      framework,
      dataLayer: { ...(c.project?.dataLayer || {}), provider: dataLayerProvider },
      execution: { ...(c.project?.execution || {}), mode: executionMode },
    },
    features: { root: 'features', ...(c.features || {}) },
    traces: normalizeTraces(c.traces),
    decision: normalizeDecision(c.decision),
    layers: normalizeLayers(c.layers, framework),
    rules,
    exceptions: c.exceptions || [],
    frozen: normalizeFrozen(c.frozen),
    nonLayer: normalizeNonLayer(c.nonLayer),
  };
}
