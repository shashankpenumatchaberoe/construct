# Construct's execution model: code vs. LLM vs. human

This is the real, current inventory of every `construct` command/capability
and how it actually executes today: deterministic code, an LLM call (and
which one), or a human approval gate — re-derived directly from the code as
of the AI Toolkit work landing. Re-verify this against `packages/core/cli.mjs`'s command dispatch
whenever a new capability is added; a stale version of this table is worse
than none.

## The governing principle

Construct is a library of small, deterministic,
non-LLM building blocks. The **only** place an LLM is ever involved is where
a human explicitly opts in with `--llm <provider>` (CLI) or a Settings
capability (UI) — and even then, in one of exactly two shapes:

1. **Execution-class calls** — small, scoped, mechanical: "write this one
   file's real implementation." One call per file, never one call for a
   whole batch. These may route to a local model (Ollama/Qwen Coder) as
   well as a hosted one (Claude).
2. **Plan-analysis-class calls** — whole-feature, high-context reasoning:
   "look at this entire existing feature and propose how to decompose it."
   Exactly one call, always. **Never** allowed to route to a local model —
   enforced in code (`ui/server/src/settings.mjs`'s `updateSettings`
   throws if `planAnalysis` is set to `ollama`), not just left as a UI
   convention.

Locating files, deciding which layers/files to scaffold, and deciding a
feature's shape are **never** delegated to an LLM in either case — that
stays deterministic code, or a human/Claude-in-conversation decision made
*before* any of this runs.

## Providers (`packages/core/llm.mjs`)

| Provider | How it's called | Notes |
|---|---|---|
| `claude` | Shells out to the `claude` CLI (`spawnSync`, headless `-p --output-format text`) | Requires the CLI installed/authenticated locally. Sync under the hood, but `callLlm` always awaits it. |
| `ollama` | `POST {baseUrl}/api/generate` via `fetch`, `stream: false` | No CLI shell-out. Target model + base URL are configurable per call (`{ model, baseUrl }`, defaults `qwen2.5-coder:7b` / `http://localhost:11434`) — never hardcoded. Requires a local `ollama serve` with the model pulled. |

Both share one shape: `callLlm(provider, prompt, options?) -> Promise<string>`,
throwing a `ConstructError` on failure. Adding a new provider means adding
one entry to `PROVIDERS` in `packages/core/llm.mjs` — nothing else in the framework
needs to change to support it.

## Per-command inventory

