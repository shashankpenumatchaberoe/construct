import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { makeLineSource } from './line-source.mjs';
import { createFeature, ensureFeatureExists, generateLayer, generateVertical, layerFromGeneratedFile, fillGeneratedFile } from './generators.mjs';
import { generateServiceFromSpec, resolveSchemaEmit } from './service-generator.mjs';
import { generateShapeLayer, generateShapeVertical } from './shapes.mjs';
import { ensureGeneratedDependencies } from './generated-dependencies.mjs';
import { write, ensureDir } from './fs.mjs';
import { scaffoldProject } from './scaffold.mjs';
import { loadConfig, findProjectRoot, DEFAULT_RULES, NEW_PROJECT_RULE_SEVERITIES, normalizeFramework } from './config.mjs';
import { formatReport, exitCodeForViolations, ConstructError, EXIT_CODES, setExitCode } from './diagnostics.mjs';
import { aggregateValidation } from './registry.mjs';
import { validateArchitecture } from './architecture-enforcer.mjs';
import { syncPublicApi } from './api-composer.mjs';
import { summarizeUnit, listUnits, unitApiManifest, renderUnitMarkdown } from '../../packages/engine/unitSummary.mjs';
import { analyzeImpact, proposeSeedsFromText, impactApiManifest, renderImpactMarkdown } from '../../packages/engine/impact.mjs';
import { loadTemplateDir, TemplateError } from '../../packages/engine/planTemplate.mjs';
import { prHealth, renderPrHealthMarkdown, prHealthApiManifest } from '../../packages/engine/prHealth.mjs';
import { summarizeProject, summarizeCompact, summarizeProse, summarizeSince } from './summarize.mjs';
import { summarizeBackend, renderBackendText, resolveBackendDir } from './backend-summary.mjs';
import { moveLayerFile, renameLayerFile } from './refactor.mjs';
import { extractExpression } from './extractExpression.mjs';
import { importVertical, importPlan, analyzeFiles, executeImportPlan, autoFixViolations } from './import.mjs';
import { planMechanically } from './mechanical-plan.mjs';
import { reviewImport } from './import-review.mjs';
import { repairRelativeImports } from './import-repair.mjs';
import { resolveRoute } from './route-resolver.mjs';
import { DEFAULT_ENFORCERS } from '../../packages/engine/defaultEnforcers.mjs';
import { runPipeline } from '../../packages/engine/pipeline.mjs';
import { validateEnvelope } from '../../packages/engine/envelope.mjs';
import { ingestPage } from '../../packages/engine/pageTransformer.mjs';
import { generateWorkflow } from '../../packages/engine/workflowGenerator.mjs';
import { generateController } from '../../packages/engine/controllerBinder.mjs';
import { generateFeatureTests } from '../../packages/engine/testGenerator.mjs';
import { generateUnitTests } from '../../packages/engine/testUnitGenerator.mjs';
import { runFeatureTests, renderRunText } from '../../packages/engine/testRunner.mjs';
import { runProofs, renderProofRunText } from '../../packages/engine/proofRunner.mjs';
import { generateProof } from './proof.mjs';
import { generateRouteEntry, addDependency } from './wiring.mjs';
import { addEnv } from './env.mjs';
import { generateGuard } from './guard.mjs';
import { generateStore, STORE_ACTIONS } from './store.mjs';
import { generateHandler } from './handler.mjs';
import { wrapProvider, providerOffer } from './provider-wrap.mjs';
import { buildDiffView } from './text-diff.mjs';
import { runTypesCheck, runBuildCheck, renderCheckText, checkExitCode } from '../../packages/engine/verifyRunner.mjs';
import { startTimer, elapsedSeconds, formatDuration } from './timing.mjs';
import { explainSource, renderExplained } from '../../packages/engine/workflowExplain.mjs';
import { listWorkflowSourceFiles, readWorkflowSource } from '../../packages/engine/workflowSource.mjs';
import { validateMachineSpec, renderMachineSpecReport } from './research/machine-spec.mjs';
import { generateFromSpec } from './research/specToCode.mjs';
import { readBackMachineSpec, renderReadBack } from './research/readBack.mjs';
import { coverageOfMachineSpec, renderCoverage, uncoveredSentences, COVERAGE_TOLERATED_RULES } from './research/coverage.mjs';
import { readTraces } from './decision-trace-store.mjs';
import { providerInput, getDecisionProvider, registerDecisionProvider } from './decision-provider.mjs';
import { loadDecisionPlugin } from './decision-plugin.mjs';
import { openDecision, suggestForQuestions } from './decision-project.mjs';
import { detectMachine, buildMachineReport, renderMachineText, defaultProbes as defaultMachineProbes } from './machine.mjs';
import { parseRequirement, openQuestion } from './requirement-card.mjs';
import { placeCard } from './placement.mjs';
import { traceStats, replayTraces, renderTraceList, renderTraceStats, renderReplay, DEFAULT_MIN_TRACES } from './decision-trace-replay.mjs';
import { exportDataset, renderExport } from './decision-dataset.mjs';
import { importModel, listModels, removeModel, setModelEnabled, loadRegisteredModelProvider, unseenByModel, renderImport, renderModelList } from './decision-model-registry.mjs';

// Resolve the project root freshly per command: walks up from cwd (or from
// --dir, when given) to find an existing architecture.yml (monorepo
// support), falling back to that starting directory itself (e.g. for
// `construct init`, or a project that hasn't been synced yet). --dir lets a
// command target a Construct project nested in a subdirectory of a larger,
// unrelated project without requiring the caller to `cd` into it first.
function getRoot(args = []) {
  const di = args.indexOf('--dir');
  if (di >= 0 && args[di + 1]) {
    const dir = path.resolve(args[di + 1]);
    return findProjectRoot(dir) ?? dir;
  }
  return findProjectRoot(process.cwd()) ?? process.cwd();
}

// The Construct package's own install directory (not the target project's
// cwd) — enforcer modules live alongside this file, not in the user's repo.
const packageRoot = path.dirname(fileURLToPath(import.meta.url));

// Files that mark a module as "available" for construct doctor. These are
// existence checks only (never imports), so they report accurately even
// before the owning module has landed in the working tree.
const ENFORCER_MODULES = [
  { name: 'architecture-enforcer', file: 'architecture-enforcer.mjs' },
  { name: 'soc-enforcer', file: 'soc-enforcer.mjs' },
  { name: 'api-composer', file: 'api-composer.mjs' },
  { name: 'readability-enforcer', file: 'readability-enforcer.mjs' },
  { name: 'summarize', file: 'summarize.mjs' },
];

const INIT_HELP = `Usage: construct init [dir] [--framework nextjs|react-spa] [--no-scaffold]

Writes architecture.yml, AGENTS.md, the core feature and the framework's entry file(s).
Also lays down a minimal runnable project shell (package.json with dev/build scripts,
tsconfig.json, bundler config, .gitignore) so \`npm install && npm run dev\` works next.
Static files only: no network, no npm install. An existing file is never overwritten.

  --framework <name>  nextjs (default) | react-spa
  --no-scaffold       skip the project shell; write only the Construct files`;

// `construct init [dir] [--framework nextjs|react-spa]` — the entry-point
// scaffold this writes is the one genuinely framework-specific part of
// init: nextjs gets a physical app/page.tsx (Next.js's own file-system
// routing); react-spa gets src/main.tsx (the real Vite/CRA-style bootstrap
// entry) + src/App.tsx (the centralized react-router table #65/#66/#67
// treat as that framework's "route" layer) with the core feature's
// controller actually registered in it — not just a page.tsx clone. Framework
// defaults to nextjs when --framework is omitted, so every existing caller
// of `construct init` keeps getting exactly what it got before.
/**
 * `construct init [dir] [--framework nextjs|react-spa] [--no-scaffold]`: write `architecture.yml` and `AGENTS.md`, then scaffold the `core` feature, then (unless `--no-scaffold`) a minimal runnable project shell that never overwrites an existing file (#497). The entry-point scaffold is the one framework-specific part: `nextjs` (the default) gets `app/page.tsx`; `react-spa` gets `src/main.tsx` and `src/App.tsx` with the core controller registered in the router table.
 *
 * @param {string[]} args Command arguments: an optional target directory, then optional `--framework <name>`.
 * @returns {Promise<void>} Resolves once the files are written (prints what it wrote).
 * @since 0.8
 *
 * @example
 * await init(['my-app', '--framework', 'react-spa']);
 */
export async function init(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(INIT_HELP);
    return;
  }
  const dir = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
  const fi = args.indexOf('--framework');
  const framework = normalizeFramework(fi >= 0 ? args[fi + 1] : undefined);
  ensureDir(dir);
  // Only real severity-bearing rules get a scaffolded `<id>: <severity>` line — a
  // numeric-override entry like READ-002-max-loc (see config.mjs's DEFAULT_RULES) has
  // no severity to print and is left out entirely; the project inherits its default
  // (200) until someone opts into an override themselves.
  const arch = `version: 1\npreset: strict-nextjs\n\nproject:\n  framework: ${framework}\n  language: typescript\n\nfeatures:\n  root: features\n\nrules:\n${Object.entries(DEFAULT_RULES).filter(([, v]) => !v.numeric).map(([k, v]) => `  ${k}: ${NEW_PROJECT_RULE_SEVERITIES[k] ?? v.severity}`).join('\n')}\n\nexceptions: []\n`;
  write(path.join(dir, 'architecture.yml'), arch);
  write(path.join(dir, 'AGENTS.md'), `# Construct\n\nRead architecture.yml before changing code.\n\nDefault flow: Route → Controller → Workflow → Service → API; Controller → Page → Component.\n\nPages: no business logic, workflows, services, API calls, or fetch.\nComponents: presentation/local UI state only.\nFeatures: isolated; cross-feature access goes through index.ts.\nDomain: pure by default. Services: external effects.\n\nRun \`construct validate\` before finishing changes.\n`);
  createFeature(dir, 'core');
  if (framework === 'react-spa') {
    ensureDir(path.join(dir, 'src'));
    write(
      path.join(dir, 'src', 'main.tsx'),
      `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport { BrowserRouter } from 'react-router-dom';\nimport { App } from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <BrowserRouter>\n      <App />\n    </BrowserRouter>\n  </React.StrictMode>,\n);\n`,
    );
    write(
      path.join(dir, 'src', 'App.tsx'),
      `import { Routes, Route } from 'react-router-dom';\nimport { CoreController } from '../features/core/controllers/CoreController';\n\nexport function App() {\n  return (\n    <Routes>\n      <Route path="/" element={<CoreController />} />\n    </Routes>\n  );\n}\n`,
    );
  } else {
    ensureDir(path.join(dir, 'app'));
    write(path.join(dir, 'app', 'page.tsx'), `import { CoreController } from '../features/core/controllers/CoreController';\n\nexport default function Page() {\n  return <CoreController />;\n}\n`);
  }
  console.log(`Initialized Construct in ${dir} (framework: ${framework})`);
  // #497: a runnable project shell (package.json, tsconfig, bundler config, ...) unless --no-scaffold.
  if (args.includes('--no-scaffold')) return;
  const { written, skipped } = scaffoldProject(dir, framework);
  if (written.length) console.log(`Scaffolded ${written.length} project file(s): ${written.join(', ')}`);
  if (skipped.length) console.log(`Kept existing (not overwritten): ${skipped.join(', ')}`);
  if (written.includes('package.json')) {
    const rel = path.relative(process.cwd(), dir);
    console.log(`Next: ${rel ? `cd ${/\s/.test(rel) ? JSON.stringify(rel) : rel} && ` : ''}npm install && npm run dev`);
  } else {
    console.log('Next: add the dependencies your framework needs to your existing package.json, then run your dev script.');
  }
  console.log('Note: the entry file imports features/core/controllers/CoreController, which does not exist yet; generate it (construct generate layer core --feature core --layers domain,service,workflow,hook,component,page,controller) or `construct validate` and the dev server will report the unresolved import.');
}

