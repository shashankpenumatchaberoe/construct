# Reusable capabilities ("lego blocks")

A maintained inventory of the small, deterministic building blocks already in the codebase, so new work reuses
them instead of re-implementing them (or asking an LLM to). Update this file when
you add, move or retire a block.

Legend: **Det** = deterministic, no LLM. **Rec** = recommendation (*packaged* = already a clean, single-entry
module; *group next* = worth extracting, filed as an issue; *leave* = fine where it is).

| # | Capability | Where it lives | Consumers | Det/LLM | Rec |
|---|---|---|---|---|---|
| 1 | **AST package**: parse, walk, extract, generate (`parseJsxTree` node records carry `start`/`end`, `line`/`column`, `endLine`/`endColumn` and `length` (#701), plus `content`: immediate text/`{expression}` children, in source order, whitespace-only text skipped (#697)) | `packages/ast/` (entry `packages/ast/index.mjs`; README there) | `packages/core/parser.mjs`, `architecture-enforcer`, `route-resolver`, `frozen-detector`, `prose`, `engine/{pageTransformer,controllerBinder,workflowGenerator,workflowExtractor}`, `ui/server/src/pagesEditor.mjs` | Det | **Packaged** (JSX edit/analysis family) |
| 2 | **Glob matching** (`**` / `*` to RegExp) | `packages/core/glob.mjs` (`globToRegExp`, `matchGlob`) | architecture/readability/SoC enforcers (layer patterns, exceptions), pagesEditor | Det | **Packaged** (replaced 5 inline copies) |
| 3 | **Timing** (`startTimer`, `elapsedSeconds`, `formatDuration`) | `packages/core/timing.mjs` | `cli.mjs`, `import.mjs`, `ui/server/src/commandRunner.mjs` | Det | Packaged already (3 pure functions, no deps) |
| 4 | **LLM provider registry** (`PROVIDERS`, `callLlm`, `stripCodeFence`, Ollama defaults) | `packages/core/llm.mjs` | `import.mjs`, `generators.mjs`, `ui/server/src/{settings,ollama}.mjs` | **LLM** (the one deliberate exception; opt-in via `--llm`) | Packaged already; keep isolated so everything else stays LLM-free |
| 5 | **Transactional writer + context envelope + pipeline** (buffer writes, validate a shadow copy, commit atomically) | `packages/engine/{transactionalWriter,envelope,pipeline}.mjs` | `generators.mjs`, `cli.mjs`, the generators in `packages/engine/` | Det | Packaged already (`createTransaction`, `createEnvelope/validateEnvelope`, `runPipeline`) |
| 6 | **Zero-LLM generators** (workflow from a state descriptor, controller binding, page transformer) | `packages/engine/{workflowGenerator,controllerBinder,pageTransformer}.mjs` | `cli.mjs`, `generators.mjs` | Det | Packaged (now sit on `packages/ast`) |
| 7 | **Layer classification + layer graph** (`classifyFile`, `classifyProjectFile`, `loadLayerGraph`, `canImport`, `mergeLayers`, `validateGraph`) | `packages/core/architecture-graph.mjs` (one classifier; `architecture-enforcer.mjs` re-exports `classifyFile`; `parser.classifyLayer` is a thin default-graph shim) | enforcers, `parser.parseFile`/`summarizeFeature`, readability, `pagesEditor` (graph only) | Det | **Packaged**: single graph-driven classifier honoring custom layer patterns and `frozen:` regions |
| 8 | **Exceptions (scoped, time-boxed)** | `packages/core/exceptions.mjs` (`validateExceptionsShape`, `exceptionApplies`, `expiredExceptionViolations`) | the three enforcers (architecture re-exports the names for back-compat) | Det | **Packaged** (replaced 3 near-identical `isExempt` copies) |
| 9 | **Config loading + rule registry** (`loadConfig`, `DEFAULT_RULES`, `normalizeRules`, `layersForFramework`, `aggregateValidation`) | `packages/core/config.mjs`, `packages/core/registry.mjs`, `packages/engine/defaultEnforcers.mjs` | CLI, all enforcers, ui/server | Det | Packaged already |
| 10 | **Violation diagnostics** (`makeViolation`, `formatReport`, `ConstructError`, `EXIT_CODES`) | `packages/core/diagnostics.mjs` | everything | Det | Packaged already |
| 11 | **Prose descriptions of code** (TS AST to English) | `packages/core/prose.mjs` | `summarize` | Det | Packaged already (uses `packages/ast/tsNodes`) |
| 12 | **Source edit / write-back primitives** (JSX tree, props, snippet patch, auto-map, scope/prop analysis; hash-guarded `patchNode` + enforcement check stay in ui/server) | `packages/ast/jsx*.mjs` (typescript-estree; pure edits) + `ui/server/src/pagesEditor.mjs` (glue) | ui/server routes, Pages Editor UI | Det | **Packaged**: Babel removed from `ui/server`; parity proven by golden tests captured from the Babel implementation |
| 13 | **File walk / relative path / write** | `packages/core/fs.mjs` (`walk`, `rel`, `write`, `ensureDir`) | most modules | Det | Leave (tiny) |
| 14 | **Line source for interactive prompts** | `packages/core/line-source.mjs` | `repl.mjs`, `cli.mjs` | Det | Leave |
| 15 | **Import planning / route resolution** | `packages/core/import.mjs`, `packages/core/route-resolver.mjs` | CLI `import` | Det (LLM only on opt-in fill) | Leave; `route-resolver` already uses `packages/ast` |
| 16 | **Workflow narrator** (state machine to plain English, Given/When/Then scenarios, health findings; feeds WORKFLOW-002/003/004) | `packages/engine/{workflowNarrator,workflowScenarios,workflowExplain,workflowSource}.mjs`; docs in `docs/workflow-narrator.md` | CLI `research workflow`, `ui/server/src/workflowsViewer.mjs` (`GET /api/workflows/narrative`), architecture-enforcer (WORKFLOW-002/003/004) | Det | Packaged (built on `workflowExtractor`, no LLM, nothing stored) |
| 17 | **Unit summaries** (structured, LLM-free summary of any project/feature/layer/file/hook/route/rule/package/etc. for bots and humans; pluggable per-kind registry, JSON Schema, token budgets) | `packages/engine/unitSummary.mjs` + `packages/engine/units/` (facts, machines, registry, kinds); `schemas/unit-summary.v1.json`; docs in `docs/unit-summary.md` | CLI `summarize <ref>` / `--list` / `--usage`, `ui/server/src/unitsApi.mjs` (`GET /api/units`, `/api/units/summary`, `/api/features*`) | Det | Packaged (composes AST, layer graph, enforcers, workflow narrator; MCP-ready pure API, no MCP server yet) |
| 18 | **Live preview + click-to-source** (annotate JSX with `file:line:col` in memory, in-page click bridge, opt-in Vite plugin, plus `annotateJsxFile`: a standalone entry point that reads and annotates one file from disk with no bundler/dev-server integration required) (#701) | `packages/engine/{jsxSourceAnnotator,previewBridge,previewVitePlugin}.mjs` | Cockpit Pages Editor "Live app preview"; `annotateJsxFile` is also usable directly by any consumer that wants the same annotations outside a Vite project | Det | Packaged (dev-server path never modifies source or production builds; `annotateJsxFile` is a pure file read + `annotateJsxSource`, both entry points share the one core) |
| 18b | **Live preview v2: click-to-source from React internals** (bridge script generator for an app that installs nothing, + a pure fiber-payload -> `{file, line, column, componentName, ancestors[]}` resolver: four-tier ladder `data-cx-src` / `_debugSource` / `_debugStack` + source map / component-only, stack parsing, base64-VLQ source-map lookup, project containment) | `packages/engine/previewFiber.mjs`; design in `docs/design/live-preview-v2.md`; fixtures + recorder in `test-utils/preview-fixtures/` | none yet — the injecting proxy, the dev-server process and the Pages editor wiring are later slices of the same epic | Det | **Packaged** (no dependencies; the bridge half is serialisable and the resolver half is pure, so both are unit-testable against payloads recorded from real dev builds) |
| 19 | **Scope/binding links** (which page values flow into which props of one element; unbound, undeclared and unused flags) | `packages/engine/scopeLinks.mjs` | `ui/server/src/pagesEditor.mjs` (Scope tab) | Det | Packaged (pure; cross-file resolution stays with the caller) |
| 20 | **Workflow editing** (state/transition/context/action/guard edits as exact source-range replacements; context reader) | `packages/engine/{workflowEditor,workflowContext}.mjs` | `ui/server/src/workflowsViewer.mjs` (Edit and Context & actions tabs) | Det | Packaged (formatting and comments outside the edit stay byte-identical) |
| 21 | **External-change tracking + text diff** (per-file "changed outside the editor" records; before/after rows with collapsed context) | `packages/core/file-change-tracker.mjs`, `packages/core/text-diff.mjs` (uses `diff`) | `ui/server/src/pageChanges.mjs` (Diff tab) | Det | Packaged (I/O-free; renderer-agnostic view model) |
| 22 | **Allowlisted directory browser** (directories only, realpath-checked against allowed roots) | `packages/core/dir-browser.mjs` | `ui/server/src/dirBrowse.mjs` (folder picker in Settings, the project switcher and the "Open a project" screen; its only root is the workspace) | Det | Packaged (security-sensitive: keep it the only path a UI server uses to list folders) |
| 22b | **Workspace boundary** (one realpath-contained root: `..`, symlinks out, dangling symlinks, sibling prefixes, NUL/over-long paths refused; the open project re-verified per request; consistent `409 NO_PROJECT`) | `ui/server/src/workspace.mjs`, `ui/server/src/projectGuard.mjs`; setting `CONSTRUCT_WORKSPACE_ROOT` | Every project route of the Cockpit server, the wizard socket, `/api/import` reads | Det | Leave in `ui/server` for now (pure fs/path, no HTTP; a candidate to package next to `dir-browser` if another server needs it) |
| 23 | **Project validation as data** and **bounded output buffer** (same enforcers as `construct validate`, returned as rows; last ~500 log lines) | `ui/server/src/validateApi.mjs` (`GET /api/validate`), `ui/server/src/logBuffer.mjs` | Cockpit drawer (Diagnostics, Logs) | Det | Leave in `ui/server` (thin glue over `packages/core/registry.mjs`) |
| 24 | **Execution plan contract** (ordered steps, each a reference to a real flow, with executor tag, expected touches and dependencies; flow registry covering the whole CLI surface; `validatePlan`, `planToCommand`, `planTouches`) | `packages/core/plan.mjs`; `schemas/plan.v1.json` | Research mode (plan pane), the process runtime | Det | Packaged (pure JSON-in/JSON-out; contains, rather than replaces, `packages/core/import.mjs`'s narrower import plan) |

| 25 | **Impact analysis** (blast radius of a change: features/layers/files touched, why each is implicated, shared-component warnings, per-entry `derived`/`inferred` provenance) | `packages/engine/impact.mjs`; `schemas/impact-report.v1.json`; docs in `docs/impact-analysis.md` | CLI `research impact`, Research mode (#229), PR health (#285, via `impactFromChangedFiles`) | Det | **Packaged** (assembles the layer graph, `units/facts.mjs`, the unit registry and the enforcers over a reverse import index; read-only, MCP-ready pure API) |

| 26 | **Process runtime** (a running plan: the lifecycle as a real XState machine that narrates itself, per-step status keyed to plan step ids, an `ok`/`llm`/`warn` log where every step records whether a model was involved, artifacts collected for approval, pause/resume/cancel/retry, and persistence outside the project so a run survives a restart) | `packages/engine/{processMachine,processModel,processStore,processEngine}.mjs`; `schemas/process.v1.json` | The Cockpit's Processes section (#292), the bot runner (#291) | Det | **Packaged** (pure JSON-in/JSON-out, no UI imports; one transaction per step via `transactionalWriter`, so a cancelled or failed step writes nothing; `executeStep` is the seam a runner fills) |
| 27 | **Deterministic commit messages** (branch-scoped serial `<prefix>-<session>-<serial>`, impact counts consumed from row 25, prose from the unit summarizer, session branch naming, dirty-tree honesty) | `packages/engine/commitMessage.mjs`; docs in `docs/commit-on-save.md` | Cockpit commit-on-save (#283, via `ui/server/src/autoCommit.mjs`) | Det | **Packaged** (pure, read-only, never shells out and never calls a model — a structural test asserts its import graph cannot reach `packages/core/llm.mjs`) |
| 28 | **PR health** (five deterministic review indicators between two refs: declared-vs-actual scope, unexplained changes, rule regressions, public surface, flow diff; findings split mechanical vs conversation) | `packages/engine/prHealth.mjs`, `packages/engine/gitTrees.mjs`; `schemas/pr-health.v1.json`; docs in `docs/pr-health.md` | CLI `construct review`, PR review UI (#285) | Det | **Packaged** (reuses `impactFromChangedFiles`, `planTouches`, the workflow narrator; read-only via temporary detached worktrees) |
| 29 | **Machine spec** (`machine-spec.v1`: an English requirement as sentences with ids, broken down into states, events, guarded transitions and typed functions, every item linked to its sentence by `req`; the deterministic gate that refuses a spec before anything is generated from it: structure, duplicate ids, one initial, unknown states/events, ambiguous transitions, unreachable states, untyped functions, uncovered or contradicted sentences, exits from final states -- codes `SPEC-001`..`SPEC-012`, each with a path and a reason) | `packages/core/research/machine-spec.mjs`; `packages/core/research/machine-spec.v1.schema.json`; worked example in `packages/core/research/examples/`; docs in `docs/machine-spec.md` | CLI `research spec` (#576 R1); `--generate` (R2 spec-to-code); `--read-back` (R4, the spec in plain English per sentence, the narrator's wording, `packages/core/research/readBack.mjs`); `--coverage` (R5, sentence -> functions -> generated files and back, `packages/core/research/coverage.mjs`); R3 `--llm` draft-and-retry and R6 Cockpit table build on it | Det | **Packaged** (pure JSON in, `validate --format json`-shaped result out; no runtime schema engine, ajv asserts schema/validator lockstep in tests) |

## Public npm surface: packages/core and packages/engine (#698)

`packages/engine` had no `package.json` at all (#698), so nothing in it could be imported by
package name from outside this monorepo (a sibling tool, e.g. Trace/line-matcher, had to reach in
via relative paths across a workspace boundary). It now ships `@line/construct-engine` with its own
`exports` map, alongside five gaps closed in `@line/construct-core`'s map. The rule for what gets a
subpath, applied per module rather than as a blanket export-everything:

- **A row above marked `Packaged`/`Packaged already`, with a real consumer already exercising it** ->
  exported. That combination is exactly what this table already tracks: a clean single-entry module
  whose contract is proven by an actual caller, not just written to look reusable.
- **No row here** -> stays internal. If nothing has classified a module as a packaged block yet, a
  package-name export is a promise this file hasn't backed up; add the row (and tests) first.
- **A row here but no consumer yet** -> stays internal even though the code is clean. Exporting an
  unwired block locks in a contract nothing has exercised; promote it once something depends on it.
- Security-sensitive but parameterized (allowlist passed in by the caller, not read from ambient
  config) is exported like anything else `Packaged` — the safety property is in the code, not in
  hiding the entry point.

**`packages/core` additions** (all five named in the issue's evidence; all already real, standalone,
`Packaged`/`Packaged already` modules per rows 4, 10, 21 and 22 above — only the export was missing):
`./llm` (row 4, the one deliberate LLM exception, opt-in only), `./diagnostics` (row 10,
`makeViolation`/`formatReport`/`ConstructError`/`EXIT_CODES`), `./text-diff` and
`./file-change-tracker` (row 21, pure/I/O-free pair), `./dir-browser` (row 22 — security-sensitive,
but the allowlist is a caller-supplied argument, not ambient state, so it exports like any other
packaged block).

**`packages/engine` exports** (new package `@line/construct-engine`; subpaths are kebab-case
regardless of the source file's own casing, matching `packages/core`'s existing subpath style):
`./impact` (row 25 — engine is impact analysis's real home; `@line/construct-core/impact` keeps
re-exporting it unchanged for back-compat), `./transactional-writer` + `./envelope` + `./pipeline`
(row 5), `./workflow-generator` + `./controller-binder` + `./page-transformer` (row 6),
`./default-enforcers` (row 9), `./workflow-narrator` + `./workflow-scenarios` + `./workflow-explain`
+ `./workflow-source` (row 16), `./unit-summary` (row 17 — the single public entry point; its
`units/` composition internals ship in `files` for the import to resolve but are not their own
subpaths), `./scope-links` (row 19), `./jsx-source-annotator` + `./preview-bridge` +
`./preview-vite-plugin` (row 18), `./process-machine` + `./process-model` + `./process-store` +
`./process-engine` (row 26), `./commit-message` (row 27), `./pr-health` + `./git-trees` (row 28).

**`packages/engine` modules deliberately left internal**: `previewFiber.mjs` (row 18b — "Packaged"
but explicitly no consumer yet: the injecting proxy and dev-server process that would call it are
later slices of the same epic; exporting it now would publish a contract nothing has exercised).
Engine's own `diagnostics.mjs` (per-file TS + rule diagnostics for editor markers) has no row in
this table — it is CLI/`ui/server` source-view glue, not yet classified as a packaged block. Every
other engine module without a row above (`approvalGate`, `botRunner`, the `describe*`/`test*`
generators, `palette`, `planTemplate`, `proofRunner`, `propLinks`, `referenceLinks`, `safeFetch`,
`tsFileMove`, `verifyRunner`, `gitVersion`, `units/*`) stays internal for the same reason: add the
row (and prove the contract with a consumer) before adding the export.

## How to use this file

- Before writing a helper, check the table. If a block exists, import it; if it is nearly right, extend it
  rather than forking it.
- Adding a deterministic block? Give it a single entry point, JSDoc, tests, and a row here.
- Anything that calls an LLM must go through row 4 so the rest of the tool stays repeatable.

## Follow-ups

Babel unification for `pagesEditor`, layer-classifier and exception-handling
consolidation are done.