| Command | Execution | LLM call? | Human gate? |
|---|---|---|---|
| `construct init` | Deterministic (scaffolds `architecture.yml`, `AGENTS.md`, a starter `core` feature) | No | No |
| `construct feature create` | Deterministic | No | No |
| `construct create feature <name>` | Deterministic | No | No |
| `construct create <layer> <name> --feature f [--llm <provider>]` | Deterministic scaffold, always | **Optional, execution-class.** One call, only for that one file, only if `--llm` given | No (review the diff afterward, same as `import`) |
| `construct create layer <name> --feature f --layers ... [--llm <provider>]` | Deterministic scaffold, always | **Optional, execution-class.** One call *per generated file* (not one for the batch), only if `--llm` given | No |
| `construct generate ...` | Same as the `create` forms above — `create` just delegates to `generate` | Same as above | No |
| `construct sync` | Deterministic (regenerates `.dependency-cruiser.cjs` + each feature's `index.ts`) | No | No |
| `construct validate` | Deterministic (architecture/SoC/readability enforcers + public-API drift check) | No | No |
| `construct summarize` | Deterministic, read-only | No | No |
| `construct doctor` | Deterministic, read-only (environment check) | No | No |
| `construct refactor move / rename` | Deterministic, mechanical (relocate + rewrite every importer's path; never touches a file's own content) | No | No |
| `construct research summarize / doctor` | Deterministic, read-only | No | No |
| `construct import <name> ... --from <path> [--llm <provider>]` | Deterministic scaffold + `TODO(import)` breadcrumb, always | **Optional, execution-class.** One call *per generated file*, only if `--llm` given. Never reads the old source file at all unless `--llm` is given. | No |
| `construct import --plan <path> [--llm <provider>]` | Deterministic, batched: runs the same per-unit scaffold (+ optional fill) once per unit in the plan | Same as above, applied uniformly across every unit | No — the plan itself was already human-approved *before* being handed to this command (see `import --route` below, which is how a plan is normally produced) |
| `construct import --route <path> [--planner mechanical]` (standalone wizard) | Deterministic scaffold once a plan is approved. `--planner mechanical` (#605, `packages/core/mechanical-plan.mjs`) also makes the *plan itself* deterministic: it reads each traced file's syntax tree (JSX, own state/effects, fetch/storage I/O, reducer/machine shape, pure exports) and returns the same `{feature, units}` shape a model call would, with a reason per layer and skipped files (types-only, barrels) listed with why — no LLM call at all for that route. | **Default (`--planner ai`, or omitted): always exactly one plan-analysis call** (whole-feature, provider = Settings' `planAnalysis` (default `claude`; `ollama` is rejected) — see "How Settings is consumed" below) up front. **With `--planner mechanical`: zero.** **Optionally** one execution-class fill call per generated file afterward either way, if the user opts in mid-wizard. | **Yes — hard gate, either planner.** Shows the proposed plan (repaired by the same `normalizePlanLayers`) and explicitly asks "Approve this plan and build it now? [y/N]" before writing anything. |
| `construct repl` | Interactive shell wrapping every command above | No calls of its own — whatever the dispatched command does | Whatever the dispatched command does |

## The UI layer (`ui/`)

`ui/server`'s Dashboard/Wizard/Pages-Editor features wrap the exact same
core CLI functions in-process (`packages/core/cli.mjs`'s `create`/`refactor`/
`research`/`importCommand`, called directly — never a shell-out to the
`construct` binary) and add **zero LLM calls of their own**: every LLM call
that happens because of a UI action is one of the calls listed in the table
above, just triggered through a form instead of a terminal.

`ui/server/src/settings.mjs` is the one place the UI adds
real logic on top of this: a per-capability provider map,
```
llmProviders: { importFill: 'claude' | 'ollama', createFill: 'claude' | 'ollama', planAnalysis: 'claude' }
```
validated against the real `PROVIDERS` map in `packages/core/llm.mjs` (never a
UI-side copy), with `planAnalysis` hard-rejecting `ollama` in
`updateSettings` itself. Settings only *configures which provider a future
call would use* — it never makes a call by itself.

## How Settings is consumed — and why LLM use is still opt-in per run

Settings selects a **provider only** (not a model — the `ollama` provider
keeps its default model, `qwen2.5-coder:7b`, unless a caller passes
`llmOptions`). Settings defaults every capability to the first provider
(`claude`), so a setting alone must never cause a call. The rule is: **a
run only calls an LLM if that run explicitly asked, and then the provider is
whatever Settings says for that capability.**

| Where | Opt-in (per run) | Provider read from Settings |
|---|---|---|
| Dashboard **Create** form (layer / vertical slice) → `POST /api/create` | "Have the LLM write the implementation" checkbox (`useLlm: true`, default off; hidden for "a new feature") | `createFill` |
| Dashboard **Import** form → `POST /api/import` | "Have the LLM write the ported logic" checkbox (`useLlm: true`); the old free-text Provider field is gone. A direct API caller may still send an explicit `llm: '<provider>'`, which wins. | `importFill` |
| **Import Wizard** (`/ws/wizard` → `importRouteWizard`) | Plan analysis is inherent to the wizard unless "Plan with: Mechanical" is picked (`planner: 'mechanical'`), which skips the analysis call entirely; the per-file fill is opt-in mid-wizard either way ("should the LLM also write the ported logic?") | `planAnalysis` for the analysis call (ignored when `planner: 'mechanical'`), `importFill` for the fill |

`importRouteWizard(ask, seedRoute, { planAnalysis = 'claude', importFill = 'claude', planner = 'ai' })`
takes the two providers plus `planner` as options (the plain CLI keeps the
`claude`/`ai` defaults, overridden by `--planner mechanical`);
`planAnalysis: 'ollama'` is rejected inside the wizard as well as
in `updateSettings`, before any call or write — that check is skipped only
when `planner: 'mechanical'` has already ruled out any plan-analysis call.

## LLM output is validated before it is written

Every per-file fill (`import`, `create`, `generate`) goes through
`packages/core/llm-fill.mjs`: the prompt states the reply is captured from stdout and
that the model has no file access; a reply that wraps exactly one fenced
block in prose is unwrapped; the result must parse as TypeScript/JavaScript
(`parseToAst`) and contain a declaration, import or export. A rejected
reply gets **one** corrected retry; a provider call that throws is not
retried. Whatever happens, an unfilled file keeps its scaffolded stub (plus
the `TODO(import)` breadcrumb on the import path), the command reports it
per file, other files continue, and the exit code is 3.

## Cockpit execution mode: audit of the seven verbs (#541, story #560)

The Cockpit runs a core activity in-process (`engine`, default) or as the real `construct` binary (`cli`), per
project (`project.execution.mode`, see README "Cockpit execution mode"). This table is the audit that decides,
verb by verb, what `cli` mode can honestly promise. "Contract" means `construct <verb> ... --format json` prints one
stable document that a test compares byte for byte with the in-process result. Status is kept current as each verb lands.

| Verb | `--format json` contract today | In-process path in `ui/server` | Where the two would diverge | Status |
|---|---|---|---|---|
| `validate` | yes (`validate --format json`) | `GET /api/validate` (`validateApi.mjs`) | none found; exit 1 is a result, not a crash | done (first slice) |
| `summarize` | yes for the default project/feature summary (`summarize --format json [--feature f]`, one compact line) | `POST /api/research {action: summarize}` through `runCapturing(research(...))`; `research` appends the `[tool: ...] [llm: 0 calls]` line | the `md`, `compact`, `prose` views and `since` are text or concatenated text, no JSON contract, so they stay in-process in both modes; the attribution line only exists under `research`, so `cli` mode runs `summarize` and attaches the same constant | done |
| `research` | `doctor` had none (added: `doctor --format json`); `workflow`, `impact`, `spec` already have one | `POST /api/research {action: doctor}`; workflow, impact and spec have no Cockpit endpoint, they run only as Processes, and the bot runner already spawns the CLI | `doctor` text is rendered from the same document in both modes (`renderDoctorText`) | doctor done; the rest are subprocess already |
| `review` | yes (`review <base> <head> --format json`, default) | Review mode's analysis: a Process step (`review.analyze`) running a forked worker (`reviewWorker.mjs`) | the worker adds `units` (what each changed file now does, from `summarizeUnit`) which the CLI does not print; the plan travels as `expected {features, files}`, the CLI takes `--plan <file>`; the worker's root is the git top level, the CLI's `--dir` walks UP to the nearest `architecture.yml`, so `cli` mode refuses a root that would climb out of itself | done: prHealth vs `construct review` byte-identical (5 scopes and a refusal); the Review analysis runs the CLI in `cli` mode |
| `create` | none: text with per-file timings (`(0.01s)`, `Total:`), so never byte-stable | `POST /api/create` (feature, layer, single) through `runCapturing(create(...))` | needs a deterministic result document (files created), and `--llm` fills cannot be in a contract (a provider call) | done: `create ... --format json` added (deterministic forms only); document and project trees byte-identical |
| `refactor` | none: text; the core result (`moveLayerFile`, `renameLayerFile`) is structured already | `POST /api/refactor` (move, rename) through `runCapturing(refactor(...))` | needs a result document (from, to, files, importers updated, follow-up validation) | done: `refactor move\|rename ... --format json` added; document and project trees byte-identical |
| `import` | none: text with timings and per-file fill reports | `POST /api/import` (unit, plan) through `runCapturing(importCommand(...))`; the Import Wizard (`/ws/wizard`) is interactive with an LLM plan analysis | needs a result document; `--llm` fills and the wizard's analysis are AI work that stays in-process | done: `import ... --format json` added (no `--llm`); document and project trees byte-identical |

Never switchable, by rule (`ui/server/src/coreExecutor.mjs` header): scope links, Palette grouping, the live-preview
bridge, pane and resize state, the dev-server manager, and the read models `/api/units`, `/api/flow`, `/api/features`,
`/api/components` (they call `summarizeUnit` in-process on every hover or tab change). Processes (bots) already spawn
the CLI in a worktree and are not part of this switch.

Known gaps, deliberately left (each is a follow-up, not a silent difference):

- `refactor extract-expression` and the `create` forms with `--from`, `--bind`, `--openapi` or `--llm` have no JSON
  document; `--format json` refuses them by name.
- The text lines a `cli`-mode `create` or `import` shows have no per-file timings (the timings are what made the text
  unfit for a byte-identical contract); the response's own `durationSeconds` still says how long it took.
- In `cli` mode the Review analysis still computes "what each changed file now does" in the existing in-process
  worker; that enrichment is not part of `construct review`'s report.