export async function feature(args) {
  if (args[0] !== 'create' || !args[1]) {
    throw new ConstructError('Usage: construct feature create <name>', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const root = getRoot(args);
  const t = startTimer();
  const p = createFeature(root, args[1]);
  console.log(`Created feature ${args[1]} at ${path.relative(root, p)} (${formatDuration(elapsedSeconds(t))})`);
}

// Ticket 7.2/7.3/7.4/7.5's `--from`/`--bind`/`--openapi` paths below are all
// zero-LLM: they compile a real input (JSX export, JSON state graph, an
// already-generated Props interface, an OpenAPI spec) deterministically via
// the packages/engine/* modules or service-generator.mjs. `--llm <provider>`
// (optional, mirrors `construct import`'s flag) only applies to the plain
// fallback path at the bottom of this function: when given, it calls that
// provider once to write a real implementation in place of the template
// stub — scoped strictly to that one file's own body (generators.mjs's
// fillGeneratedFile). Which layers/files get created is decided the exact
// same deterministic way regardless of --llm; the flag only changes what
// ends up *inside* a file generate() was already going to create via the
// plain stub path. Omitting --llm leaves the scaffolded template stub
// exactly as before this existed.
// #348: `construct generate tests <feature> [--dry-run] [--prune]` writes one LOCKED Playwright spec per
// workflow scenario into features/<feature>/tests/generated/ (see engine/testGenerator.mjs).
// #583: `--unit` writes one LOCKED every-path unit test per machine instead (engine/testUnitGenerator.mjs):
// @xstate/graph walks the machine under node's test runner, no browser.
function generateTests(args) {
  const feature = args.slice(1).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--dir');
  if (!feature) {
    throw new ConstructError('Usage: construct generate tests [--unit] <feature> [--dry-run] [--prune] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const root = getRoot(args);
  const t = startTimer();
  const dry = args.includes('--dry-run') ? ' (dry run, nothing written)' : '';
  if (args.includes('--unit')) {
    const r = generateUnitTests(root, feature, { dryRun: args.includes('--dry-run'), prune: args.includes('--prune') });
    for (const f of r.written) console.log(`Wrote ${f}${dry}`);
    for (const f of r.unchanged) console.log(`Unchanged ${f}`);
    for (const f of r.pruned) console.log(`Pruned ${f}${dry}`);
    for (const f of r.orphans.filter((o) => !r.pruned.includes(o))) console.log(`Orphan ${f} (no machine produces it any more; --prune removes it)`);
    for (const sk of r.skipped) console.log(`Skipped machine "${sk.machine}" in ${sk.file}: ${sk.reason}`);
    const sum = r.files.reduce((n, f) => n + f.transitions, 0);
    console.log(`${r.files.length} every-path test(s) for feature "${feature}" (${r.written.length} written, ${r.unchanged.length} unchanged; ${sum} transition(s) checked) (${formatDuration(elapsedSeconds(t))})`);
    if (r.missingDependencies.length) console.log(`Note: the test needs ${r.missingDependencies.join(', ')} in this project: npm install -D ${r.missingDependencies.join(' ')}`);
    if (r.files.length) console.log(`Run: npx tsx --test ${r.files.map((f) => f.relPath).join(' ')}`);
    return;
  }
  const r = generateFeatureTests(root, feature, { dryRun: args.includes('--dry-run'), prune: args.includes('--prune') });
  for (const f of r.written) console.log(`Wrote ${f}${dry}`);
  for (const f of r.unchanged) console.log(`Unchanged ${f}`);
  for (const f of r.pruned) console.log(`Pruned ${f}${dry}`);
  for (const f of r.orphans.filter((o) => !r.pruned.includes(o))) console.log(`Orphan ${f} (no scenario produces it any more; --prune removes it)`);
  for (const sk of r.skipped) console.log(`Skipped machine "${sk.machine}" in ${sk.file}: ${sk.reason}`);
  if (r.truncated) console.log('Note: a machine has more scenarios than the enumeration limit; only the first were generated.');
  const todo = r.files.filter((f) => f.needs.length).length;
  console.log(`${r.files.length} spec(s) for feature "${feature}" (${r.written.length} written, ${r.unchanged.length} unchanged; ${todo} pending a fixture), start URL ${r.route ?? 'TODO (no route reaches this feature)'} (${formatDuration(elapsedSeconds(t))})`);
  // #678 sweep: a generated spec bare-imports @playwright/test; --dry-run writes nothing to check.
  if (!args.includes('--dry-run') && r.written.length) reportGeneratedDependencies(root, r.written.map((f) => path.join(root, f)));
}

/**
 * The `--shape <name> [--entity <Entity>] [--fields a:string,b:number] [--source local|endpoint|openapi]` request of a create/generate command
 * (#619, #621), or `null` when no shape was asked for. `--entity`, `--fields` and `--source` mean nothing without `--shape`, and a shape
 * is deterministic, so `--llm` is refused. No `--source` is `endpoint`, what a shaped unit has always been.
 */
function shapeRequestOf(args, name, feature) {
  const shape = flagValue(args, '--shape');
  if (shape === undefined) {
    const stray = ['--entity', '--fields', '--source', '--steps', '--states'].find((f) => args.includes(f));
    if (stray) throw new ConstructError(`${stray} only applies with --shape, for example --shape list (or detail, form, dashboard, wizard).`, { exitCode: EXIT_CODES.USAGE_ERROR });
    return null;
  }
  if (args.includes('--llm')) throw new ConstructError('--shape writes real code from typed templates with no model, so it cannot be combined with --llm. Run it without --llm.', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { shape, name, feature, entity: flagValue(args, '--entity'), fields: flagValue(args, '--fields'), source: flagValue(args, '--source'), steps: flagValue(args, '--steps'), states: flagValue(args, '--states') };
}

/** One output line per file a shape wrote: `types.ts` is appended to (`Updated`), every other file is new (`Created`). */
const shapeLine = (root, file, dt) => `${path.basename(file) === 'types.ts' ? 'Updated' : 'Created'} ${path.relative(root, file)} (${dt})`;

/**
 * After a generator writes files (#678: the shape flow's typed-contracts import, and any other generator that
 * emits a bare import), declare whatever package.json does not already have via the existing `add.dependency`
 * flow, and print what happened: one line per dependency actually added (idempotent -- an already-present one is
 * left alone and prints nothing), then a note for anything this module could not place itself (see
 * generated-dependencies.mjs's doc comment for why: no known version, or a dev-only tool `add.dependency` cannot
 * yet target `devDependencies` for).
 */
function reportGeneratedDependencies(root, files) {
  const { added, notes } = ensureGeneratedDependencies(root, files);
  for (const dep of added) {
    console.log(`Added ${dep.line} to package.json (dependencies): the generated units import it. Nothing is installed: run your package manager.`);
    // #678: @line/construct-core is not on the public npm registry (packages/core/package.json's publishConfig
    // points at a restricted GitHub Packages registry) -- say so right where the line was just added, not just in the README.
    if (dep.name === '@line/construct-core') console.log('  Note: @line/construct-core publishes to a restricted GitHub Packages registry, not the public npm registry -- see README "Typed contracts", "Installing @line/construct-core" for the supported install paths (org access + .npmrc, or vendor packages/core/typed-contracts/).');
  }
  for (const note of notes) console.log(`Note: ${note}`);
}

/**
 * The request of `construct create proof <Name> --feature <f> [--shape list|detail|form|dashboard|wizard] [--entity <E>] [--fields a:string,...] [--kind render|playwright] [--route </path>]` (#623).
 * A proof is deterministic like the shape it proves, so `--llm` is refused.
 */
function proofRequestOf(args) {
  const name = args[1];
  const feature = flagValue(args, '--feature');
  if (!name || name.startsWith('--') || !feature) throw new ConstructError('Usage: construct create proof <Name> --feature <feature> [--shape list|detail|form|dashboard|wizard] [--entity <Entity>] [--fields id:string,...] [--source local|endpoint|openapi] [--steps a,b,c] [--states default|custom|skip-empty|skip-all] [--kind render|playwright] [--route </path>] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  if (args.includes('--llm')) throw new ConstructError('A proof is written from typed templates with no model, so it cannot be combined with --llm. Run it without --llm.', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { name, feature, shape: flagValue(args, '--shape'), entity: flagValue(args, '--entity'), fields: flagValue(args, '--fields'), source: flagValue(args, '--source'), steps: flagValue(args, '--steps'), states: flagValue(args, '--states'), kind: flagValue(args, '--kind'), route: flagValue(args, '--route') };
}

/** `construct create proof <Name> --feature <f> ...` (#623): write the locked proof of a shaped screen, or say why nothing was written. */
function generateProofFiles(args) {
  const root = getRoot(args);
  const t = startTimer();
  const request = proofRequestOf(args);
  const result = generateProof(root, request);
  const dt = formatDuration(elapsedSeconds(t));
  for (const key of result.regions) console.log(`Updated architecture.yml (declared ${key}: for the generated tests)`);
  for (const file of result.files) console.log(`Created ${path.relative(root, file)} (${dt})`);
  if (result.skipped) console.log(`Skipped: ${result.skipped}`);
  else if (result.kind === 'render') console.log(`Needs ${result.needs.join(', ')} in the project (esbuild comes with tsx and with vite). Run: construct test proof ${request.feature}`);
  else console.log(`Run it against your running app: construct test run ${request.feature} --area generated`);
  // #678 sweep: a playwright-kind proof bare-imports @playwright/test.
  if (!result.skipped) reportGeneratedDependencies(root, result.files);
}

/** The result document of `create proof` for `--format json`: the files written (project-relative), the regions declared and why anything was skipped. */
function proofDocument(args, attribution) {
  const root = getRoot(args);
  const request = proofRequestOf(args);
  const result = generateProof(root, request);
  return { verb: 'create', kind: 'proof', feature: request.feature, name: request.name, proofKind: result.kind, files: result.files.map((f) => path.relative(root, f)), regions: result.regions, skipped: result.skipped, needs: result.needs, attribution };
}

/** The request of `construct create route <Name> --feature <f> [--route </path>]` (#654): wire the controller of a generated screen into the route entry. No model, so `--llm` is refused. */
function routeRequestOf(args) {
  const name = args[1];
  const feature = flagValue(args, '--feature');
  if (!name || name.startsWith('--') || !feature) throw new ConstructError('Usage: construct create route <Name> --feature <feature> [--route </path>] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  if (args.includes('--llm')) throw new ConstructError('The route entry is written from a fixed template with no model, so it cannot be combined with --llm. Run it without --llm.', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { name, feature, route: flagValue(args, '--route') };
}

/** `construct create route <Name> --feature <f>` (#654): point the project's route entry at the controller, or say there was nothing to do. */
function generateRouteFiles(args) {
  const root = getRoot(args);
  const t = startTimer();
  const request = routeRequestOf(args);
  const result = generateRouteEntry(root, request);
  const dt = formatDuration(elapsedSeconds(t));
  for (const id of result.removed) console.log(result.framework === 'react-spa' ? `Removed the dangling import of ${id} from ${result.file}` : `Removed ${id} (the init scaffold's page, which rendered a controller that was never generated)`);
  console.log(result.changed ? `${result.framework === 'react-spa' ? 'Updated' : 'Created'} ${result.file} (${dt}): ${result.route} renders ${request.name}Controller` : `Unchanged ${result.file}: ${result.route} already renders ${request.name}Controller`);
}

/** The result document of `create route` for `--format json`. */
function routeDocument(args, attribution) {
  const root = getRoot(args);
  const request = routeRequestOf(args);
  const result = generateRouteEntry(root, request);
  return { verb: 'create', kind: 'route', feature: request.feature, name: request.name, route: result.route, framework: result.framework, files: result.changed ? [result.file] : [], removed: result.removed, attribution };
}

/** The request of `construct create dependency <package> --version <range>` (#654): one line in package.json, no package manager. */
function dependencyRequestOf(args) {
  const name = args[1];
  const version = flagValue(args, '--version');
  if (!name || name.startsWith('--') || !version) throw new ConstructError('Usage: construct create dependency <package> --version <range> [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { name, version };
}

/** `construct create dependency @line/construct-core --version ^0.9.0` (#654): add the line to package.json; never installs. */
function generateDependencyLine(args) {
  const result = addDependency(getRoot(args), dependencyRequestOf(args));
  console.log(result.changed ? `Updated ${result.file}: added ${result.line} to dependencies. Nothing is installed: run your package manager.` : `Unchanged ${result.file}: ${result.line.split(':')[0]} is already a dependency.`);
}

/** The result document of `create dependency` for `--format json`. */
function dependencyDocument(args, attribution) {
  const result = addDependency(getRoot(args), dependencyRequestOf(args));
  return { verb: 'create', kind: 'dependency', line: result.line, files: result.changed ? [result.file] : [], attribution };
}

/** The request of `construct create env <NAME> --scope server|public [--value <placeholder>] [--comment <line>]` (#632): one variable in .env.example, no model. */
function envRequestOf(args) {
  const name = args[1];
  const scope = flagValue(args, '--scope');
  if (!name || name.startsWith('--') || !scope) throw new ConstructError('Usage: construct create env <NAME> --scope server|public [--value <placeholder>] [--comment <line>] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  if (args.includes('--llm')) throw new ConstructError('An environment variable is written from a fixed template with no model, so it cannot be combined with --llm. Run it without --llm.', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { name, scope, value: flagValue(args, '--value'), comment: flagValue(args, '--comment') };
}

/** `construct create env STRIPE_SECRET_KEY --scope server` (#632): add the variable to .env.example with a placeholder and a comment; never a real value. */
function generateEnvLine(args) {
  const result = addEnv(getRoot(args), envRequestOf(args));
  console.log(result.changed ? `${result.created ? 'Created' : 'Updated'} ${result.file}: added ${result.line}` : `Unchanged ${result.file}: ${result.variable} is already listed.`);
  if (result.warning) console.log(`Warning: ${result.warning}`);
}

/** The result document of `create env` for `--format json`. */
function envDocument(args, attribution) {
  const result = addEnv(getRoot(args), envRequestOf(args));
  return { verb: 'create', kind: 'env', variable: result.variable, line: result.line, files: result.changed ? [result.file] : [], warning: result.warning, attribution };
}

/** The request of `construct create guard <Name> --feature <f> --access public|signed-in|role [--roles a,b] [--redirect </path>] [--route </path>]` (#629): who may open a screen. No model, so `--llm` is refused. */
function guardRequestOf(args) {
  const name = args[1];
  const feature = flagValue(args, '--feature');
  const access = flagValue(args, '--access');
  if (!name || name.startsWith('--') || !feature || !access) throw new ConstructError('Usage: construct create guard <Name> --feature <feature> --access public|signed-in|role [--roles a,b] [--redirect </path>] [--route </path>] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  if (args.includes('--llm')) throw new ConstructError('A route guard is written from fixed templates with no model, so it cannot be combined with --llm. Run it without --llm.', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { name, feature, access, roles: flagValue(args, '--roles'), redirect: flagValue(args, '--redirect'), route: flagValue(args, '--route') };
}

/** `construct create guard Products --feature shop --access signed-in` (#629): write the guard, wire it to the route and write its proof; `public` writes nothing and says so. */
function generateGuardFiles(args) {
  const root = getRoot(args);
  const t = startTimer();
  const request = guardRequestOf(args);
  const result = generateGuard(root, request);
  const dt = formatDuration(elapsedSeconds(t));
  if (result.noop) console.log(result.notes[0]);
  else if (!result.changed) console.log(`Unchanged: the ${request.name} screen is already guarded (${request.access}).`);
  else {
    for (const file of result.files) console.log(`${file === result.route || file === 'architecture.yml' || file.endsWith('types.ts') || file.endsWith('index.ts') ? 'Updated' : 'Created'} ${file}${file === result.files[0] ? ` (${dt})` : ''}`);
    console.log(`Guarded ${result.route}: ${request.name}GuardController wraps ${request.name}Controller (access ${request.access}). Run: construct test proof ${request.feature}`);
  }
  for (const note of result.noop || !result.changed ? [] : result.notes) console.log(`Note: ${note}`);
}

/** The result document of `create guard` for `--format json`. */
function guardDocument(args, attribution) {
  const root = getRoot(args);
  const request = guardRequestOf(args);
  const result = generateGuard(root, request);
  return { verb: 'create', kind: 'guard', feature: request.feature, name: request.name, access: result.access, noop: result.noop, route: result.route, session: result.session, files: result.files, notes: result.notes, attribution };
}

/** The request of `construct create store <Name> --feature <f> --shape value|list|keyed [--entity <E>] [--fields id:string,...]` (#630): shared client state on the tracked-state factory. No model, so `--llm` is refused. */
function storeRequestOf(args) {
  const name = args[1];
  const feature = flagValue(args, '--feature');
  const shape = flagValue(args, '--shape');
  if (!name || name.startsWith('--') || !feature || !shape) throw new ConstructError('Usage: construct create store <Name> --feature <feature> --shape value|list|keyed [--entity <Entity>] [--fields id:string,...] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  if (args.includes('--llm')) throw new ConstructError('A client-state store is written from fixed templates with no model, so it cannot be combined with --llm. Run it without --llm.', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { name, feature, shape, entity: flagValue(args, '--entity'), fields: flagValue(args, '--fields') };
}

/** `construct create store Cart --feature shop --shape list` (#630): write the types, the reducer, the hook and the locked proof, or say there was nothing to do. */
function generateStoreFiles(args) {
  const root = getRoot(args);
  const t = startTimer();
  const request = storeRequestOf(args);
  const result = generateStore(root, request);
  const dt = formatDuration(elapsedSeconds(t));
  if (!result.changed) console.log(`Unchanged: the ${request.name} store already exists (${request.shape}).`);
  else {
    for (const file of result.files) console.log(`${file.endsWith('types.ts') || file.endsWith('index.ts') || file === 'architecture.yml' ? 'Updated' : 'Created'} ${file}${file === result.files[0] ? ` (${dt})` : ''}`);
    console.log(`${result.hook}() returns { state, ${STORE_ACTIONS[request.shape].join(', ')} }. Run: construct test proof ${request.feature}`);
  }
}

/** The result document of `create store` for `--format json`. */
function storeDocument(args, attribution) {
  const root = getRoot(args);
  const request = storeRequestOf(args);
  const result = generateStore(root, request);
  return { verb: 'create', kind: 'store', feature: request.feature, name: request.name, shape: result.shape, hook: result.hook, files: result.files, attribution };
}

/** The request of `construct create handler <Name> --feature <f> --method GET|POST|PUT|DELETE --path /api/<x> [--service <Name>] [--entity <E>] [--fields id:string,...]` (#625): a Next.js route handler. No model, so `--llm` is refused. */
function handlerRequestOf(args) {
  const name = args[1];
  const feature = flagValue(args, '--feature');
  const method = flagValue(args, '--method');
  const routePath = flagValue(args, '--path');
  if (!name || name.startsWith('--') || !feature || !method || !routePath) throw new ConstructError('Usage: construct create handler <Name> --feature <feature> --method GET|POST|PUT|DELETE --path /api/<x> [--service <Name>] [--entity <Entity>] [--fields id:string,...] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  if (args.includes('--llm')) throw new ConstructError('A route handler is written from fixed templates with no model, so it cannot be combined with --llm. Run it without --llm.', { exitCode: EXIT_CODES.USAGE_ERROR });
  return { name, feature, method, path: routePath, service: flagValue(args, '--service'), entity: flagValue(args, '--entity'), fields: flagValue(args, '--fields') };
}

/** `construct create handler Products --feature shop --method GET --path /api/products` (#625): write app/api/<x>/route.ts, its domain unit, its service and its proof, or say there was nothing to do. */
function generateHandlerFiles(args) {
  const root = getRoot(args);
  const t = startTimer();
  const request = handlerRequestOf(args);
  const result = generateHandler(root, request);
  const dt = formatDuration(elapsedSeconds(t));
  if (!result.changed) console.log(`Unchanged: ${request.method} ${request.path} is already served by ${result.route}.`);
  else {
    for (const file of result.files) console.log(`${file.endsWith('types.ts') || file.endsWith('index.ts') || file === 'architecture.yml' ? 'Updated' : 'Created'} ${file}${file === result.files[0] ? ` (${dt})` : ''}`);
    console.log(`${request.method} ${request.path} is served by ${result.route}, delegating to ${result.service === 'in-memory' ? 'a typed in-memory service' : `the ${result.service} service`}. Run: construct test proof ${request.feature}`);
  }
}

/** The result document of `create handler` for `--format json`. */
function handlerDocument(args, attribution) {
  const root = getRoot(args);
  const request = handlerRequestOf(args);
  const result = generateHandler(root, request);
  return { verb: 'create', kind: 'handler', feature: request.feature, name: request.name, method: result.method, path: result.path, route: result.route, service: result.service, files: result.files, attribution };
}

/**
 * `construct generate <layer> <name> --feature <f>` and its siblings: one layer file, `layer <name> --layers ...` for a whole
 * slice, or `tests <feature>`. `--shape list [--entity E] [--fields a:string,...]` (#619) fills the units with real typed code for
 * a named screen shape instead of the stub template; the other forms are described where they are handled below.
 *
 * @param {string[]} args The words after `generate` (or `create`).
 * @returns {Promise<void>} Resolves once the files are written and printed.
 *
 * @example
 * await generate(['layer', 'Products', '--feature', 'shop', '--layers', 'domain,service', '--shape', 'list']);
 */
export async function generate(args) {
  if (args[0] === 'tests') return generateTests(args);
  if (args[0] === 'layer') return generateVerticalSlice(args);
  if (args[0] === 'proof') return generateProofFiles(args);
  if (args[0] === 'route') return generateRouteFiles(args);
  if (args[0] === 'dependency') return generateDependencyLine(args);
  if (args[0] === 'env') return generateEnvLine(args);
  if (args[0] === 'guard') return generateGuardFiles(args);
  if (args[0] === 'store') return generateStoreFiles(args);
  if (args[0] === 'handler') return generateHandlerFiles(args);
  const layer = args[0], name = args[1], fi = args.indexOf('--feature');
  if (!layer || !name || fi < 0 || !args[fi + 1]) {
    throw new ConstructError('Usage: construct generate <layer> <name> --feature <feature> [--openapi <spec>] [--llm <provider>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const root = getRoot(args);
  const feature = args[fi + 1];
  // #619: `--shape list` fills the unit with real, typed code for the shape instead of the stub template.
  const shaped = shapeRequestOf(args, name, feature);
  if (shaped) {
    const t = startTimer();
    const files = generateShapeLayer(root, { ...shaped, layer });
    const dt = formatDuration(elapsedSeconds(t));
    for (const file of files) console.log(shapeLine(root, file, dt));
    reportGeneratedDependencies(root, files);
    return;
  }
  // Ticket 7.2 (#112): `construct create/generate page <name> --feature <f> --from
  // <path>` ingests an externally-authored JSX file (e.g. a Subframe export) instead
  // of scaffolding the usual stub template -- see packages/engine/pageTransformer.mjs.
  const fromI = args.indexOf('--from');
  if (layer === 'page' && fromI >= 0 && args[fromI + 1]) {
    const t = startTimer();
    const { pageFile, propsFile, slots } = ingestPage(root, name, feature, args[fromI + 1]);
    const dt = formatDuration(elapsedSeconds(t));
    console.log(`Created ${path.relative(root, pageFile)} (${dt})`);
    console.log(`Created ${path.relative(root, propsFile)} (${dt}, ${slots.length} slot(s): ${slots.map((s) => s.name).join(', ') || 'none'})`);
    return;
  }
  // Ticket 7.3 (#113): `construct create/generate workflow <name> --feature <f>
  // --from <path-to-json>` compiles a JSON state-graph descriptor into an XState v5
  // machine file instead of scaffolding the usual stub template -- see
  // packages/engine/workflowGenerator.mjs. Mirrors the page ingestion --from convention.
  if (layer === 'workflow' && fromI >= 0 && args[fromI + 1]) {
    const descriptorPath = path.isAbsolute(args[fromI + 1]) ? args[fromI + 1] : path.resolve(args[fromI + 1]);
    if (!fs.existsSync(descriptorPath)) {
      throw new ConstructError(`Workflow descriptor not found: ${descriptorPath}`, { exitCode: EXIT_CODES.USAGE_ERROR });
    }
    let descriptor;
    try {
      descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    } catch (e) {
      throw new ConstructError(`Malformed workflow descriptor JSON at ${descriptorPath}: ${e.message}`, { exitCode: EXIT_CODES.USAGE_ERROR });
    }
    const t = startTimer();
    // #580: opt-in `--state-union` also emits <Name>WorkflowState.ts (typed state union + exhaustive matcher).
    const { file, events, stateFile } = generateWorkflow(root, name, feature, descriptor, { stateUnion: args.includes('--state-union') });
    console.log(`Created ${path.relative(root, file)} (${formatDuration(elapsedSeconds(t))}, ${events.length} event(s): ${events.join(', ') || 'none'})`);
    if (stateFile) console.log(`Created ${path.relative(root, stateFile)} (typed state union + exhaustive matcher)`);
    // #678 sweep: the machine file bare-imports xstate the same way a shaped unit bare-imports @line/construct-core.
    reportGeneratedDependencies(root, [file, stateFile].filter(Boolean));
    return;
  }
  // Ticket 7.4 (#114): `construct create/generate controller <name> --feature <f>
  // --bind [--envelope <path>]` auto-wires an already-generated hook (7.3) into an
  // already-generated pristine page's Props interface (7.2) via AST signature matching,
  // instead of scaffolding the usual same-named-page-only stub template. Opt-in via
  // --bind so the existing unconditional stub (and `generate layer ... --layers ...
  // controller`, which relies on it needing no prerequisite files) is unchanged.
  const bindI = args.indexOf('--bind');
  if (layer === 'controller' && bindI >= 0) {
    const envelopeI = args.indexOf('--envelope');
    let envelope;
    if (envelopeI >= 0 && args[envelopeI + 1]) {
      const envelopePath = path.isAbsolute(args[envelopeI + 1]) ? args[envelopeI + 1] : path.resolve(args[envelopeI + 1]);
      if (!fs.existsSync(envelopePath)) {
        throw new ConstructError(`Context Envelope not found: ${envelopePath}`, { exitCode: EXIT_CODES.USAGE_ERROR });
      }
      try {
        envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
      } catch (e) {
        throw new ConstructError(`Malformed Context Envelope JSON at ${envelopePath}: ${e.message}`, { exitCode: EXIT_CODES.USAGE_ERROR });
      }
    }
    const t = startTimer();
    const { file, bindings } = generateController(root, name, feature, { envelope });
    console.log(`Created ${path.relative(root, file)} (${formatDuration(elapsedSeconds(t))})`);
    for (const b of bindings) {
      console.log(`  ${b.slot} -> ${b.handler ? `${b.handler} (${b.matchType})` : 'UNMATCHED (TODO stub written)'}`);
    }
    return;
  }
  // Ticket 7.5 (#115): `construct create/generate service <name> --feature <f>
  // --openapi <spec>` compiles an OpenAPI spec into a real RTKQ injectEndpoints
  // file plus the shared transport client, instead of scaffolding the usual stub
  // template -- see packages/core/service-generator.mjs.
  const oi = args.indexOf('--openapi');
  if (layer === 'service' && oi >= 0 && args[oi + 1]) {
    const t = startTimer();
    // #575: `--schema` writes the Zod response schemas, `--no-schema` never does, neither means "when the project declares zod".
    const schema = args.includes('--no-schema') ? false : args.includes('--schema') ? true : 'auto';
    const files = await generateServiceFromSpec(root, name, feature, args[oi + 1], { schema });
    const dt = formatDuration(elapsedSeconds(t));
    for (const file of files) console.log(`Created ${path.relative(root, file)} (${dt})`);
    const zodFile = files.find((f) => f.endsWith('zod.gen.ts'));
    if (zodFile) {
      console.log(`  Response schemas: check a service at its boundary with defineService('<Op>', fn, { schema: z<Op>Response }) from ${path.relative(root, zodFile)}.`);
      // #678: --schema can force the zod plugin even when the project does not declare zod (resolveSchemaEmit(root, true) skips the
      // zodDeclared check); the emitted file bare-imports it, so declare it the same way the shape flow declares @line/construct-core.
      reportGeneratedDependencies(root, [zodFile]);
    } else if (resolveSchemaEmit(root, schema)) console.log('  No response schemas written: the spec declares no response schema.');
    else if (schema === 'auto') console.log('  Response schemas not written (zod is not in package.json); add zod, or pass --schema, to also write services/<name>/zod.gen.ts.');
    return;
  }
  // Plain fallback: scaffold the usual template stub, optionally LLM-filled
  // (see this function's own doc comment above for the --llm contract).
  const llmI = args.indexOf('--llm');
  const llm = llmI >= 0 ? args[llmI + 1] : undefined;
  const scaffoldStart = startTimer();
  const file = generateLayer(root, layer, name, feature);
  const scaffoldSeconds = elapsedSeconds(scaffoldStart);
  if (llm) {
    const llmStart = startTimer();
    const outcome = await fillGeneratedFile(root, file, layer, { feature, name, llm });
    reportFill(root, outcome, ` (scaffold ${formatDuration(scaffoldSeconds)}, llm ${formatDuration(elapsedSeconds(llmStart))})`);
  } else {
    console.log(`Created ${path.relative(root, file)} (${formatDuration(scaffoldSeconds)})`);
  }
  // #678 sweep: the plain workflow stub (and, with --llm, whatever a model wrote) can bare-import too (xstate for a workflow).
  reportGeneratedDependencies(root, [file]);
}

// One line per generated file for a --llm fill (#144/#141): "Created +
// LLM-filled" only when the model's output was actually written; otherwise
// the scaffolded stub was left as-is and the line says why. A rejected/failed
// fill sets a non-zero exit code so scripts and the UI notice, but never
// aborts the rest of a batch.
function reportFill(root, { file, status, reason, fixCommand }, timingNote = '') {
  const rel = path.relative(root, file);
  if (status === 'filled') {
    console.log(`Created + LLM-filled ${rel}${timingNote}`);
    if (fixCommand) printExtractExpressionHint(fixCommand);
    return;
  }
  const what = status === 'rejected' ? "the model's output was rejected" : 'the LLM call failed';
  console.log(`Created ${rel} (stub kept — ${what}: ${reason})${timingNote}`);
  setExitCode(EXIT_CODES.INTERNAL_ERROR);
}

// #522 -- printed right after a --llm fill whose own output trips PAGE-008/COMPONENT-005 (inline
// conditional/loop JSX): names the deterministic block (`construct refactor extract-expression`,
// packages/core/extractExpression.mjs, #517) that fixes it mechanically, so a human or a bot
// reading this output reaches for that block next instead of hand-writing the extraction.
function printExtractExpressionHint(fixCommand) {
  console.log(`  Note: the model's own output has inline conditional/loop JSX (PAGE-008/COMPONENT-005) — run \`${fixCommand}\` to extract it into a compliant Expression mechanically, rather than hand-editing.`);
}

// `construct generate layer <name> --feature <feature> --layers <l1,l2,...>
// [--llm <provider>]` scaffolds one logical unit across several layers in a
// single command, always in dependency order (see generators.mjs's
// LAYER_ORDER) regardless of the order --layers lists them in. `--llm`
// applies uniformly to every generated file in the unit, same as import's
// per-file fill does across a whole plan.
async function generateVerticalSlice(args) {
  const name = args[1], fi = args.indexOf('--feature'), li = args.indexOf('--layers');
  if (!name || fi < 0 || !args[fi + 1] || li < 0 || !args[li + 1]) {
    throw new ConstructError(
      'Usage: construct generate layer <name> --feature <feature> --layers <layer1,layer2,...> [--llm <provider>]',
      { exitCode: EXIT_CODES.USAGE_ERROR },
    );
  }
  const root = getRoot(args);
  const feature = args[fi + 1];
  const layers = args[li + 1].split(',').map((l) => l.trim()).filter(Boolean);
  const shaped = shapeRequestOf(args, name, feature);
  if (shaped) {
    const totalStart = startTimer();
    const written = generateShapeVertical(root, shaped, layers, {
      onLayer: ({ files, elapsedSeconds: dt }) => { for (const file of files) console.log(shapeLine(root, file, formatDuration(dt))); },
    });
    console.log(`Total: ${formatDuration(elapsedSeconds(totalStart))} (${written.length} file(s))`);
    reportGeneratedDependencies(root, written);
    return;
  }
  const llmI = args.indexOf('--llm');
  const llm = llmI >= 0 ? args[llmI + 1] : undefined;
  // Per-layer scaffold timing comes from generateVertical's own onLayer hook
  // (so it reflects each layer's real write, not a guess) -- the LLM fill
  // (if any) happens in this loop afterward, same as before, timed
  // separately so its cost is never hidden inside the scaffold number.
  const totalStart = startTimer();
  const scaffoldSeconds = new Map();
  const files = generateVertical(root, name, feature, layers, {
    onLayer: ({ file, elapsedSeconds: dt }) => scaffoldSeconds.set(file, dt),
  });
  for (const file of files) {
    const scaffoldDt = scaffoldSeconds.get(file) ?? 0;
    if (llm) {
      const llmStart = startTimer();
      const outcome = await fillGeneratedFile(root, file, layerFromGeneratedFile(file), { feature, name, llm });
      reportFill(root, outcome, ` (scaffold ${formatDuration(scaffoldDt)}, llm ${formatDuration(elapsedSeconds(llmStart))})`);
    } else {
      console.log(`Created ${path.relative(root, file)} (${formatDuration(scaffoldDt)})`);
    }
  }
  console.log(`Total: ${formatDuration(elapsedSeconds(totalStart))}`);
  reportGeneratedDependencies(root, files);
}

function featureNames(root, config) {
  const dir = path.join(root, config.features.root || 'features');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function sync(args) {
  const root = getRoot(args);
  const c = loadConfig(root);
  write(path.join(root, '.dependency-cruiser.cjs'), `module.exports={forbidden:[{name:'page-to-workflow',from:{path:'features/.*/pages'},to:{path:'features/.*/workflows'},severity:'error'},{name:'page-to-service',from:{path:'features/.*/pages'},to:{path:'features/.*/services'},severity:'error'},{name:'component-to-app-logic',from:{path:'features/.*/components'},to:{path:'features/.*/(controllers|workflows|services|domain)'},severity:'error'}]};\n`);
  let apiSynced = 0;
  for (const name of featureNames(root, c)) {
    const { changed } = syncPublicApi(root, name);
    if (changed) apiSynced++;
  }
  console.log(`Synced ${Object.keys(c.rules).length} Construct rules, ${apiSynced} feature public API(s) updated.`);
}

export async function validate(args) {
  const root = getRoot(args);
  const { violations, ok } = aggregateValidation(root, DEFAULT_ENFORCERS);
  const fi = args.indexOf('--format');
  const format = fi >= 0 && args[fi + 1] === 'json' ? 'json' : 'text';
  console.log(formatReport(violations, { format }));
  if (!ok) setExitCode(exitCodeForViolations(violations));
}

const UNIT_VALUE_FLAGS = new Set(['--dir', '--feature', '--format', '--since', '--kind', '--detail', '--include']);
const flagValue = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const positionalOf = (args) => args.find((a, i) => !a.startsWith('--') && !UNIT_VALUE_FLAGS.has(args[i - 1]));

/** `construct summarize <unit-ref> [--kind K] [--detail brief|standard|full] [--include a,b] [--format json|markdown]`,
 * `construct summarize --list [--kind K]`, `construct summarize --usage`. Deterministic unit summaries for bots and
 * humans (packages/engine/unitSummary.mjs); errors are structured JSON on stdout with a non-zero exit code. */
function summarizeUnitCommand(args, root, ref) {
  const format = flagValue(args, '--format') === 'markdown' || flagValue(args, '--format') === 'md' ? 'markdown' : 'json';
  const kind = flagValue(args, '--kind');
  let result;
  if (args.includes('--usage')) result = { ok: true, manifest: unitApiManifest() };
  else if (args.includes('--list')) result = listUnits(root, { kind });
  else {
    const include = flagValue(args, '--include');
    result = summarizeUnit(root, ref, { detail: flagValue(args, '--detail') || 'standard', kind, ...(include ? { include: include.split(',').map((s) => s.trim()) } : {}) });
  }
  console.log(result.manifest ? JSON.stringify(result.manifest, null, 2) : format === 'markdown' ? renderUnitMarkdown(result) : JSON.stringify(result, null, 2));
  if (!result.ok) setExitCode(result.error.code === 'INTERNAL_ERROR' ? EXIT_CODES.INTERNAL_ERROR : EXIT_CODES.USAGE_ERROR);
}

/** `construct summarize --backend [<dir>] [--format json] [--dir <project>]`: the read-only backend summary (#634). `<dir>`
 * defaults to `backend.dir` in architecture.yml, else the project root; paths in the output are relative to the project root. */
function summarizeBackendCommand(args) {
  const bi = args.indexOf('--backend');
  const given = args[bi + 1] && !args[bi + 1].startsWith('--') ? args[bi + 1] : null;
  const root = args.includes('--dir') ? getRoot(args) : undefined;
  const dir = given ? path.resolve(given) : resolveBackendDir(root ?? getRoot(args));
  const summary = summarizeBackend(dir, root ? { root } : {});
  console.log(flagValue(args, '--format') === 'json' ? JSON.stringify(summary, null, 2) : renderBackendText(summary));
}

export async function summarize(args) {
  if (args.includes('--backend')) return summarizeBackendCommand(args);
  const root = getRoot(args);
  const ref = positionalOf(args);
  const legacy = ['--feature', '--since'].some((f) => args.includes(f)) || ['compact', 'prose', 'md'].includes(flagValue(args, '--format'));
  if (!legacy && (ref || ['--list', '--usage', '--kind', '--detail', '--include'].some((f) => args.includes(f)))) return summarizeUnitCommand(args, root, ref);
  const fi = args.indexOf('--feature');
  const feature = fi >= 0 ? args[fi + 1] : undefined;
  const ff = args.indexOf('--format');
  const format = ff >= 0 ? args[ff + 1] : 'json';
  const si = args.indexOf('--since');
  const output = si >= 0
    ? summarizeSince(root, args[si + 1], { format })
    : format === 'compact'
      ? summarizeCompact(root, { feature })
      : format === 'prose'
        ? summarizeProse(root, { feature })
        : summarizeProject(root, { feature, format });
  console.log(output);
}

/** Read all of stdin to completion as a UTF-8 string — used by `construct
 * pipeline run`, which (unlike every other command) takes its real input as
 * a JSON payload over stdin rather than as CLI args. */
function readStdin(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

/** `construct pipeline run [--dir <path>]` -- Ticket 7.1. Reads a Context
 * Envelope (schemas/envelope.v1.json) as JSON off stdin, with an optional
 * `steps: [{layer, name}, ...]` list of generator steps to run against
 * `envelope.feature`. Every step's output is staged in one
 * transactionalWriter transaction and committed atomically: if the buffered
 * result fails `construct validate`'s own enforcer set, nothing under the
 * project root is written and the process exits non-zero. Either way, the
 * resulting envelope (status 'committed' or 'aborted', `layers`/
 * `diagnostics` populated accordingly) is written to stdout as JSON --
 * mirroring the same `JSON.stringify(..., null, 2)` shaping `validate
 * --format json` and `summarize --format json` already use, not a second
 * JSON convention. */
export async function pipeline(args) {
  if (args[0] !== 'run') {
    throw new ConstructError('Usage: construct pipeline run < envelope.json', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const root = getRoot(args);
  const raw = await readStdin(process.stdin);
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    throw new ConstructError(`Malformed envelope JSON on stdin: ${e.message}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const { valid, errors } = validateEnvelope(input);
  if (!valid) {
    throw new ConstructError(`Invalid Context Envelope on stdin:\n  ${errors.join('\n  ')}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  }

  const output = runPipeline(root, input);
  console.log(JSON.stringify(output, null, 2));
  if (output.status === 'aborted') setExitCode(exitCodeForViolations(output.diagnostics));
}

const TRACES_USAGE = 'Usage: construct traces list [--chooser <id>] [--limit <n>] [--json] | stats [--chooser <id>] [--json] | replay (--provider <name> [--plugin <file.mjs>] | --model <name> [--all]) [--chooser <id>] [--min-traces <n>] [--baseline <name>] [--json] | export --out <dir> [--since <date>] [--chooser <id>] [--yes] [--json] [--dir <path>]';
const TRACES_VALUE_FLAGS = new Set(['--chooser', '--limit', '--provider', '--baseline', '--min-traces', '--plugin', '--model', '--dir', '--format', '--out', '--since']);

/** The version of the running Construct, for the manifest of a dataset bundle: the baked value of the built CLI, else the core package's own. */
function constructVersion() {
  if (process.env.CONSTRUCT_CLI_VERSION) return process.env.CONSTRUCT_CLI_VERSION;
  try {
    return JSON.parse(fs.readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** Failure codes that are the caller's wording, not the data or the machine: exit code 2 (usage). Everything else typed is 1 (refused), an internal failure 3. */
const USAGE_CODES = new Set(['OUT_REQUIRED', 'SINCE_INVALID', 'NAME_REQUIRED', 'DIR_REQUIRED']);
const INTERNAL_CODES = new Set(['EXPORT_FAILED', 'MODEL_VERIFY_FAILED', 'MODEL_REGISTER_FAILED', 'LEDGER_WRITE_FAILED']);

/** Print a typed failure the way every #647 command does: as `{ ok: false, error: { code, message } }` with `--json`, else as one `Construct error` line; never a stack trace. */
function reportTyped(failure, json) {
  const exitCode = USAGE_CODES.has(failure.code) ? EXIT_CODES.USAGE_ERROR : INTERNAL_CODES.has(failure.code) ? EXIT_CODES.INTERNAL_ERROR : EXIT_CODES.VIOLATIONS;
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } }, null, 2));
    setExitCode(exitCode);
    return;
  }
  throw new ConstructError(`${failure.code}: ${failure.message}`, { exitCode });
}

/** `construct traces export` (#647): preview by default, `--yes` writes the bundle. */
function tracesExport(args, root, json) {
  const result = exportDataset(root, { out: flagValue(args, '--out'), write: args.includes('--yes'), since: flagValue(args, '--since'), chooser: flagValue(args, '--chooser') ?? null, now: new Date().toISOString(), constructVersion: constructVersion() });
  if (!result.ok) return reportTyped(result, json);
  console.log(json ? JSON.stringify({ ok: true, written: result.written, out: result.out, preview: result.preview, ...(result.written ? { manifest: result.manifest } : {}) }, null, 2) : renderExport(result));
  return undefined;
}

/**
 * `construct traces list|stats|replay|export` (#643): read-only (`export` writes only with --yes, and only the bundle folder), deterministic, no model and no network. The traces are the
 * `decision-trace.v1` records the chain wrote to this project's state directory (docs/DECISION-TRACES.md).
 *
 *   list [--chooser <id>] [--limit <n>]     the recorded decisions
 *   stats [--chooser <id>]                  counts per chooser, acceptance rate of suggestions, per provider
 *   replay --provider <name> [--chooser <id>] [--min-traces <n>] [--baseline <name>] [--plugin <file.mjs>]
 *                                           score a provider on the recorded summaries against the `rules` baseline
 *   replay --model <name> [--all] [--chooser <id>] [--min-traces <n>] [--baseline <name>]
 *                                           (#645) the same, for a model registered by `construct model import` (a features.json or a
 *                                           prototypes.json model), ENABLED OR NOT: scoring a model offline never enables it. It scores
 *                                           only decisions the model has not seen (the held-out records of its export and everything
 *                                           recorded after it); --all scores every recorded decision, including the ones it was built from
 *   export --out <dir> [--since <date>] [--chooser <id>] [--yes]
 *                                           (#647) a dataset bundle for training the decision model ELSEWHERE: a PREVIEW of exactly what
 *                                           would be included (records per chooser, the fields, the date range, hashed project keys, no
 *                                           path or secret) unless --yes writes dataset.jsonl, schema.json, manifest.json and README.md
 *                                           into <dir>; `traces: off` projects contribute nothing; docs/TRAIN-ELSEWHERE.md
 *
 * `--json` (or `--format json`) prints one JSON document. `--plugin <file.mjs>` imports a module that registers a decision
 * provider (it calls `registerDecisionProvider`, or default-exports `{ name, suggest }`); code you name yourself, run
 * locally, so it is as trusted as any script you run. A provider that is not registered is a usage error (exit 2).
 *
 * @param {string[]} args `list`, `stats`, `replay` or `export` followed by its flags.
 * @returns {Promise<void>} Resolves after printing the report.
 * @throws {ConstructError} Usage error (exit code 2) for an unknown subcommand, a missing or unknown provider, or a bad number; a typed refusal of `export` (exit code 1, for example `DATASET_EMPTY`).
 *
 * @example
 * await traces(['replay', '--provider', 'rules', '--json']);
 */
export async function traces(args) {
  const usage = (message) => new ConstructError(`${message}\n${TRACES_USAGE}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  const sub = args.find((a, i) => !a.startsWith('--') && !TRACES_VALUE_FLAGS.has(args[i - 1]));
  if (!['list', 'stats', 'replay', 'export'].includes(sub)) throw usage(sub ? `Unknown traces command "${sub}".` : 'Say what to do with the traces.');
  const json = args.includes('--json') || flagValue(args, '--format') === 'json';
  if (sub === 'export') return tracesExport(args, getRoot(args), json);
  const chooser = flagValue(args, '--chooser');
  const count = (name, fallback) => {
    const raw = flagValue(args, name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw usage(`${name} must be a whole number (got ${JSON.stringify(raw)}).`);
    return Number(raw);
  };
  const root = getRoot(args);
  const read = readTraces(root);
  const decisions = chooser ? read.decisions.filter((d) => d.chooser.id === chooser) : read.decisions;
  const print = (doc, text) => console.log(json ? JSON.stringify(doc, null, 2) : text);
  const notes = [
    ...(read.enabled ? [] : ['Recording is off for this project (traces: off in architecture.yml); what was recorded earlier is shown.']),
    ...(read.skipped ? [`${read.skipped} unreadable line(s) skipped.`] : []),
    ...(read.error ? [`Could not read the traces: ${read.error}`] : []),
  ];
  const withNotes = (text) => [text, ...(notes.length ? ['', ...notes] : [])].join('\n');
  if (sub === 'list') {
    const limit = count('--limit');
    print({ ok: true, enabled: read.enabled, total: decisions.length, skipped: read.skipped, decisions: limit ? decisions.slice(-limit) : decisions }, withNotes(`${renderTraceList(decisions, { limit })}\n(${read.dir})`));
  } else if (sub === 'stats') {
    const stats = traceStats(decisions);
    print({ ok: true, enabled: read.enabled, skipped: read.skipped, ...stats }, withNotes(renderTraceStats(stats)));
  } else {
    const modelName = flagValue(args, '--model');
    const provider = flagValue(args, '--provider') ?? modelName;
    let scored = decisions;
    if (!provider) throw usage('replay needs --provider <name> or --model <name>.');
    const plugin = flagValue(args, '--plugin');
    if (modelName) {
      // A registered model is scored offline, enabled or not (`requireEnabled: false`): this run only reads the stored, hash-checked data.
      if (provider !== modelName || plugin) throw usage('--model <name> takes no other provider and no --plugin.');
      const loaded = loadRegisteredModelProvider(modelName, { root, requireEnabled: false });
      if (!loaded.ok) throw usage(`Could not load the model: ${loaded.message}`);
      if (getDecisionProvider(modelName)) throw usage(`A decision provider named "${modelName}" is already registered in this process.`);
      registerDecisionProvider(modelName, loaded.provider);
      if (!args.includes('--all')) {
        const unseen = unseenByModel(root, modelName, decisions);
        if (!unseen.ok) throw usage(`${unseen.message} Use --all to score every recorded decision.`);
        scored = unseen.decisions;
        notes.push(`Scored on the ${unseen.decisions.length} decisions ${modelName} has not seen (${unseen.heldOut} held-out records of its export, ${unseen.later} recorded since); --all scores every recorded decision, including the ones it was built from.`);
      }
    } else if (plugin) {
      // The same loader as the project setting (decision-plugin.mjs). A file named on the command line is any path you type; it
      // may default-export the provider contract or register itself with registerDecisionProvider (older plugins).
      const loaded = await loadDecisionPlugin(plugin, { expectName: provider, register: true, strict: false });
      if (!loaded.ok) throw usage(`Could not load the plugin ${plugin}: ${loaded.message}`);
    } else if (!getDecisionProvider(provider)) {
      // No --plugin: a provider the project's architecture.yml names (decision: { provider, plugin }) is loaded from there.
      let setting = {};
      try {
        setting = loadConfig(root).decision ?? {};
      } catch {
        // an unreadable config: the provider stays unregistered and the error below says so
      }
      if (setting.plugin && (setting.provider ?? provider) === provider) {
        const loaded = await loadDecisionPlugin(setting.plugin, { root, expectName: provider, register: true });
        if (!loaded.ok) throw usage(`Could not load the project's decision plugin: ${loaded.message}`);
      }
    }
    const report = await replayTraces(scored, { provider, baseline: flagValue(args, '--baseline'), chooser, minTraces: count('--min-traces', DEFAULT_MIN_TRACES) });
    if (!report.ok) {
      if (json) console.log(JSON.stringify(report, null, 2));
      throw usage(report.error);
    }
    print({ ...report, enabled: read.enabled, skipped: read.skipped }, withNotes(renderReplay(report)));
  }
}

const MODEL_USAGE = 'Usage: construct model list [--json] | import <dir> [--yes] [--min-traces <n>] [--json] | remove <name> [--json] | enable <name> [--json] | disable <name> [--json] [--dir <path>]';
const MODEL_VALUE_FLAGS = new Set(['--dir', '--min-traces', '--format']);

/**
 * `construct model list|import|remove|enable|disable` (#647): a decision model trained on ANOTHER machine comes back as a folder of
 * plain data and is verified here. Nothing trains here and nothing in the folder is ever executed.
 *
 *   import <dir> [--yes] [--min-traces <n>]   verify the bundle (allowed files only: manifest.json, checksums.txt, eval-report.json,
 *                                             MODEL_CARD.md, features.json, prototypes.json, model.onnx; no script, pickle, link or
 *                                             path; size caps; sha256 of every file; the dataset hash must be one THIS project
 *                                             exported), replay the held-out test records against the rules baseline (a features.json
 *                                             model; an .onnx file is verified and stored, not loaded) and print the comparison; with
 *                                             --yes register it in the state directory DISABLED. architecture.yml is never edited.
 *   list                                      the registered models
 *   remove <name>                             delete a registered model (state directory only)
 *   enable <name> | disable <name>            the owner's explicit act: one flag in the state directory (docs/TRAIN-ELSEWHERE.md)
 *
 * `--json` prints one JSON document; a refusal is `{ ok: false, error: { code, message } }` and exit code 1 (2 for a usage error),
 * never a stack trace.
 *
 * @param {string[]} args `list`, `import`, `remove`, `enable` or `disable` followed by its argument and flags.
 * @returns {Promise<void>} Resolves after printing the result.
 * @throws {ConstructError} Usage error (exit code 2) for an unknown subcommand or a missing argument; a typed refusal (exit code 1, for example `MODEL_FILE_NOT_ALLOWED`).
 *
 * @example
 * await model(['import', 'model-out', '--yes']);
 */
export async function model(args) {
  const usage = (message) => new ConstructError(`${message}\n${MODEL_USAGE}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  const positionals = args.filter((a, i) => !a.startsWith('--') && !MODEL_VALUE_FLAGS.has(args[i - 1]));
  const [sub, target] = positionals;
  if (!['list', 'import', 'remove', 'enable', 'disable'].includes(sub)) throw usage(sub ? `Unknown model command "${sub}".` : 'Say what to do with the models.');
  const json = args.includes('--json') || flagValue(args, '--format') === 'json';
  const root = getRoot(args);
  const emit = (doc, text) => console.log(json ? JSON.stringify(doc, null, 2) : text);
  if (sub === 'list') {
    const { models } = listModels(root);
    emit({ ok: true, models }, renderModelList(models));
    return;
  }
  if (!target) throw usage(sub === 'import' ? 'import needs the model folder: construct model import <dir>.' : `${sub} needs a model name.`);
  if (sub === 'import') {
    const raw = flagValue(args, '--min-traces');
    if (raw !== undefined && !/^\d+$/.test(raw)) throw usage(`--min-traces must be a whole number (got ${JSON.stringify(raw)}).`);
    const result = await importModel(root, target, { yes: args.includes('--yes'), minTraces: raw === undefined ? undefined : Number(raw), now: new Date().toISOString() });
    if (!result.ok) return reportTyped(result, json);
    emit({ ok: true, registered: result.registered, replaced: result.replaced, kind: result.kind, loadable: result.loadable, notes: result.notes, replayNote: result.replayNote, replay: result.replay, entry: result.entry }, renderImport(result));
    return undefined;
  }
  if (sub === 'remove') {
    const result = removeModel(root, target);
    if (!result.ok) return reportTyped(result, json);
    emit({ ok: true, removed: result.removed }, `Removed ${result.removed} from the registry.`);
    return undefined;
  }
  const result = setModelEnabled(root, target, sub === 'enable');
  if (!result.ok) return reportTyped(result, json);
  emit({ ok: true, entry: result.entry }, `${result.entry.name}@${result.entry.version} is now ${result.entry.enabled ? 'ENABLED in the registry. It is used only when a project plugin file loads it and architecture.yml names that plugin (docs/TRAIN-ELSEWHERE.md, "Enable it")' : 'disabled'}.`);
  return undefined;
}

const DECIDE_USAGE = 'Usage: construct decide --summary <file|-> [--provider <name>] [--format json] [--dir <path>]\n   or: construct decide --requirement "<sentence>" [--provider <name>] [--format json] [--dir <path>]';
const MAX_SUMMARY_FILE_BYTES = 64 * 1024;

/** The suggestion of a provider as `construct decide` prints it: the option, the reason, the runner-up and a score when there is one. */
const decideSuggestion = (s) => (s ? { option: s.option, reason: s.reason, runnerUp: s.runnerUp, ...(s.score === undefined ? {} : { score: s.score }) } : null);

/** The provider line of a `decide` document: who answered (the rules provider after a fallback), what was asked for, and every load or fallback line. */
const decideProvider = (decision, answered) => ({
  provider: answered ? { name: answered.provider, version: answered.version } : decision.provider,
  requested: decision.requested,
  fellBackFrom: decision.fellBackFrom,
  notes: decision.notes,
});

async function decideBody(args) {
  const usage = (message) => new ConstructError(`${message}\n${DECIDE_USAGE}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  const summaryArg = flagValue(args, '--summary');
  const sentence = flagValue(args, '--requirement');
  if ((summaryArg === undefined) === (sentence === undefined)) throw usage('Give exactly one of --summary <file|-> and --requirement "<sentence>".');
  const root = getRoot(args);
  // What a fallback or a plugin load says goes to stderr, so stdout stays the one document a tool reads.
  const decision = await openDecision(root, { provider: flagValue(args, '--provider'), log: (line) => console.error(line) });

  if (summaryArg !== undefined) {
    let raw;
    try {
      raw = summaryArg === '-' ? await readStdin(process.stdin) : fs.readFileSync(path.resolve(summaryArg), 'utf8');
    } catch (e) {
      throw usage(`Could not read the summary: ${String(e?.code ?? e?.message ?? e).split('\n')[0]}`);
    }
    if (raw.length > MAX_SUMMARY_FILE_BYTES) throw usage(`The summary is larger than ${MAX_SUMMARY_FILE_BYTES} bytes; a summary has a fixed, small size.`);
    let summary;
    try {
      summary = JSON.parse(raw);
    } catch (e) {
      throw usage(`The summary is not JSON: ${e.message}`);
    }
    if (!providerInput(summary)) throw usage('The summary must be { id, question, options: [{ id, label, enabled, why }] } with at most 5 options, at most 16 KiB, and no secret in it.');
    const s = await decision.suggest(summary);
    return { ...decideProvider(decision, s), suggestion: decideSuggestion(s) };
  }

  const parsed = parseRequirement(sentence);
  if (!parsed.card) throw usage(parsed.errors[0]?.message ?? 'The requirement could not be read.');
  const { card } = parsed;
  let questions;
  let note = null;
  if (card.open.length) {
    questions = card.open.map((item) => ({ ...openQuestion(card, item), source: 'card' }));
    note = 'A word of the sentence is not known yet: answer these questions (the Requirement screen, or the card answers) before anything is placed.';
  } else {
    const config = loadConfig(root);
    const placement = placeCard(card, { layers: config.layers, framework: config.project?.framework });
    questions = [...placement.open, ...(placement.offers ?? [])].map((q) => ({ ...q, source: 'placement' }));
  }
  const suggestions = await suggestForQuestions(decision, questions);
  const first = Object.values(suggestions)[0];
  return {
    ...decideProvider(decision, first ? { provider: first.provider.name, version: first.provider.version } : null),
    ...(note ? { note } : {}),
    questions: questions.map((q) => ({
      id: q.id,
      source: q.source,
      question: q.question,
      options: q.options.filter((o) => o.enabled !== false).map((o) => ({ id: o.id, label: o.label })),
      suggestion: suggestions[q.id] ?? null,
    })),
  };
}

/**
 * The text form of a `construct decide` document: one block per question (`--requirement`), or the one suggestion (`--summary`).
 *
 * @param {{ provider: { name: string, version: string }, suggestion?: object | null, note?: string, questions?: { id: string, source: string, question: string, options: { id: string }[], suggestion: { option: string, reason: string, runnerUp: string | null, provider: { name: string, version: string } } | null }[] }} doc A `decide` document (`--format json` without `ok`).
 * @returns {string} The lines `construct decide` prints, joined by newlines.
 *
 * @example
 * renderDecideText({ provider: { name: 'rules', version: '1' }, suggestion: { option: 'entity', reason: 'first available step', runnerUp: null } });
 * // => 'suggested: entity (rules 1). Why: first available step.'
 */
export function renderDecideText(doc) {
  const who = (p) => `${p.name} ${p.version}`;
  const line = (s, provider) => (s ? `suggested: ${s.option} (${who(provider)}). Why: ${s.reason.replace(/\.$/, '')}.${s.runnerUp ? ` Runner-up: ${s.runnerUp}.` : ''}` : `no suggestion (${who(provider)})`);
  const lines = [];
  if (doc.questions) {
    if (doc.note) lines.push(doc.note, '');
    for (const q of doc.questions) lines.push(`${q.id} [${q.source}] ${q.question}`, `  options: ${q.options.map((o) => o.id).join(', ')}`, `  ${line(q.suggestion, q.suggestion?.provider ?? doc.provider)}`);
    if (!doc.questions.length) lines.push('Nothing is open: the sentence places without a question.');
  } else {
    lines.push(line(doc.suggestion, doc.provider));
  }
  return lines.join('\n');
}

/**
 * `construct decide --summary <file|-> [--provider <name>]` | `construct decide --requirement "<sentence>" [--provider <name>]`
 * (#633): ask the project's decision provider which option to take next. Read-only, writes nothing, and a suggestion never
 * applies itself. This is the tool an LLM calls: a chooser or open-question summary (JSON, from a file or stdin) in, one
 * suggestion out. `--requirement` reads a sentence with `parseRequirement` and `placeCard` and prints, for each open
 * question and offer, what the provider suggests and why. No model is called unless the project's `architecture.yml` names a
 * plugin (`decision: { provider, plugin }`); the built-in `rules` provider (the default) and `off` need none. A plugin that
 * fails or is slow is replaced by the rules provider and a line on stderr says so. `--format json` prints one document,
 * `{ ok, provider, requested, fellBackFrom, notes, suggestion }` (or `questions`), and an error as `{ ok: false, error: { code, message } }`
 * with exit code 2 for a usage error.
 *
 * @param {string[]} args `--summary <file|->` or `--requirement "<sentence>"`, optional `--provider <name>`, `--format json`, `--dir <path>`.
 * @returns {Promise<void>} Resolves after printing the suggestion(s).
 * @throws {ConstructError} Usage error (exit code 2) for a missing or both inputs, an unreadable or malformed summary, or a sentence that cannot be read.
 *
 * @example
 * await decide(['--summary', 'chooser-summary.json', '--format', 'json']);
 */
export async function decide(args) {
  if (flagValue(args, '--format') === 'json' || args.includes('--json')) {
    await printJsonResult(() => decideBody(args));
    return;
  }
  console.log(renderDecideText(await decideBody(args)));
}

/**
 * `construct doctor [--format json] [--dir <path>]`: read-only environment check (node and npm versions, whether
 * the project has an `architecture.yml`, which enforcer modules are installed) and what the machine can run: memory,
 * cores, free disk, ffmpeg, a Playwright browser, Ollama on this machine (a 2 second check, never fatal), python3 and
 * model files, sorted into the documented tiers (Lite, Cockpit use, Contributor) with the reason, what is switched on and
 * off and why, and the exact fix line for each missing optional item. No model, no network beyond that local check.
 * `--format json` prints one stable document, `{node, npm, architectureYml, enforcers:[{name, available}], supported, tier,
 * machine, enabled, disabled, optional, notes, now}` (a version is `null` when the tool is missing), instead of the text
 * list; the Cockpit's `cli` execution mode reads that document (#541). Exit code 0, except 1 for a Node older than 20 or a
 * machine that cannot be read (#648).
 *
 * @param {string[]} args Optional `--format json` and `--dir <path>`.
 * @param {{ probes?: Record<string, Function> }} [deps] Probes for the machine check; tests hand in a fake machine.
 * @returns {Promise<void>} Resolves after printing the report.
 *
 * @example
 * await doctor(['--format', 'json']);
 */
export async function doctor(args, deps = {}) {
  const root = getRoot(args);
  const versions = {};
  for (const c of ['node', 'npm']) {
    // #413: bounded; a `--version` that takes 30 s is not going to answer.
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    versions[c] = r.status === 0 ? r.stdout.trim() : null;
  }
  const hasConfig = fs.existsSync(path.join(root, 'architecture.yml'));
  const enforcers = ENFORCER_MODULES.map(({ name, file }) => ({ name, available: fs.existsSync(path.join(packageRoot, file)) }));
  const machine = buildMachineReport(await detectMachine(deps.probes ?? defaultMachineProbes({ cwd: root })));
  const report = { node: versions.node, npm: versions.npm, architectureYml: hasConfig, enforcers, ...machine };
  if (flagValue(args, '--format') === 'json') console.log(JSON.stringify(report, null, 2));
  else for (const line of renderDoctorText(report)) console.log(line);
  if (!machine.supported) setExitCode(EXIT_CODES.VIOLATIONS);
}

/**
 * The text form of a `doctor` report, one string per printed line. `construct doctor` prints exactly these lines,
 * and the Cockpit's `cli` execution mode rebuilds them from the JSON document, so both modes show the same text.
 *
 * @param {{node:string|null, npm:string|null, architectureYml:boolean, enforcers:{name:string, available:boolean}[]}} report A `doctor --format json` document (one without the machine part, from before #648, prints only the first five lines).
 * @returns {string[]} The lines `construct doctor` prints.
 */
export function renderDoctorText(report) {
  const lines = [
    'Construct doctor',
    `node: ${report.node ?? 'missing'}`,
    `npm: ${report.npm ?? 'missing'}`,
    `architecture.yml: ${report.architectureYml ? 'present' : 'missing'}`,
    'Enforcer modules:',
    ...report.enforcers.map(({ name, available }) => `  ${name}: ${available ? 'available' : 'not yet available'}`),
  ];
  return report.tier ? [...lines, ...renderMachineText(report)] : lines;
}

/**
 * The attribution every read-only `research` report ends with. Exported so the Cockpit's `cli` execution mode
 * labels its result exactly as the in-process path does.
 */
export const READ_ONLY_ATTRIBUTION = Object.freeze({ tool: 'produced the read-only report above', llm: '0 calls' });

// ---- capability groups: create / refactor / research ----------------------
//
// Three verbs, not three new engines: each delegates straight to the
// existing, already-tested functions above (or, for `refactor`, to the
// mechanical move/rename in refactor.mjs) — this is a friendlier CLI
// grouping for the three things Construct lets you do to a project, not a
// new implementation. The flat commands (`feature`, `generate`, `summarize`,
// `doctor`) keep working unchanged.

// Every create/refactor/research/import action ends with one of these —
// the whole point being that "who did what" is legible per-command, not
// buried in a separate log a human has to go find and cross-reference.
export function printAttribution(tool, llm) {
  console.log(`[tool: ${tool}] [llm: ${llm}]`);
}

/**
 * `construct create feature <name>` | `construct create layer <name> --layers ... [--llm <provider>]`
 * | `construct create <layer> <name> --feature <feature> [--llm <provider>]`
 * | `construct create env <NAME> --scope server|public [--value <placeholder>] [--comment <line>]` (one variable in .env.example, a placeholder never a real value, #632)
 * | `construct create guard <Name> --feature <feature> --access public|signed-in|role [--roles a,b] [--redirect </path>] [--route </path>]` (who may open a screen: a typed guard wired to the route entry, and its proof; `public` writes nothing, #629)
 * | `construct create store <Name> --feature <feature> --shape value|list|keyed [--entity <Entity>] [--fields id:string,...]` (shared client state on the tracked-state factory: a status union, typed actions, a pure reducer, a hook and a locked proof, #630)
 * | `construct create handler <Name> --feature <feature> --method GET|POST|PUT|DELETE --path /api/<x> [--service <Name>]` (a Next.js route handler app/api/<x>/route.ts that delegates to a service and maps its typed result to 200, 400, 405 or 500; refused for a react-spa project, #625)
 * | `construct create service <name> --feature <feature> --openapi <spec> [--schema|--no-schema]` (Ticket 7.5; Zod response schemas beside the types when the project has zod or `--schema`, #575)
 * | `construct create layer|<layer> <name> --feature <feature> --shape list [--entity <E>] [--fields id:string,...]` (#619: real typed code, no model).
 * `feature` creation has nothing fillable (just types.ts/index.ts
 * boilerplate) so `--llm` only ever applies to the layer/single-layer
 * forms, which `generate(args)` itself already handles (see its own doc
 * comment) — this just reports whether that happened.
 *
 * @param {string[]} args `feature <name>`, `layer <name> --layers ...`, `<layer> <name> --feature <f>` or `service <name> --feature <f> --openapi <spec>`, each with an optional `--llm <provider>`.
 * @returns {Promise<void>} Resolves once the files are scaffolded and the attribution line is printed.
 *
 * @example
 * await create(['feature', 'billing']);
 */
export async function create(args) {
  if (flagValue(args, '--format') === 'json') return printJsonResult(() => createDocument(args));
  if (args[0] === 'feature') {
    await feature(['create', ...args.slice(1)]);
    printAttribution(SCAFFOLD_ATTRIBUTION.tool, SCAFFOLD_ATTRIBUTION.llm);
    return;
  }
  await generate(args);
  const llmI = args.indexOf('--llm');
  const llm = llmI >= 0 ? args[llmI + 1] : undefined;
  if (llm) {
    printAttribution(
      'scaffolded the file(s) above from templates',
      `call(s) via "${llm}" to write the real implementation into each generated file — review it before trusting it`,
    );
  } else {
    printAttribution(SCAFFOLD_ATTRIBUTION.tool, SCAFFOLD_ATTRIBUTION.llm);
  }
}

/** The attribution of a deterministic `create`: templates only, no model call. */
const SCAFFOLD_ATTRIBUTION = Object.freeze({ tool: 'scaffolded the file(s) above from templates', llm: '0 calls — filling in the logic is a separate step, by you or whichever LLM you choose' });

const usageFail = (message) => new ConstructError(message, { exitCode: EXIT_CODES.USAGE_ERROR });

/**
 * Run a verb body that returns its result document and print it as the verb's `--format json` output (#541): one
 * pretty-printed JSON object on stdout, `{ok: true, ...result}`, or `{ok: false, error: {code, message}}` with the
 * matching exit code for any failure. Nothing else is printed, so the Cockpit's `cli` execution mode can parse
 * stdout as a whole and compare it with its in-process twin byte for byte.
 */
async function printJsonResult(body) {
  try {
    console.log(JSON.stringify({ ok: true, ...(await body()) }, null, 2));
  } catch (e) {
    const exitCode = e instanceof ConstructError ? e.exitCode : EXIT_CODES.INTERNAL_ERROR;
    const code = exitCode === EXIT_CODES.USAGE_ERROR ? 'USAGE_ERROR' : exitCode === EXIT_CODES.VIOLATIONS ? 'VIOLATIONS' : 'INTERNAL_ERROR';
    console.log(JSON.stringify({ ok: false, error: { code, message: String(e?.message || e) } }, null, 2));
    setExitCode(exitCode);
  }
}

/** `--format json` covers the deterministic forms only; a flag that implies a model call or an external input is refused by name. */
function refuseNonDeterministicFlags(verb, args, flags) {
  const found = flags.find((f) => args.includes(f));
  if (found) throw usageFail(`${verb} --format json covers the deterministic form only, without ${flags.join(', ')} (${found} was given). Run it without --format json.`);
}

/** The result document of `create feature <name>` | `create layer <name> --feature f --layers l1,l2` | `create <layer> <name> --feature f`. */
async function createDocument(args) {
  refuseNonDeterministicFlags('create', args, ['--llm', '--from', '--bind', '--envelope', '--openapi']);
  const attribution = { ...SCAFFOLD_ATTRIBUTION };
  if (args[0] === 'feature') {
    const name = args[1];
    if (!name || name.startsWith('--')) throw usageFail('Usage: construct feature create <name>');
    const root = getRoot(args);
    return { verb: 'create', kind: 'feature', feature: name, path: path.relative(root, createFeature(root, name)), attribution };
  }
  if (args[0] === 'tests') throw usageFail('create --format json does not cover `tests`: use `construct generate tests <feature>`.');
  if (args[0] === 'proof') return proofDocument(args, attribution);
  if (args[0] === 'route') return routeDocument(args, attribution);
  if (args[0] === 'dependency') return dependencyDocument(args, attribution);
  if (args[0] === 'env') return envDocument(args, attribution);
  if (args[0] === 'guard') return guardDocument(args, attribution);
  if (args[0] === 'store') return storeDocument(args, attribution);
  if (args[0] === 'handler') return handlerDocument(args, attribution);
  const fi = args.indexOf('--feature');
  const feature = fi >= 0 ? args[fi + 1] : undefined;
  if (args[0] === 'layer') {
    const name = args[1], li = args.indexOf('--layers');
    if (!name || !feature || li < 0 || !args[li + 1]) throw usageFail('Usage: construct generate layer <name> --feature <feature> --layers <layer1,layer2,...> [--llm <provider>]');
    const root = getRoot(args);
    const layers = args[li + 1].split(',').map((l) => l.trim()).filter(Boolean);
    const shaped = shapeRequestOf(args, name, feature);
    const files = shaped ? generateShapeVertical(root, shaped, layers) : generateVertical(root, name, feature, layers);
    const deps = shaped ? ensureGeneratedDependencies(root, files) : null;
    return { verb: 'create', kind: 'layer', feature, name, layers, ...(shaped ? { shape: shaped.shape } : {}), files: files.map((f) => path.relative(root, f)), ...(deps && (deps.added.length || deps.notes.length) ? { dependencies: deps } : {}), attribution };
  }
  const layer = args[0], name = args[1];
  if (!layer || !name || !feature) throw usageFail('Usage: construct generate <layer> <name> --feature <feature> [--openapi <spec>] [--llm <provider>]');
  const root = getRoot(args);
  const shaped = shapeRequestOf(args, name, feature);
  if (shaped) {
    const files = generateShapeLayer(root, { ...shaped, layer });
    const deps = ensureGeneratedDependencies(root, files);
    return { verb: 'create', kind: 'single', feature, layer, name, shape: shaped.shape, files: files.map((f) => path.relative(root, f)), ...(deps.added.length || deps.notes.length ? { dependencies: deps } : {}), attribution };
  }
  return { verb: 'create', kind: 'single', feature, layer, name, files: [path.relative(root, generateLayer(root, layer, name, feature))], attribution };
}

/** `construct research workflow <feature> [<file>] [--format prose|md|json|scenarios] [--dir <path>]`
 * (epic #185). Read-only: explains the XState machines in a feature's
 * workflows/ folder in plain English, with scenarios and health findings,
 * derived from the source every time. Returns true when it printed only JSON. */
export async function researchWorkflow(args) {
  const t = startTimer();
  const valueFlags = new Set(['--format', '--dir']);
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (valueFlags.has(args[i])) i += 1;
    else if (!args[i].startsWith('--')) positional.push(args[i]);
  }
  const [feature, file] = positional;
  const fi = args.indexOf('--format');
  const format = fi >= 0 ? args[fi + 1] : 'prose';
  if (!feature || positional.length > 2 || !['prose', 'md', 'json', 'scenarios'].includes(format)) {
    throw new ConstructError('Usage: construct research workflow <feature> [<file>] [--format prose|md|json|scenarios] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const root = getRoot(args);
  const files = file ? [file] : listWorkflowSourceFiles(root, feature);
  const results = files.map((f) => ({ file: f, ...explainSource(readWorkflowSource(root, feature, f)) }));
  const withMachines = results.filter((r) => r.machines.length || r.error);
  if (format === 'json') {
    console.log(JSON.stringify({ feature, files: withMachines }, null, 2));
    return true;
  }
  if (!withMachines.length) {
    console.log(`No XState machines found in features/${feature}/workflows/.`);
  }
  for (const r of withMachines) {
    console.log(format === 'md' ? `# features/${feature}/workflows/${r.file}\n` : `== features/${feature}/workflows/${r.file} ==\n`);
    if (r.error) console.log(`${r.error}\n`);
    for (const m of r.machines) console.log(renderExplained(m, format));
  }
  const n = withMachines.reduce((sum, r) => sum + r.machines.length, 0);
  console.log(`Explained ${n} machine(s) in ${withMachines.length} file(s) (${formatDuration(elapsedSeconds(t))})`);
  return false;
}

/**
 * `construct research spec <file> [--generate [--feature <name>] | --read-back] [--format json|text] [--dir <path>]`
 * (#576/#584/#593). Checks a machine-spec.v1 file (an English requirement broken down into states,
 * events, transitions and typed functions, see docs/machine-spec.md): structure, then meaning
 * (reachability, unknown states/events, untyped functions, uncovered sentences, ...). Deterministic,
 * no LLM. Without `--generate`, purely read-only (exit code 1 on any SPEC-* failure, 2 when the file
 * cannot be read or is not JSON). With `--generate` (#593, R2): on ANY violation, prints exactly the
 * same report and writes nothing (the generation step never even starts); on an accepted spec, calls
 * `specToCode.mjs`'s `generateFromSpec` to write the workflow (with its typed state union and named
 * guard stubs, event payloads typed, declared `types` in the feature's types.ts), one function stub per
 * `functions[]` entry and the machine's locked every-path unit test, never overwriting a file that already
 * exists. With `--read-back` (#672, R4): on an accepted spec, prints the spec in plain English, per
 * requirement sentence (the states, events, transitions and functions that point at it, sentences out of
 * scope listed as such; `--format json` is the same as a fixed-shape list, see `research/readBack.mjs`),
 * writes nothing; on any violation prints the same report as plain `research spec`. With `--coverage`
 * (#673, R5): the traceability map, sentence -> functions -> generated files (the R2 generator's own
 * paths) and functions -> sentences, `--format json` a fixed-shape result (`research/coverage.mjs`);
 * writes nothing; exit 1 only when a sentence is uncovered and not out of scope (or the spec breaks a
 * rule other than SPEC-009/SPEC-010, in which case the plain validation report is printed instead).
 * `--generate`, `--read-back` and `--coverage` are exclusive (usage error).
 *
 * @param {string[]} args `<file>` plus optional `--generate`, `--read-back` or `--coverage`, `--feature <name>` (used only when the spec has no `feature` field), `--format json|text` (default text) and `--dir <path>` (where a relative `<file>` is resolved from, and the project root `--generate` writes into; default cwd).
 * @returns {Promise<boolean>} Resolves to true when it printed only JSON (so the caller skips the attribution line).
 * @throws {ConstructError} Usage error (exit code 2) for missing/extra positionals, an unknown format, an unreadable/non-JSON file, or (with `--generate`) a missing feature name.
 *
 * @example
 * await researchSpec(['specs/sign-in.machine-spec.json', '--generate', '--feature', 'auth']);
 */
export async function researchSpec(args) {
  const usage = 'Usage: construct research spec <file> [--generate [--feature <name>] | --read-back | --coverage [--feature <name>]] [--format json|text] [--dir <path>]';
  const valueFlags = new Set(['--format', '--dir', '--feature']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  const format = flagValue(args, '--format') ?? 'text';
  if (positional.length !== 1 || !['json', 'text'].includes(format) || ['--generate', '--read-back', '--coverage'].filter((f) => args.includes(f)).length > 1) throw new ConstructError(usage, { exitCode: EXIT_CODES.USAGE_ERROR });
  // The file is resolved from where the user stands (or --dir), not from the project root a
  // parent architecture.yml would pick: a spec is an input file, not a project unit.
  const dir = flagValue(args, '--dir');
  const file = path.resolve(dir ? path.resolve(dir) : process.cwd(), positional[0]);
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConstructError(`Could not read the spec "${positional[0]}": ${String(e.message || e)}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const result = validateMachineSpec(spec, { file: path.relative(process.cwd(), file) || positional[0] });
  const generate = args.includes('--generate');
  // #672: the read-back is of an ACCEPTED spec; a failing one prints R1's own report, like --generate.
  if (args.includes('--read-back') && result.status === 'passed') {
    console.log(renderReadBack(readBackMachineSpec(spec), { format }));
    return format === 'json';
  }
  // #673: the coverage report maps sentences to functions and files. It also runs on a spec whose only
  // violations are the traceability rules (a sentence nothing claims, a link to a sentence that does not
  // exist), since showing those is its job; any other violation prints R1's own report first. Exit 1 only
  // for a sentence that is uncovered and not out of scope.
  if (args.includes('--coverage') && result.violations.every((v) => COVERAGE_TOLERATED_RULES.includes(v.rule))) {
    const coverage = coverageOfMachineSpec(getRoot(args), spec, { feature: flagValue(args, '--feature') });
    console.log(renderCoverage(coverage, { format }));
    if (uncoveredSentences(coverage).length) setExitCode(EXIT_CODES.VIOLATIONS);
    return format === 'json';
  }
  // #593: on any violation, --generate is a no-op -- print R1's own report and write nothing, same
  // as plain `research spec` without the flag.
  if (result.status !== 'passed' || !generate) {
    console.log(renderMachineSpecReport(result, { format }));
    if (result.status !== 'passed') setExitCode(EXIT_CODES.VIOLATIONS);
    return format === 'json';
  }
  const gen = generateFromSpec(getRoot(args), spec, { feature: flagValue(args, '--feature') });
  if (format === 'json') {
    console.log(JSON.stringify({ status: 'generated', ...gen }, null, 2));
    return true;
  }
  console.log(renderMachineSpecReport(result, { format }));
  for (const f of gen.written) console.log(`Wrote ${f}`);
  for (const f of gen.updated) console.log(`Updated ${f}`);
  for (const f of gen.skipped) console.log(`Skipped ${f} (already exists, not overwritten)`);
  for (const f of gen.tests.unchanged) console.log(`Unchanged ${f}`);
  console.log(`Generated feature "${gen.feature}": ${gen.written.length} file(s) written, ${gen.skipped.length} skipped.`);
  if (gen.tests.missingDependencies.length) console.log(`Note: the generated test needs ${gen.tests.missingDependencies.join(', ')} in this project: npm install -D ${gen.tests.missingDependencies.join(' ')}`);
  return false;
}

/** `construct research impact <ref>... [--files a,b] [--since <git-ref>] [--ticket <text>]
 * [--ticket-file <path>] [--depth N] [--max-files N] [--format json|markdown] [--dir <path>]`
 * | `construct research impact --usage` (#288).
 *
 * Read-only blast radius: which features/layers/files a change touches, why each file is
 * implicated, what is shared across features, and what the project's rules already say. Seeds
 * given as refs or `--files`/`--since` are explicit, so every entry comes back `derived`; seeds
 * proposed from `--ticket` text are heuristic, so everything they reach is marked `inferred`.
 * Returns true when it printed only JSON. */
export async function researchImpact(args) {
  const root = getRoot(args);
  const format = ['markdown', 'md'].includes(flagValue(args, '--format')) ? 'markdown' : 'json';
  if (args.includes('--usage')) {
    console.log(JSON.stringify(impactApiManifest(), null, 2));
    return true;
  }
  const valueFlags = new Set(['--dir', '--format', '--depth', '--max-files', '--files', '--ticket', '--ticket-file', '--since', '--max-seeds']);
  const refs = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  const seeds = refs.map((ref) => ({ ref, method: 'user', provenance: 'explicit' }));
  const filesFlag = flagValue(args, '--files');
  if (filesFlag) for (const p of filesFlag.split(',').map((s) => s.trim()).filter(Boolean)) seeds.push({ path: p, method: 'changed-files', provenance: 'explicit' });
  const since = flagValue(args, '--since');
  if (since) {
    let changed;
    try {
      // #413: bounded, so a stuck git (a lock, a prompt) cannot hang `research` forever.
      changed = spawnSync('git', ['diff', '--name-only', since], { cwd: root, encoding: 'utf8', timeout: 10 * 60 * 1000, killSignal: 'SIGKILL' });
    } catch (e) {
      throw new ConstructError(`Could not diff against "${since}": ${String(e.message || e)}`, { exitCode: EXIT_CODES.USAGE_ERROR });
    }
    if (/** @type {any} */ (changed.error)?.code === 'ETIMEDOUT') throw new ConstructError(`Could not diff against "${since}": git did not finish within 600 seconds and was stopped.`, { exitCode: EXIT_CODES.INTERNAL_ERROR });
    if (changed.status !== 0) throw new ConstructError(`Could not diff against "${since}": ${String(changed.stderr || changed.error?.message || '').trim() || 'git failed'}. Is ${root} a git repository, and does that ref exist?`, { exitCode: EXIT_CODES.USAGE_ERROR });
    for (const p of changed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) seeds.push({ path: p, method: 'changed-files', provenance: 'explicit' });
  }
  const ticketFile = flagValue(args, '--ticket-file');
  const ticket = ticketFile ? fs.readFileSync(path.resolve(root, ticketFile), 'utf8') : flagValue(args, '--ticket');
  if (ticket) {
    const maxSeeds = flagValue(args, '--max-seeds');
    const proposal = proposeSeedsFromText(root, ticket, maxSeeds ? { maxSeeds: Number(maxSeeds) } : {});
    if (!proposal.ok) {
      console.log(JSON.stringify(proposal, null, 2));
      setExitCode(EXIT_CODES.USAGE_ERROR);
      return true;
    }
    seeds.push(...proposal.seeds);
  }
  if (!seeds.length) {
    throw new ConstructError('Usage: construct research impact <unit-ref>... [--files a,b] [--since <git-ref>] [--ticket <text>] [--ticket-file <path>] [--depth N] [--max-files N] [--format json|markdown] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const depth = flagValue(args, '--depth');
  const maxFiles = flagValue(args, '--max-files');
  const maxSeedsLimit = flagValue(args, '--max-seeds');
  const limits = {
    ...(maxFiles !== undefined ? { maxFiles: Number(maxFiles) } : {}),
    ...(maxSeedsLimit !== undefined ? { maxSeeds: Number(maxSeedsLimit) } : {}),
  };
  const result = analyzeImpact(root, {
    seeds,
    ...(depth !== undefined ? { depth: Number(depth) } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
  });
  console.log(format === 'markdown' ? renderImpactMarkdown(result) : JSON.stringify(result, null, 2));
  if (!result.ok) setExitCode(result.error.code === 'INTERNAL_ERROR' ? EXIT_CODES.INTERNAL_ERROR : EXIT_CODES.USAGE_ERROR);
  return format === 'json';
}

/** `construct review <base> <head> [--plan <file>] [--features a,b] [--no-merge-base] [--format json|markdown]
 * [--dir <path>]` | `construct review --usage` (#314/#316, epic #285).
 *
 * Read-only PR health: the deterministic indicators for the change from <base> to <head> (any two
 * refs; local branches need no GitHub login): declared-vs-actual scope (only with --plan/--features),
 * unexplained changes, rule regressions, public surface, and a flow diff. Findings are split into
 * mechanical (a Construct block can fix them) and conversation (a human decides). No LLM, and the
 * working tree, index and branches are never touched. Returns true when it printed only JSON. */
export async function review(args) {
  if (args.includes('--usage')) {
    console.log(JSON.stringify(prHealthApiManifest(), null, 2));
    return true;
  }
  const valueFlags = new Set(['--dir', '--format', '--plan', '--features']);
  const refs = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  if (refs.length !== 2) {
    throw new ConstructError('Usage: construct review <base> <head> [--plan <file>] [--features a,b] [--no-merge-base] [--format json|markdown] [--dir <path>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const root = getRoot(args);
  const format = ['markdown', 'md'].includes(flagValue(args, '--format')) ? 'markdown' : 'json';
  let expected = null;
  const planFile = flagValue(args, '--plan');
  const featuresFlag = flagValue(args, '--features');
  if (planFile) {
    try {
      expected = JSON.parse(fs.readFileSync(path.resolve(root, planFile), 'utf8'));
    } catch (e) {
      throw new ConstructError(`Could not read the plan "${planFile}": ${String(e.message || e)}`, { exitCode: EXIT_CODES.USAGE_ERROR });
    }
  } else if (featuresFlag) {
    expected = featuresFlag.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const result = prHealth(root, { base: refs[0], head: refs[1], expected, mergeBase: !args.includes('--no-merge-base') });
  console.log(format === 'markdown' ? renderPrHealthMarkdown(result) : JSON.stringify(result, null, 2));
  if (!result.ok) setExitCode(result.error.code === 'INTERNAL_ERROR' ? EXIT_CODES.INTERNAL_ERROR : EXIT_CODES.USAGE_ERROR);
  return format === 'json';
}

/** `construct test proof <feature> [--name <file>] [--format json|text] [--dir <path>]` (#623). Runs the render proof of a shaped screen
 * (no browser, no server) and says, for each failure, whether the app or the harness is at fault, then whether the chain is complete.
 * Read-only, deterministic, no LLM. Exit code 1 when any test failed, 2 when the proof could not run. */
async function testProof(rest, usage) {
  const valueFlags = new Set(['--dir', '--name', '--format']);
  const feature = rest.find((a, i) => !a.startsWith('--') && !valueFlags.has(rest[i - 1]));
  if (!feature) throw new ConstructError(usage, { exitCode: EXIT_CODES.USAGE_ERROR });
  const format = flagValue(rest, '--format') === 'json' ? 'json' : 'text';
  const result = await runProofs(getRoot(rest), feature, { name: flagValue(rest, '--name') });
  console.log(format === 'json' ? JSON.stringify(result, null, 2) : renderProofRunText(result));
  if (!result.ok) setExitCode(EXIT_CODES.USAGE_ERROR);
  else if (result.counts.failed > 0) setExitCode(EXIT_CODES.VIOLATIONS);
  return format === 'json';
}

/** `construct test types [--feature <f>] [--format json|text] [--dir <path>]` and `construct test build [--format json|text] [--dir <path>]` (#632). Type-check the
 * project with its own TypeScript, or run its build script through a bounded process, and print a CLASSIFIED result (a pass, or what kind of failure and where), never a raw log.
 * Read-only, deterministic, no LLM. Exit code 0 for a pass, 1 when the check found a problem, 2 when it could not run (no TypeScript, no tsconfig, no build script). */
async function testCheck(which, rest, usage) {
  const valueFlags = new Set(['--dir', '--feature', '--format']);
  if (rest.some((a, i) => !a.startsWith('--') && !valueFlags.has(rest[i - 1]))) throw new ConstructError(usage, { exitCode: EXIT_CODES.USAGE_ERROR });
  const format = flagValue(rest, '--format') === 'json' ? 'json' : 'text';
  if (which === 'build' && rest.includes('--feature')) throw new ConstructError('The build is of the whole project: --feature only narrows `construct test types`.', { exitCode: EXIT_CODES.USAGE_ERROR });
  const root = getRoot(rest);
  const result = which === 'types' ? await runTypesCheck(root, { feature: flagValue(rest, '--feature') }) : await runBuildCheck(root);
  console.log(format === 'json' ? JSON.stringify(result, null, 2) : renderCheckText(result));
  setExitCode(checkExitCode(result));
  return format === 'json';
}

/** `construct test run <feature> [--name <file> --area generated|yours] [--base-url <url>] [--format json|text] [--dir <path>]`
 * (#305) | `construct test proof <feature>` (#623) | `construct test types [--feature <f>]` and `construct test build` (#632). Runs a feature's Playwright tests against the project's own running app and says, for each failure, whether
 * the harness or the app is at fault; `proof` runs the render proof of a shaped screen offline; `types` type-checks the project with its own TypeScript and `build` runs its build script (bounded), each printing a classified result, never a raw log. Read-only, deterministic, no LLM. Exit code 1 when any test failed or a check found a problem. */
export async function testCommand(args) {
  const usage = 'Usage: construct test run <feature> [--name <file> --area generated|yours] [--base-url <url>] [--format json|text] [--dir <path>]\n       construct test proof <feature> [--name <file>] [--format json|text] [--dir <path>]\n       construct test types [--feature <feature>] [--format json|text] [--dir <path>]\n       construct test build [--format json|text] [--dir <path>]';
  if (args[0] === 'proof') return testProof(args.slice(1), usage);
  if (args[0] === 'types' || args[0] === 'build') return testCheck(args[0], args.slice(1), usage);
  if (args[0] !== 'run') throw new ConstructError(usage, { exitCode: EXIT_CODES.USAGE_ERROR });
  const rest = args.slice(1);
  const valueFlags = new Set(['--dir', '--name', '--area', '--base-url', '--format']);
  const feature = rest.find((a, i) => !a.startsWith('--') && !valueFlags.has(rest[i - 1]));
  if (!feature) throw new ConstructError(usage, { exitCode: EXIT_CODES.USAGE_ERROR });
  const format = flagValue(rest, '--format') === 'json' ? 'json' : 'text';
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const result = await runFeatureTests(getRoot(rest), feature, { name: flagValue(rest, '--name'), area: flagValue(rest, '--area'), baseUrl: flagValue(rest, '--base-url'), signal: abort.signal, onProgress: format === 'text' ? (l) => console.error(l) : undefined });
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  console.log(format === 'json' ? JSON.stringify(result, null, 2) : renderRunText(result));
  if (!result.ok) setExitCode(EXIT_CODES.USAGE_ERROR);
  else if (result.counts.failed > 0) setExitCode(EXIT_CODES.VIOLATIONS);
  return format === 'json';
}

/** `construct template list|show|instantiate` (#333). Read-only, JSON in/out, no LLM.
 *
 *   construct template list --templates <dir>
 *   construct template show <name> --templates <dir>
 *   construct template instantiate <name> --templates <dir> [--param key=value]... [--params-json '{"k":"v"}']
 *
 * A template is a named, reusable, parameterised plan; `instantiate` prints an ordinary plan.v1 (feed it
 * to the runner or `construct review --plan`). The mechanism is open; the CURATED templates are not in
 * this repo: point `--templates <dir>` (or CONSTRUCT_TEMPLATES_DIR) at wherever they live. There is no
 * default directory, and nothing here runs a plan. */
export async function template(args) {
  const usage = 'Usage: construct template list|show <name>|instantiate <name> [--param key=value]... [--params-json <json>] --templates <dir> (or CONSTRUCT_TEMPLATES_DIR)';
  const valueFlags = new Set(['--templates', '--param', '--params-json']);
  const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
  const [verb, name] = positional;
  if (!['list', 'show', 'instantiate'].includes(verb) || (verb !== 'list' && !name)) throw new ConstructError(usage, { exitCode: EXIT_CODES.USAGE_ERROR });
  const dir = flagValue(args, '--templates') ?? process.env.CONSTRUCT_TEMPLATES_DIR;
  if (!dir) throw new ConstructError(`No template directory configured. The curated flows are not bundled with the open core: pass --templates <dir> or set CONSTRUCT_TEMPLATES_DIR. ${usage}`, { exitCode: EXIT_CODES.USAGE_ERROR });
  const params = {};
  try {
    const json = flagValue(args, '--params-json');
    if (json !== undefined) Object.assign(params, JSON.parse(json));
    args.forEach((a, i) => {
      if (a !== '--param') return;
      const kv = args[i + 1] ?? '';
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new TemplateError('PARAM_INVALID', `--param expects key=value, got ${JSON.stringify(kv)}.`);
      params[kv.slice(0, eq)] = kv.slice(eq + 1);
    });
    const registry = loadTemplateDir(path.resolve(dir));
    if (verb === 'list') console.log(JSON.stringify({ ok: true, templates: registry.list() }, null, 2));
    else if (verb === 'show') console.log(JSON.stringify({ ok: true, template: registry.get(name) }, null, 2));
    else console.log(JSON.stringify(registry.instantiate(name, params), null, 2));
  } catch (e) {
    if (!(e instanceof TemplateError) && !(e instanceof SyntaxError)) throw e;
    console.log(JSON.stringify({ ok: false, error: { code: e.code || 'PARAMS_JSON_INVALID', message: e.message, errors: e.errors } }, null, 2));
    setExitCode(EXIT_CODES.USAGE_ERROR);
  }
}

/**
 * `construct research summarize ...` | `construct research doctor ...` | `construct research workflow ...`
 * | `construct research impact ...` | `construct research spec ...`.
 *
 * @param {string[]} args `summarize|doctor|workflow|impact|spec` followed by that command's own arguments.
 * @returns {Promise<void>} Resolves after printing the read-only report.
 * @throws {ConstructError} Usage error (exit code 2) for an unknown subcommand.
 *
 * @example
 * await research(['impact', '--files', 'features/plan/index.ts']);
 */
export async function research(args) {
  let jsonOnly = false;
  if (args[0] === 'summarize') await summarize(args.slice(1));
  else if (args[0] === 'doctor') await doctor(args.slice(1));
  else if (args[0] === 'workflow') jsonOnly = await researchWorkflow(args.slice(1));
  else if (args[0] === 'impact') jsonOnly = await researchImpact(args.slice(1));
  else if (args[0] === 'spec') jsonOnly = await researchSpec(args.slice(1));
  else throw new ConstructError('Usage: construct research summarize|doctor|workflow|impact|spec ...', { exitCode: EXIT_CODES.USAGE_ERROR });
  if (!jsonOnly) printAttribution(READ_ONLY_ATTRIBUTION.tool, READ_ONLY_ATTRIBUTION.llm);
}

/**
 * `construct refactor move <name> --feature <f> --from <layer> --to <layer>`
 * | `construct refactor rename <name> <newName> --feature <f> --layer <layer>`
 * | `construct refactor extract-expression <file> [--range <start:end>] [--name <Name>]`
 * | `construct refactor wrap <Name> --feature <f> --provider <hook> [--dry-run]` (wrap a component or page with a provider of the project, #631).
 * Purely mechanical (relocate + rewrite every importer's path, or hoist a
 * flagged inline conditional/loop into a named unit) — never invents new
 * business logic. Reports the result, then re-validates the changed file(s)
 * so a naming/purity mismatch in their new home shows up immediately instead
 * of on the next full `construct validate`.
 *
 * @param {string[]} args `move <name> --feature <f> --from <layer> --to <layer>`, `rename <name> <newName> --feature <f> --layer <layer>`, or `extract-expression <file> [--range <start:end>] [--name <Name>]`.
 * @returns {Promise<void>} Resolves after the change (or dry run) is reported.
 * @throws {ConstructError} Usage error (exit code 2) for an unknown subcommand.
 */
export async function refactor(args) {
  if (flagValue(args, '--format') === 'json') return printJsonResult(() => refactorDocument(args));
  if (args[0] === 'move') return refactorMove(args.slice(1));
  if (args[0] === 'rename') return refactorRename(args.slice(1));
  if (args[0] === 'extract-expression') return refactorExtractExpression(args.slice(1));
  if (args[0] === 'wrap') return refactorWrap(args.slice(1));
  throw new ConstructError('Usage: construct refactor move|rename|extract-expression|wrap ...', { exitCode: EXIT_CODES.USAGE_ERROR });
}

// This printed line is the entire audit trail for a refactor command by
// design (no persistent log) — every construct-driven change gets one clear,
// scannable summary; a file changed without one wasn't done by the tool.
function reportRelocation(root, verb, result) {
  const violations = result.dryRun ? [] : validateArchitecture(root, { files: [result.to] }).violations;
  for (const line of relocationLines(verb, result, violations)) console.log(line);
  if (!result.dryRun) printAttribution(RELOCATE_ATTRIBUTION.tool, RELOCATE_ATTRIBUTION.llm);
}

/** The printed lines of a relocation, without the attribution: one source for the text CLI and the Cockpit's `cli` mode. */
function relocationLines(verb, result, violations) {
  if (result.dryRun) {
    return [
      `Dry run (${result.engine}${result.tsVersion ? ` ${result.tsVersion}` : ''}): would change ${result.files.length} file(s) to move ${result.from} -> ${result.to}:`,
      ...result.files.map((f) => `  ${f}`),
      ...(result.note ? [`Note: ${result.note}`] : []),
    ];
  }
  return [
    `${verb} ${result.from} -> ${result.to} (${result.importersUpdated} importer(s) updated)`,
    ...(result.note ? [`Note: ${result.note}`] : []),
    ...(violations.length ? [formatReport(violations, { format: 'text' })] : []),
  ];
}

/**
 * The text lines of a `refactor move|rename --format json` document, as `construct refactor` prints them (without
 * the attribution line, which the document carries as `attribution`). The Cockpit's `cli` execution mode shows these.
 *
 * @param {object} doc A `refactor ... --format json` document.
 * @returns {string[]} The printed lines.
 */
export function renderRefactorText(doc) {
  return relocationLines(doc.action === 'move' ? 'Moved' : 'Renamed', doc, doc.violations ?? []);
}

/**
 * The text lines of a `create ... --format json` document: one `Created <path>` line per scaffolded file (the text
 * CLI adds per-file timings, which are not part of the deterministic document).
 *
 * @param {object} doc A `create ... --format json` document.
 * @returns {string[]} The lines to show.
 */
export function renderCreateText(doc) {
  return doc.kind === 'feature' ? [`Created feature ${doc.feature} at ${doc.path}`] : doc.files.map((f) => `Created ${f}`);
}

/**
 * The text lines of an `import ... --format json` document, as `construct import` prints them minus its timings.
 *
 * @param {object} doc An `import ... --format json` document.
 * @returns {string[]} The lines to show.
 */
export function renderImportText(doc) {
  const featureNote = doc.mode === 'plan' && doc.feature ? ` --feature ${doc.feature}` : '';
  return [
    ...doc.results.flatMap((r) => [`${r.name}: scaffolded ${r.files.length} file(s) from ${r.source}`, ...r.files.map((f) => `  ${f}`)]),
    `Next (needs judgment, not a tool): fill in each TODO(import) marker across ${doc.results.length} logical unit(s), then run validate${featureNote}.`,
  ];
}

/** The attribution of a `refactor move|rename`: mechanical, no model call. */
const RELOCATE_ATTRIBUTION = Object.freeze({ tool: "relocated/renamed the file and rewrote every importer's path", llm: '0 calls — content and the exported identifier are untouched' });

// `refactor move|rename` -- argument checks and the mechanical relocation, shared by the text form (which
// prints a line per file) and the `--format json` form (which returns the result document).
function relocateMove(args) {
  const name = args[0], fi = args.indexOf('--feature'), fromI = args.indexOf('--from'), toI = args.indexOf('--to');
  if (!name || fi < 0 || !args[fi + 1] || fromI < 0 || !args[fromI + 1] || toI < 0 || !args[toI + 1]) {
    throw new ConstructError(
      'Usage: construct refactor move <name> --feature <feature> --from <layer> --to <layer>',
      { exitCode: EXIT_CODES.USAGE_ERROR },
    );
  }
  const root = getRoot(args);
  return { root, result: moveLayerFile(root, args[fi + 1], name, args[fromI + 1], args[toI + 1], { dryRun: args.includes('--dry-run') }) };
}

function relocateRename(args) {
  const name = args[0], newName = args[1], fi = args.indexOf('--feature'), li = args.indexOf('--layer');
  if (!name || !newName || fi < 0 || !args[fi + 1] || li < 0 || !args[li + 1]) {
    throw new ConstructError(
      'Usage: construct refactor rename <name> <newName> --feature <feature> --layer <layer>',
      { exitCode: EXIT_CODES.USAGE_ERROR },
    );
  }
  const root = getRoot(args);
  return { root, result: renameLayerFile(root, args[fi + 1], name, newName, args[li + 1], { dryRun: args.includes('--dry-run') }) };
}

async function refactorMove(args) {
  const { root, result } = relocateMove(args);
  reportRelocation(root, 'Moved', result);
}

async function refactorRename(args) {
  const { root, result } = relocateRename(args);
  reportRelocation(root, 'Renamed', result);
}

/** The result document of `refactor move|rename ... --format json`: the relocation result, plus the architecture
 * violations re-checked in the file's new home (none for a dry run, which changes nothing). */
async function refactorDocument(args) {
  const action = args[0];
  if (action === 'wrap') {
    const request = wrapRequestOf(args.slice(1));
    const root = getRoot(args);
    if (!request.provider) throw usageFail(providerChoiceLines(root, request).join('\n'));
    const dryRun = args.includes('--dry-run');
    const result = wrapProvider(root, request, { dryRun });
    const violations = dryRun || !result.changed ? [] : validateArchitecture(root, { files: [result.file] }).violations;
    return { verb: 'refactor', action, file: result.file, changed: result.changed, dryRun, message: result.message, provider: result.provider, root: result.root, notes: result.notes, violations, attribution: dryRun || !result.changed ? null : { ...WRAP_ATTRIBUTION } };
  }
  if (action !== 'move' && action !== 'rename') throw usageFail('refactor --format json covers `move`, `rename` and `wrap`; `extract-expression` has no JSON form yet. Usage: construct refactor move|rename|wrap ... [--format json]');
  const { root, result } = (action === 'move' ? relocateMove : relocateRename)(args.slice(1));
  const violations = result.dryRun ? [] : validateArchitecture(root, { files: [result.to] }).violations;
  return { verb: 'refactor', action, ...result, violations, attribution: result.dryRun ? null : { ...RELOCATE_ATTRIBUTION } };
}

/** The attribution of `refactor wrap`: a text splice at the offsets of the element, no model call. */
const WRAP_ATTRIBUTION = Object.freeze({ tool: 'wrapped the element with the provider (a minimal edit of the file that renders it)', llm: '0 calls, the edit is a fixed splice' });

/** The request of `construct refactor wrap <Name> --feature <f> --provider <hook> [--dry-run]` (#631). Without --provider the closed list of providers is printed. */
function wrapRequestOf(args) {
  const name = args[0];
  const feature = flagValue(args, '--feature');
  if (!name || name.startsWith('--') || !feature) throw usageFail('Usage: construct refactor wrap <Name> --feature <feature> --provider <hook> [--dry-run] [--dir <path>]');
  if (args.includes('--llm')) throw usageFail('Wrapping with a provider is a fixed edit with no model, so it cannot be combined with --llm. Run it without --llm.');
  return { name, feature, provider: flagValue(args, '--provider') };
}

/** The lines that say which providers exist, for a wrap asked without one. */
function providerChoiceLines(root, request) {
  const offer = providerOffer(root, request);
  if (!offer) return ['This project has no provider: a hook named use<Name>Provider built with defineProvider in features/*/hooks/.'];
  return ['Which provider? Run again with --provider <id>:', ...offer.question.options.filter((o) => o.id !== 'none').map((o) => `  ${o.id}${o.enabled ? '' : ' (not usable)'}  ${o.why}`), ...(offer.hidden ? [`  (${offer.hidden} more not shown)`] : [])];
}

/** `construct refactor wrap CartPage --feature cart --provider useCartProvider [--dry-run]` (#631): wrap the element with the provider in the controller that renders it. */
async function refactorWrap(args) {
  const request = wrapRequestOf(args);
  const root = getRoot(args);
  if (!request.provider) throw usageFail(providerChoiceLines(root, request).join('\n'));
  const result = wrapProvider(root, request, { dryRun: args.includes('--dry-run') });
  console.log(result.message);
  if (args.includes('--dry-run') && result.changed) {
    for (const row of buildDiffView(result.before, result.after).rows) console.log(row.kind === 'gap' ? `  ... ${row.text}` : `${{ added: '+', removed: '-', context: ' ' }[row.kind]} ${row.text}`);
  }
  if (result.changed && !args.includes('--dry-run')) {
    const { violations } = validateArchitecture(root, { files: [result.file] });
    if (violations.length) console.log(formatReport(violations, { format: 'text' }));
  }
  for (const note of result.notes) console.log(`Note: ${note}`);
  if (result.changed && !args.includes('--dry-run')) printAttribution(WRAP_ATTRIBUTION.tool, WRAP_ATTRIBUTION.llm);
}

async function refactorExtractExpression(args) {
  const file = args[0];
  if (!file) {
    throw new ConstructError(
      'Usage: construct refactor extract-expression <file> [--range <start:end>] [--name <Name>] [--dry-run]',
      { exitCode: EXIT_CODES.USAGE_ERROR },
    );
  }
  const root = getRoot(args);
  const rangeI = args.indexOf('--range');
  let range;
  if (rangeI >= 0) {
    const raw = args[rangeI + 1] || '';
    const m = raw.match(/^(\d+):(\d+)$/);
    if (!m) throw new ConstructError(`--range must be "<start>:<end>" (two source offsets), got "${raw}".`, { exitCode: EXIT_CODES.USAGE_ERROR });
    range = [Number(m[1]), Number(m[2])];
  }
  const nameI = args.indexOf('--name');
  const result = extractExpression(root, file, {
    range,
    name: nameI >= 0 ? args[nameI + 1] : undefined,
    dryRun: args.includes('--dry-run'),
  });
  if (result.dryRun) {
    console.log(`Dry run: would extract into ${result.expression.file}${result.components.length ? ` (+ ${result.components.map((c) => c.file).join(', ')})` : ''}, rewriting ${result.page.file}.`);
    printAttribution('extracted a flagged inline conditional/loop into a named @expression unit', '0 calls — the shape is copied from the flagged code itself');
    return;
  }
  console.log(`Extracted ${result.expression.name} from ${result.page.file} -> ${result.expression.file}`);
  for (const c of result.components) console.log(`  hoisted native markup -> ${c.file} (${c.name})`);
  const touched = [result.page.file, result.expression.file, ...result.components.map((c) => c.file)];
  const { violations } = validateArchitecture(root, { files: touched });
  if (violations.length) console.log(formatReport(violations, { format: 'text' }));
  printAttribution('extracted a flagged inline conditional/loop into a named @expression unit', '0 calls — the shape is copied from the flagged code itself');
}

/**
 * `construct import <name> --feature <feature> --layers <l1,l2,...> --from <path> [--llm <provider>]`
 * | `construct import --plan <path> [--llm <provider>]`.
 * Scaffolds layers exactly like `create layer` — always deterministic, same
 * as everything else in this file. With no `--llm`: prepends a TODO
 * breadcrumb to each generated file pointing at its source, and stops —
 * writing the ported logic is left to whoever (human or LLM) does it next.
 * With `--llm <provider>` (currently only "claude" is supported): calls that
 * provider once per generated file to write the ported logic directly. This
 * is the one place in Construct that ever calls an LLM, and only when this
 * flag is explicitly given — locating the source and scaffolding the files
 * themselves never involves one either way. `--plan` is the batch form: an
 * approved plan (produced by whichever LLM analyzed a whole existing
 * feature — Construct never does that analysis itself) runs the same step
 * once per unit, in one command.
 *
 * @param {string[]} args `<name> --feature <f> --layers <l1,l2,...> --from <path> [--llm <provider>]`, or `--plan <path> [--llm <provider>]` for a batch.
 * @returns {Promise<void>} Resolves once the layers are scaffolded (and filled, with `--llm`).
 * @throws {ConstructError} Usage error (exit code 2) for missing flags, or for `--route`, which must be run directly from a shell.
 */
export async function importCommand(args) {
  if (args[0] === '--route') {
    throw new ConstructError(
      'construct import --route <path> is a standalone interactive command — run it directly from your shell (not from inside `construct repl`, which is already reading its own input).',
      { exitCode: EXIT_CODES.USAGE_ERROR },
    );
  }
  if (flagValue(args, '--format') === 'json') return printJsonResult(() => importDocument(args));
  const llmI = args.indexOf('--llm');
  const llm = llmI >= 0 ? args[llmI + 1] : undefined;
  const planI = args.indexOf('--plan');
  if (planI >= 0) return importFromPlan(args, llm);

  const name = args[0], fi = args.indexOf('--feature'), li = args.indexOf('--layers'), fromI = args.indexOf('--from');
  if (!name || fi < 0 || !args[fi + 1] || li < 0 || !args[li + 1] || fromI < 0 || !args[fromI + 1]) {
    throw new ConstructError(
      'Usage: construct import <name> --feature <feature> --layers <l1,l2,...> --from <path> [--llm <provider>]\n   or: construct import --plan <path> [--llm <provider>]\n   or: construct import --route <path>  (run directly, not inside repl)',
      { exitCode: EXIT_CODES.USAGE_ERROR },
    );
  }
  const root = getRoot(args);
  const layers = args[li + 1].split(',').map((l) => l.trim()).filter(Boolean);
  const { source, files, fills, timings } = await importVertical(root, name, args[fi + 1], layers, args[fromI + 1], { llm });
  reportImport(root, [{ name, source, files, fills, timings }], llm);
}

async function importFromPlan(args, llm) {
  const planI = args.indexOf('--plan');
  if (!args[planI + 1]) {
    throw new ConstructError('Usage: construct import --plan <path> [--llm <provider>]', { exitCode: EXIT_CODES.USAGE_ERROR });
  }
  const root = getRoot(args);
  const { feature, results } = await importPlan(root, args[planI + 1], { llm });
  reportImport(root, results, llm, feature);
}

// Shared reporting for both import forms — one clear tool/llm-attributed
// summary either way, matching every other capability group. `analysisSeconds`
// (#166, route-wizard only) folds the one whole-route analysis LLM call into
// the printed Total, same as every per-file LLM-fill call already is.
function reportImport(root, results, llm, feature, analysisCalls = 0, analysisSeconds = 0) {
  let totalFiles = 0;
  const problems = [];
  let totalSeconds = analysisSeconds;
  for (const r of results) {
    const unfilled = (r.fills || []).filter((f) => f.status !== 'filled');
    const scaffoldNote = r.timings ? ` (scaffold ${formatDuration(r.timings.scaffoldSeconds)})` : '';
    console.log(`${r.name}: ${llm && !unfilled.length ? 'scaffolded + LLM-filled' : 'scaffolded'} ${r.files.length} file(s) from ${r.source}${scaffoldNote}`);
    for (const file of r.files) {
      const miss = unfilled.find((f) => f.file === file);
      const ft = r.timings?.files.find((f) => f.file === file);
      const llmNote = llm && ft ? ` (llm ${formatDuration(ft.llmSeconds)})` : '';
      console.log(`  ${path.relative(root, file)}${llmNote}${miss ? `  <- ${miss.status === 'rejected' ? "model output rejected" : 'LLM call failed'}, stub + TODO(import) kept` : ''}`);
      // #522 -- same hint reportFill prints for create/generate's --llm fill, for import's.
      const fixCommand = (r.fills || []).find((f) => f.file === file)?.fixCommand;
      if (fixCommand) printExtractExpressionHint(fixCommand);
    }
    problems.push(...unfilled);
    totalFiles += r.files.length;
    if (r.timings) totalSeconds += r.timings.totalSeconds;
  }
  console.log(`Total: ${formatDuration(totalSeconds)}`);
  if (problems.length) {
    console.log(`${problems.length} of ${totalFiles} file(s) were NOT filled by "${llm}" — the scaffolded stub and its TODO(import) breadcrumb were left in place:`);
    for (const p of problems) {
      console.log(`  ${path.relative(root, p.file)}: ${p.status === 'rejected' ? "the model's output was rejected" : 'the LLM call failed'} after ${p.attempts} attempt(s) — ${p.reason}`);
    }
    setExitCode(EXIT_CODES.INTERNAL_ERROR);
  }
  const featureNote = feature ? ` --feature ${feature}` : '';
  const analysisNote = analysisCalls ? `${analysisCalls} call(s) to analyze the route + ` : '';
  if (llm) {
    console.log(
      problems.length
        ? `Next: fill in the ${problems.length} TODO(import) marker(s) listed above (by hand, or re-run import for them), review the ${totalFiles - problems.length} ported file(s) against their source, then run validate${featureNote}.`
        : `Next: review the ported logic above (diff against the source), then run validate${featureNote}.`,
    );
    printAttribution(
      `scaffolded ${totalFiles} file(s) across ${results.length} logical unit(s)`,
      `${analysisNote}${totalFiles - problems.length} of ${totalFiles} file(s) written via "${llm}" (${problems.length} left as stub + TODO) — review it before trusting it`,
    );
  } else {
    console.log(`Next (needs judgment, not a tool): fill in each TODO(import) marker across ${results.length} logical unit(s), then run validate${featureNote}.`);
    const a = noLlmImportAttribution(totalFiles, results.length, analysisNote);
    printAttribution(a.tool, a.llm);
  }
}

/** The attribution of an import that made no model call for the port (`analysisNote` names a plan-analysis call, if any). */
function noLlmImportAttribution(totalFiles, units, analysisNote = '') {
  return {
    tool: `scaffolded ${totalFiles} file(s) across ${units} logical unit(s) and wrote a TODO(import) breadcrumb in each`,
    llm: analysisNote
      ? `${analysisNote}0 calls to write the logic — that's next, by you or whichever LLM you choose`
      : '0 calls — reading the source(s) and writing the ported logic is next, by you or whichever LLM you choose',
  };
}

/** The result document of `import ... --format json` (no `--llm`): what was scaffolded, per logical unit, and where from. */
async function importDocument(args) {
  refuseNonDeterministicFlags('import', args, ['--llm', '--route']);
  const planI = args.indexOf('--plan');
  let root, results, feature, mode;
  if (planI >= 0) {
    if (!args[planI + 1]) throw usageFail('Usage: construct import --plan <path> [--llm <provider>]');
    mode = 'plan';
    root = getRoot(args);
    ({ feature, results } = await importPlan(root, args[planI + 1], {}));
  } else {
    const name = args[0], fi = args.indexOf('--feature'), li = args.indexOf('--layers'), fromI = args.indexOf('--from');
    if (!name || name.startsWith('--') || fi < 0 || !args[fi + 1] || li < 0 || !args[li + 1] || fromI < 0 || !args[fromI + 1]) {
      throw usageFail('Usage: construct import <name> --feature <feature> --layers <l1,l2,...> --from <path> [--llm <provider>]\n   or: construct import --plan <path> [--llm <provider>]\n   or: construct import --route <path>  (run directly, not inside repl)');
    }
    mode = 'unit';
    root = getRoot(args);
    feature = args[fi + 1];
    const layers = args[li + 1].split(',').map((l) => l.trim()).filter(Boolean);
    const { source, files } = await importVertical(root, name, feature, layers, args[fromI + 1], {});
    results = [{ name, source, files }];
  }
  const units = results.map((r) => ({ name: r.name, source: r.source, files: r.files.map((f) => path.relative(root, f)) }));
  const totalFiles = units.reduce((n, u) => n + u.files.length, 0);
  return { verb: 'import', mode, ...(feature ? { feature } : {}), results: units, attribution: noLlmImportAttribution(totalFiles, units.length) };
}

// ---- import --route: interactive, whole-feature import wizard -------------
//
// A standalone interactive command — packages/cli/construct.mjs dispatches it
// directly, bypassing importCommand entirely, and it consumes stdin itself
// via its own line source. Deliberately NOT runnable from inside `construct
// repl` (which is already consuming the same stdin): importCommand's
// `--route` branch below exists only to explain that redirect, not to run
// it. Asks a few questions, calls "claude" once to analyze the route and
// propose a plan, shows it, and writes nothing until you explicitly
// approve it.

function renderPlanTable(plan) {
  const lines = [`Proposed plan for feature "${plan.feature}" (${plan.units.length} unit(s)):`, ''];
  for (const [i, u] of plan.units.entries()) {
    lines.push(`  ${i + 1}. ${u.name.padEnd(24)} ${u.layers.join(', ').padEnd(28)} <- ${u.from}`);
    for (const layer of u.layers) if (u.reasons?.[layer]) lines.push(`       ${layer}: ${u.reasons[layer]}`);
  }
  return lines.join('\n');
}

function isYes(answer) {
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

/** The wizard's actual flow, decoupled from where its questions come from —
 * `ask` is an async `(promptText) => answer` function, so this is directly
 * unit-testable with a fake, scripted `ask` and never needs a real
 * terminal. `runImportRouteWizard` below is the only caller that wires it
 * to real stdin/stdout.
 *
 * Guides the whole thing end to end in one session: creates the
 * destination feature if it doesn't exist yet (never touches it if it
 * does — no re-scaffolding over real content), loops asking for as many
 * source directories as the old feature actually spans (analyzed together,
 * as one combined plan, not one call per directory), builds on approval,
 * then immediately validates and states exactly what's left — a TODO count
 * to fill in, or a reminder to review LLM-written output — rather than
 * leaving you to go find that out yourself. `seedRoute` (optional) is just
 * the first route, so `construct import --route <path>` can still seed the
 * loop instead of asking for it as question one.
 *
 * A "route" means something different per `config.project.framework`
 * (resolveRoute in route-resolver.mjs is framework-ready — #66): for the
 * default `nextjs`, a URL like `/v2/home` or, equivalently, the folder that
 * owns its `page.tsx` — a URL route needs to know where the `app/`
 * directory is, so that's asked for once, lazily, and reused for every
 * further route this session. For `react-spa`, a URL like `/dashboard`
 * (resolved through the project's centralized routes table) or an existing
 * controller file path directly — no directory question at all, since the
 * routes table is auto-located by convention from the project root. Either
 * way, the actual file list comes from tracing the real import graph
 * (route-resolver.mjs), never from "everything under a directory you point
 * at". */
export async function importRouteWizard(ask, seedRoute, { planAnalysis = 'claude', importFill = 'claude', planner = 'ai', onStep, onThought, onWritten, signal } = {}) {
  // #599 -- two SEPARATE kinds of live output, kept apart on purpose so a UI can style them
  // differently: `onStep` receives the framework's own deterministic phase markers
  // ({phase, detail}: tracing, analyzing, plan-ready, scaffolding, filling, validating,
  // auto-fixing, done, cancelled), and `onThought` receives the model's own streamed output text.
  // `signal` (an AbortSignal) cancels an in-flight model call and stops the run.
  // `reason` is the framework's own why for this block, shown under the step so the deterministic side
  // explains itself the way the model's stream does.
  const step = (phase, detail = {}, reason) => onStep?.({ phase, detail, ...(reason ? { reason } : {}) });
  const llmOptions = { ...(onThought ? { onChunk: onThought } : {}), ...(signal ? { signal } : {}) };
  // Whole-feature plan analysis is deliberately hosted-model-only (#96) — the
  // same guardrail ui/server's Settings enforces, repeated here so a direct
  // caller can't route it to a local model either.
  if (planner !== 'mechanical' && planAnalysis === 'ollama') {
    console.error('Plan analysis cannot use "ollama" — the whole-feature analysis call is hosted-model-only (see epic #96). Use "claude" for planAnalysis.');
    return;
  }
  const featureName = (await ask('Destination feature (Construct feature name): ')).trim();
  if (!featureName) {
    console.log('Cancelled — no feature name given.');
    return;
  }

  const root = getRoot([]);
  const config = loadConfig(root);
  const featuresRoot = config.features?.root || 'features';
  const framework = config.project?.framework || 'nextjs';
  // #677: was an inline `if (!fs.existsSync(featureDir)) { createFeature(...); ... }` --
  // functionally the same directory check generators.mjs's `ensureFeatureExists` now shares with
  // every other create.* flow, so this wizard uses that one function instead of its own duplicate
  // of the same logic. "never touches it if it does" still holds for an already-real feature.
  if (ensureFeatureExists(root, featureName)) {
    console.log(`(feature "${featureName}" didn't exist yet — created it)`);
  }

  function isExistingDir(p) {
    try {
      return fs.statSync(path.resolve(p)).isDirectory();
    } catch {
      return false;
    }
  }

  // react-spa has no per-route entry file to point at directly the way a
  // Next.js route folder does — the equivalent "already resolved, no
  // further lookup needed" case is an existing *controller file* (mirrors
  // resolveReactSpaRoute's own existing-file branch in route-resolver.mjs).
  function isExistingFile(p) {
    try {
      return fs.statSync(path.resolve(p)).isFile();
    } catch {
      return false;
    }
  }

  let appDir;
  async function resolveAppDir() {
    if (appDir) return appDir;
    const guess = ['src/app', 'app']
      .map((p) => path.join(root, p))
      .find((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
    const answer = (
      await ask(`Path to your Next.js app/ directory (needed to resolve a URL route)${guess ? ` [${path.relative(root, guess)}]` : ''}: `, { expects: 'dir' })
    ).trim();
    appDir = answer ? path.resolve(answer) : guess;
    if (!appDir) {
      throw new ConstructError('No app directory given or found — cannot resolve a URL route.', { exitCode: EXIT_CODES.USAGE_ERROR });
    }
    return appDir;
  }

  const routeArgs = seedRoute ? [seedRoute] : [];
  while (true) {
    const prompt = routeArgs.length === 0
      ? (framework === 'react-spa'
        ? 'Route to import (a URL like /dashboard, or a controller file path): '
        : 'Route to import (a URL like /v2/home, or a route folder path): ')
      : `Another route to include (leave blank to finish — ${routeArgs.length} so far): `;
    const answer = (await ask(prompt, { expects: 'route' })).trim();
    if (!answer) {
      if (routeArgs.length === 0) {
        console.log('Cancelled — no route given.');
        return;
      }
      break;
    }
    routeArgs.push(answer);
  }

  const fillWithLlm = isYes(
    await ask('After you approve the plan, should the LLM also write the ported logic (not just TODO breadcrumbs)? [y/N]: '),
  );

  step('tracing', { routes: routeArgs }, 'Follows the real import statements from the route\'s entry file (parsed, not guessed), so only files it actually depends on are included.');
  console.log(`Tracing ${routeArgs.join(', ')} ...`);
  const traceStart = startTimer();
  const tracedFiles = new Map(); // absolute path -> true, deduped across routes
  const entryFiles = []; // each route's own entry file (first traced), the page/controller of the plan
  const folders = [];
  try {
    for (const routeArg of routeArgs) {
      let opts;
      if (framework === 'react-spa') {
        // No app/-directory question for react-spa: resolveRoute already
        // auto-locates the centralized routes table (src/App.tsx/.jsx) by
        // convention from `root` (#66) — an existing controller file needs
        // nothing further.
        opts = isExistingFile(routeArg) ? { framework } : { framework, root, featuresRoot };
      } else {
        opts = isExistingDir(routeArg) ? {} : { appDir: await resolveAppDir() };
      }
      const resolved = resolveRoute(routeArg, opts);
      folders.push(resolved.folder);
      if (resolved.files[0]) entryFiles.push(resolved.files[0]);
      for (const f of resolved.files) tracedFiles.set(f, true);
    }
  } catch (e) {
    console.error(`Route resolution failed: ${e.message}`);
    return;
  }

  console.log(
    `Found ${tracedFiles.size} file(s) across ${folders.length} route(s) in ${formatDuration(elapsedSeconds(traceStart))}: ${folders.map((f) => path.relative(root, f)).join(', ')}`,
  );
  let plan;
  const analysisStart = startTimer();
  if (planner === 'mechanical') {
    console.log('Planning mechanically — reading each file\'s syntax tree, no model call, nothing is written yet...');
    step('analyzing', { provider: 'mechanical', files: tracedFiles.size }, 'No model is involved: each file is classified from what its code does (JSX, its own state, fetch/storage, reducer shape, plain functions) and the reason is shown per layer.');
    try {
      plan = planMechanically([...tracedFiles.keys()], featureName, { entryFiles });
    } catch (e) {
      console.error(`Planning failed: ${e.message}`);
      return;
    }
    if (!plan.units.length) {
      console.error(`Planning failed: none of the ${tracedFiles.size} traced file(s) could be classified (${plan.skipped.map((k) => `${path.basename(k.file)}: ${k.reason}`).join('; ')}).`);
      return;
    }
  } else {
    console.log(
      `Analyzing via "${planAnalysis}" — one LLM call for a single combined plan across all of them, nothing is written yet...`,
    );
    step('analyzing', { provider: planAnalysis, files: tracedFiles.size }, 'One model call proposes the units and layers; the framework then checks every layer name and source file it names and repairs impossible combinations (a controller always gets its page).');
    try {
      plan = await analyzeFiles([...tracedFiles.keys()], featureName, { llm: planAnalysis, llmOptions });
    } catch (e) {
      console.error(`Analysis failed: ${e.message}`);
      return;
    }
  }
  const analysisSeconds = elapsedSeconds(analysisStart);
  console.log(planner === 'mechanical' ? `Plan ready (mechanical, ${formatDuration(analysisSeconds)}).` : `Analysis complete (llm ${formatDuration(analysisSeconds)}).`);

  step('plan-ready', { units: plan.units.length }, plan.layerAdjustments?.length ? `Repaired the plan deterministically: ${plan.layerAdjustments.map((a) => `added ${a.added.join(', ')} to ${a.unit}`).join('; ')} (a controller composes a same-named page). Nothing is written until you approve.` : 'Nothing is written until you approve this plan.');
  console.log('');
  console.log(renderPlanTable(plan));
  if (plan.skipped?.length) console.log(`Left out (not a layer of their own): ${plan.skipped.map((k) => `${path.basename(k.file)} — ${k.reason}`).join('; ')}`);
  console.log('');

  if (!isYes(await ask('Approve this plan and build it now? [y/N]: '))) {
    console.log('Import cancelled — nothing written.');
    return;
  }

  step('scaffolding', { feature: plan.feature }, 'Layer files come from Construct\'s own templates in build order (domain → service → workflow → hook → component → page → controller); no model is involved.');
  const { results, cancelled: fillCancelled } = await executeImportPlan(root, plan, { llm: fillWithLlm ? importFill : undefined, llmOptions, onStep: (s) => step(s.phase, s.detail, s.phase === 'filling' ? 'The model ports this one file; if its output is unusable the file keeps its scaffolded stub and breadcrumb.' : undefined) });
  reportImport(root, results, fillWithLlm ? importFill : undefined, plan.feature, planner === 'mechanical' ? 0 : 1, analysisSeconds);
  onWritten?.({ root, plan, results });
  if (fillCancelled) {
    step('cancelled', { during: 'filling' });
    console.log('Cancelled — files not yet filled were left as their TODO(import) stubs; nothing was half-written.');
    return;
  }

  console.log('');
  // A model's most common slip is the spelling of a sibling import (`../services/ordersApi` for `OrdersApi.tsx`); fixing it is exact-match work, so it is done here instead of by a retry.
  const importRepairs = repairRelativeImports(results.flatMap((r) => r.files));
  if (importRepairs.length) {
    step('validating', { feature: plan.feature }, `Fixed the spelling of ${importRepairs.length} relative import(s) that matched a generated file only by case; no model call was needed.`);
    for (const r of importRepairs) console.log(`Import repaired in ${path.relative(root, r.file)}: '${r.from}' -> '${r.to}'`);
  }
  // The public API is deterministic work, not a model's: export every new layer file from index.ts (with a JSDoc line each) so SLICE-003/READ-003 never fire on what we just generated.
  const apiSync = syncPublicApi(root, plan.feature);
  if (apiSync.changed) console.log(`Updated ${apiSync.path} (the feature's public API) with the new exports.`);
  step('validating', { feature: plan.feature }, 'Runs every construct-validate enforcer on the new feature. The model\'s output is only trusted once this passes.');
  console.log(`Running validate --feature ${plan.feature} ...`);
  const validateStart = startTimer();
  const { violations } = aggregateValidation(root, DEFAULT_ENFORCERS);
  let scoped = violations.filter((v) => v.file.startsWith(`${featuresRoot}/${plan.feature}/`));
  console.log(formatReport(scoped, { format: 'text' }));
  console.log(`Validated in ${formatDuration(elapsedSeconds(validateStart))}.`);

  // #496/#601 -- offer a real correction pass, not just the report: only when this run already
  // called the model once (fillWithLlm) and only against files this import itself just wrote, so
  // a pre-existing violation elsewhere in the project is never silently "fixed" without being asked
  // about. Bounded (autoFixViolations' own maxAttempts, default 2) and interruptible the same way
  // the rest of this wizard is -- Ctrl+C at any point stops it; there is no separate stop control
  // to build here.
  const importedRelFiles = new Set(results.flatMap((r) => r.files).map((f) => path.relative(root, f)));
  const fixableViolations = scoped.filter((v) => importedRelFiles.has(v.file));
  if (fillWithLlm && fixableViolations.length) {
    const affectedFiles = [...new Set(fixableViolations.map((v) => v.file))];
    const wantsFix = isYes(
      await ask(
        `Try to auto-fix ${fixableViolations.length} violation(s) in ${affectedFiles.length} file(s) with "${importFill}"? It plans first, then keeps trying each file (up to 5 attempts, each told what earlier attempts left behind) and stops early if it stops making progress. Cancel or Ctrl+C stops it at any time. [y/N]: `,
      ),
    );
    if (wantsFix) {
      step('auto-fixing', { files: affectedFiles }, 'Errors first, then files with the most violations. Each retry is told what earlier attempts left behind and sees the other files of this unit; it stops early if two attempts in a row change nothing.');
      const { fixed, stillFailing, cancelled: fixCancelled } = await autoFixViolations(
        root,
        affectedFiles,
        (r) => aggregateValidation(r, DEFAULT_ENFORCERS),
        {
          llm: importFill,
          llmOptions,
          siblingFiles: [...importedRelFiles],
          onPlan: (plan) => {
            console.log(`Fix plan (${plan.length} file(s), errors first):`);
            for (const item of plan) {
              console.log(`  ${item.file}`);
              for (const v of item.violations) console.log(`    - ${v.rule} (line ${v.line}): ${v.message}${v.suggestedFix ? ` → ${v.suggestedFix}` : ''}`);
            }
          },
          onAttempt: ({ file, attempt, violations: v }) => {
            step('auto-fixing', { files: affectedFiles, file, attempt });
            console.log(`  Attempt ${attempt} on ${file}: fixing ${v.length} violation(s) (${v.map((x) => x.rule).join(', ')})...`);
          },
        },
      );
      if (fixCancelled) {
        step('cancelled', { during: 'auto-fixing' });
        console.log('Cancelled — auto-fix stopped; files keep their last valid content.');
        return;
      }
      if (fixed.length) console.log(`Fixed: ${fixed.map((f) => `${f.file} (${f.attempts} attempt(s))`).join(', ')}`);
      if (stillFailing.length) {
        console.log(`Still failing after auto-fix — review manually: ${stillFailing.map((f) => `${f.file} (${f.reason}, ${f.attempts} attempt(s))`).join(', ')}`);
      }
      const revalidated = aggregateValidation(root, DEFAULT_ENFORCERS);
      scoped = revalidated.violations.filter((v) => v.file.startsWith(`${featuresRoot}/${plan.feature}/`));
      console.log(formatReport(scoped, { format: 'text' }));
    }
  }

  const allFiles = results.flatMap((r) => r.files);
  const todoFiles = allFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('TODO(import)'));
  if (fillWithLlm) {
    console.log(`Review the ${allFiles.length - todoFiles.length} LLM-written file(s) above against their source before trusting them.`);
  }
  if (fillWithLlm && !todoFiles.length) {
    step('done', { files: allFiles.length, todo: 0 });
    return;
  }
  console.log(
    todoFiles.length
      ? `${todoFiles.length} of ${allFiles.length} file(s) still have a TODO(import) marker to fill in — that's what's left before this feature is done:`
      : 'No TODO(import) markers left — nothing further needed from this pass.',
  );
  for (const f of todoFiles) console.log(`  ${path.relative(root, f)}`);
  step('done', { files: allFiles.length, todo: todoFiles.length });
}

export async function runImportRouteWizard(routeArg, options = {}) {
  const lineSource = makeLineSource(process.stdin);
  async function ask(promptText) {
    process.stdout.write(promptText);
    const { done, value } = await lineSource.next();
    return done ? '' : value;
  }
  await importRouteWizard(ask, routeArg, options);
}

// ---- event-driven adapter for non-terminal callers (e.g. a chat UI) -------
//
// `importRouteWizard(ask, seedRoute)` above is already decoupled from real
// stdin/stdout via its abstract `ask` callback, but it's still shaped for a
// blocking terminal session: every prompt and every progress line goes out
// via a synchronous `console.log`/`console.warn`/`console.error` call
// interleaved with `await ask(...)`. A chat UI instead needs a running,
// incremental conversation — each progress line delivered the moment it
// happens, and the "next question" delivered as its own event rather than
// blocking a request/response cycle on the terminal's stdin.
//
// This wraps the *existing*, unmodified `importRouteWizard` rather than
// rewriting it: every console call made anywhere inside the wizard's run
// (including from functions it calls into, like `reportImport` and
// `formatReport`) is captured as an ordered `{ type: 'log', text }` event,
// and `ask` is driven by an externally-resolved promise instead of a real
// line source. The REPL/CLI/wizard tests exercise `importRouteWizard` and
// `runImportRouteWizard` directly and are completely unaffected by this.
//
// #80 — per-session log capture instead of a global monkey-patch. Directly
// reassigning console.log/warn/error per call (the original shape of this
// adapter) corrupts concurrent sessions, not just serializes them: a second
// call's "original" is actually the first call's already-wrapped functions
// (so session A's output leaks into session B's captured events too), and
// whichever session's `finally` runs first restores the *real* original
// console methods out from under the other session, which is still mid-run.
// Node's AsyncLocalStorage instead keeps a per-session `onEvent` scoped to
// the exact async call chain it was started in (correctly propagated across
// every `await` inside that chain, including into functions the wizard
// calls into) — console.log/warn/error are wrapped exactly ONCE, at module
// load, and every wrapper always calls the real original *and*, only if a
// store is active for the currently-executing async chain, forwards to it.
const wizardLogStore = new AsyncLocalStorage();
let wizardConsolePatched = false;

function ensureWizardConsolePatched() {
  if (wizardConsolePatched) return;
  wizardConsolePatched = true;
  for (const kind of ['log', 'warn', 'error']) {
    const original = console[kind].bind(console);
    console[kind] = (...parts) => {
      original(...parts);
      const onEvent = wizardLogStore.getStore();
      if (onEvent) onEvent({ kind, type: 'log', text: parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ') });
    };
  }
}

/**
 * Run the interactive `construct import --route` wizard as an event stream instead of a terminal session, so the Cockpit can drive it over a WebSocket: every prompt arrives as a `{type: 'question', text}` event and every console line the wizard prints as a `{type: 'log', kind, text}` event.
 *
 * @param {(event: object) => void} onEvent Receives questions and log lines.
 * @param {string} [seedRoute] Route to start from, when the caller already knows it.
 * @param {object} [providers] Injectable dependencies (LLM provider and friends) for tests.
 * @returns {{answer:(text:string) => boolean, cancel:() => void, done:Promise<any>, review:() => Promise<void>}} `review` runs the read-only plan-vs-written review (#603); `answer` feeds the reply to the pending question (`false` when none is pending); `cancel` aborts an in-flight model call and stops the run (#599); `done` settles when the wizard finishes.
 */
export function runImportRouteWizardEventDriven(onEvent, seedRoute, providers) {
  ensureWizardConsolePatched();
  let pendingResolve = null;

  function ask(promptText, hint) {
    onEvent({ type: 'question', text: promptText, ...(hint?.expects ? { expects: hint.expects } : {}) });
    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  }

  /** Feed the user's answer to whichever `ask()` call is currently pending.
   * Returns false (a no-op) if the wizard isn't currently waiting on one —
   * e.g. an answer arriving after the session already finished. */
  function answer(text) {
    if (!pendingResolve) return false;
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(text);
    return true;
  }

  // #599 -- framework steps and the model's own output are two different event types on purpose:
  // `{type:'step', phase, detail}` vs `{type:'thought', text}`, so a UI can render them distinctly.
  const controller = new AbortController();
  let reviewable = null; // what the wizard has written so far, once something has been (#603)
  let reviewController = null;
  /** Cancel the run: aborts an in-flight model call and declines any pending question. */
  function cancel() {
    controller.abort();
    reviewController?.abort();
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve('');
    }
  }

  const done = wizardLogStore
    .run(onEvent, () => importRouteWizard(ask, seedRoute, {
      ...providers,
      signal: controller.signal,
      onStep: (s) => onEvent({ type: 'step', ...s }),
      onThought: (text) => onEvent({ type: 'thought', text }),
      onWritten: (written) => {
        reviewable = written;
        onEvent({ type: 'reviewable' });
      },
    }))
    .catch((e) => {
      onEvent({ type: 'log', kind: 'error', text: `Error: ${e.message}` });
    })
    .finally(() => {
      onEvent({ type: 'done' });
    });

  /** #603 -- a read-only model review of what has been written against the approved plan; available as soon as one file exists, including while a later question is still pending. Findings arrive as one `{type:'review'}` event. */
  async function review() {
    if (!reviewable) {
      onEvent({ type: 'log', kind: 'error', text: 'Nothing to review yet -- a review is available once the wizard has written at least one file.' });
      return;
    }
    if (reviewController) return;
    reviewController = new AbortController();
    onEvent({ type: 'review', phase: 'running' });
    try {
      const provider = providers?.planAnalysis && providers.planAnalysis !== 'ollama' ? providers.planAnalysis : 'claude';
      const { findings } = await reviewImport(reviewable.root, reviewable.plan, reviewable.results, { llm: provider, llmOptions: { signal: reviewController.signal } });
      onEvent({ type: 'review', phase: 'done', findings });
    } catch (e) {
      onEvent({ type: 'review', phase: 'failed' });
      onEvent({ type: 'log', kind: 'error', text: e.cancelled ? 'Review cancelled.' : `Review failed: ${e.message}` });
    } finally {
      reviewController = null;
    }
  }

  return { answer, cancel, done, review };
}
