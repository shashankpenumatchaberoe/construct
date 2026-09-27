# The block contract and the audit of today's flows (#543, part of #542)

Every block a user or a bot can invoke has one shape, `packages/core/block-contract.mjs`:

```
{ id, writes, declaredScope(args, ctx), actions(state, ctx), run(scope, args, ctx) }
```

- `declaredScope` returns `{ features, files }`, which is exactly a plan step's `touches`, so it drops into a step
  unchanged (`validateScope` reuses `validatePlan`'s own `touches` rules). Read-only blocks (`writes: false`) declare
  the empty scope. `null` means "a writing block whose files cannot be derived from its arguments"; the plan step
  must declare them and the approval gate refuses anything outside them. Nothing is guessed.
- `actions(state)` is DERIVED by `deriveActions(rules, state)` from a rule table and the state. Each action is
  `{ id, kind, label, enabled, why?, requires?, blockId?, gates? }`. An action that a rule forbids here is offered
  disabled with the rule's `why`, or not offered.
- `run(scope, args, ctx)` returns `{ changedFiles }`; `runBlock` checks the shape, sorts and de-duplicates, and refuses a
  read-only block that reports a changed file.
- `kind` is `mechanical` (a deterministic block runs), `ai` (a model fills something in, output lands as a reviewable
  diff) or `free` (an explicit, labelled exit to open-ended work).

`packages/core/block-flows.mjs` derives a block from every `PLAN_FLOWS` entry (`flowBlock`, `flowBlocks`) and from the
process state machine (`processLifecycleBlock`). `PLAN_FLOWS`, `validatePlan` and `planToCommand` are unchanged: the
registry stays the single definition of a flow, the block is a view of it.

## Decision: how `free` actions are gated

A `free` action is never a way around a guardrail. It passes through exactly the four guardrails that `ai` actions
pass through, named `GUARDRAILS` in the contract: **containment** (paths stay inside the project root), **approval**
(per-diff approval, `approvalGate`), **session gate** (only reachable through the Cockpit server's session check) and
**checks** (deterministic validation of the staged result before it lands: `lintBuffer` for a buffer, `validate` on the
staged tree in a shadow root, and the transition invariant "actual changed files are a subset of `declaredScope`,
otherwise flagged at approval").

How that is enforced, not just written down:

1. `validateAction` rejects any `ai` or `free` action that does not list every guardrail in `gates`, and
   `deriveActions` stamps them, so a block cannot offer an ungated exit (tested per guardrail).
2. A free action's editable surface is bounded by the block's `declaredScope`. `edit-code` on a writing flow whose scope
   is unknown (`null`) is offered disabled: "its files are not known until the plan step declares what it touches".
3. A free action produces a proposal (a buffer, a diff, a note), never a direct write to the project tree.

What is not built yet (later slices of #542): the transition invariant and `lintBuffer` themselves. The contract fixes
the requirement and the vocabulary they will plug into; today `approvalGate` already enforces scope, approval and
containment for bot output.

## Audit: `PLAN_FLOWS` (`packages/core/plan.mjs`)

Scope column, from `flowScopeKind`: **empty** = read-only, fits as-is; **derived** = `plan-touches.mjs` computes the
files from the arguments (fits as-is); **declared** = a writing flow whose files only the plan step's `touches` can
name (needs a scope declaration, and is the list to derive next: each becomes `derived` when its output is pinned by a
test). Actions: `run` (mechanical) where the flow allows the `deterministic` executor, `fill-with-ai` (ai) where it has
a `local-model` path, `view-code` (mechanical) and `edit-code` (free) on writing flows with a CLI command, `do-by-hand`
(free) where the `user` executor is allowed.

| Flow | Scope | Actions offered | Note |
| --- | --- | --- | --- |
| `project.init` | declared | run, view-code, edit-code, do-by-hand | files are architecture.yml, rules, an entry point; framework-dependent |
| `create.feature` | derived | run, view-code, edit-code, do-by-hand | |
| `create.layer` | derived | run, fill-with-ai, view-code, edit-code, do-by-hand | |
| `create.unit` | derived | run, fill-with-ai, view-code, edit-code, do-by-hand | |
| `create.proof` | derived | run, view-code, edit-code, do-by-hand | the locked proof of a shaped screen (#623) plus `architecture.yml` (`modify`, the test regions, once); a Playwright proof is derived only when the project has a Playwright config |
| `create.route` | derived | run, view-code, edit-code, do-by-hand | points the route entry at a generated screen's controller (#654): Next.js `create app/<route>/page.tsx` (and `delete` the init scaffold's dangling `app/page.tsx`), react-spa `modify src/App.tsx` |
| `add.dependency` | derived | run, view-code, edit-code, do-by-hand | one line in `package.json` (`modify`); never runs a package manager (#654) |
| `add.env` | derived | run, view-code, edit-code, do-by-hand | one variable in `.env.example` (`create`, or `modify` when the file exists), a comment and a placeholder, never a real value; scope `server` \| `public` decides the public prefix (#632) |
| `create.page.from` | declared | run, view-code, edit-code, do-by-hand | one page file plus its Props; derivable next |
| `create.workflow.from` | declared | run, view-code, edit-code, do-by-hand | machine file (+ state union with `--state-union`) |
| `create.controller.bind` | declared | run, view-code, edit-code, do-by-hand | modifies an existing page; kind `modify` |
| `create.service.openapi` | declared | run, view-code, edit-code, do-by-hand | service file plus the shared transport client |
| `refactor.move` | declared | run, view-code, edit-code, do-by-hand | touches every importer, so the set depends on the import graph (`impact`) |
| `refactor.rename` | declared | run, view-code, edit-code, do-by-hand | same |
| `wrap.provider` | derived | run, view-code, edit-code, do-by-hand | wraps a component or page with one provider of the project (`defineProvider`, `features/*/hooks/*Provider*`): `modify` the controller that renders it; refused, with the reason, when no controller does (#631) |
| `guard.route` | derived | run, view-code, edit-code, do-by-hand | chooses who may open a screen (`public` writes nothing, `signed-in`, `role`): a typed guard slice (domain decision, session hook, fallback notice, expression, guard controller), the route entry edited to render `<XGuardController><XController /></XGuardController>`, the feature's `types.ts` and barrel (`modify`) and the locked proof; refused, with the reason, when no route renders the controller (#629) |
| `create.store` | derived | run, view-code, edit-code, do-by-hand | shared client state (`value`, `list` with a selection, `keyed`): the reducer (`domain/<Name>Store.domain.ts`) and the hook (`hooks/use<Name>State.state.ts`, `useTrackedState`) `create`, the feature's `types.ts` (the entity, a status union, typed actions) and barrel `modify`, and the locked proof (#630) |
| `create.handler` | derived | run, view-code, edit-code, do-by-hand | a Next.js route handler: `app/api/<x>/route.ts`, its domain unit (`to<Name>Http`: ready 200, invalid 400, not-allowed 405, error 500) and, without `--service`, an in-memory service (`create`), the feature's `types.ts` and barrel (`modify`) and the locked proof; a react-spa project derives nothing and is refused with the reason (#625) |
| `import.unit` | declared | run, fill-with-ai, view-code, edit-code, do-by-hand | |
| `import.plan` | declared | run, fill-with-ai, view-code, edit-code, do-by-hand | union of its units' files |
| `import.route` | declared | view-code, edit-code, do-by-hand | interactive wizard, user only: no `run` |
| `summarize.unit` | empty | run | |
| `summarize.list` | empty | run | |
| `summarize.usage` | empty | run | |
| `research.summarize` | empty | run | |
| `research.workflow` | empty | run | |
| `research.doctor` | empty | run | |
| `validate` | empty | run | |
| `review.analyze` | empty | run | reads two commits through temporary checkouts |
| `test.run` | empty | run | writes nothing in the project |
| `test.proof` | empty | run | runs the render proof of a shaped screen offline; writes nothing in the project |
| `check.types` | empty | run | type-checks the project with its own TypeScript and returns a classified result (a pass, or errors grouped by file with their kind); writes nothing (#632) |
| `check.build` | empty | run | runs the project's build script through a bounded process and returns a classified result; writes nothing from Construct's side (#632) |
| `sync` | declared | run, view-code, edit-code | derived rule config and each feature's barrel; the set is computable from architecture.yml; a shaped plan (#654) declares its feature's `index.ts` and `.dependency-cruiser.cjs` |
| `pipeline.run` | declared | run, view-code, edit-code | steps carry no scope today (see below) |
| `manual.task` | declared | do-by-hand | no CLI behind it; the only flow that is free by definition |

`test/block-flows.test.mjs` reads this table: every flow id must appear, and its Scope cell must equal
`flowScopeKind`, so the table cannot drift from the registry.

## Audit: everything else the issue named

| Surface | Fits as-is? | How it is modelled |
| --- | --- | --- |
| `allowedEvents` (`packages/engine/processMachine.mjs:233`) | Yes | `processLifecycleBlock`: read-only, empty scope; its actions are the person-facing events (`START`, `PAUSE`, `RESUME`, `RETRY`, `CANCEL`) that `allowedEvents(state)` accepts, all mechanical. The engine's own events (`STEP_COMPLETED`, `YIELDED`, ...) are not offered to a person. |
| Block palette (`packages/engine/palette.mjs`) | Yes, as data | `buildPalette` is already a rule-derived read model (from the real `canImport` graph). It is the menu source for a page block: each entry is a candidate `mechanical` action whose `blockId` is the wrap/insert block; entries that do not fit are the disabled-with-`why` case (`wrapFit`'s `not-a-fit` reason). Nothing new to compute; wiring it to `deriveActions` is #407's job. |
| Pages editor Wrap with / Auto-extract (`buildWrapSuggestions`, `extractExpression.mjs`, `construct refactor extract-expression`) | Needs a scope declaration and a flow | Mechanical, single-file edits: scope is the page file plus the new `expressions/` (and companion component) file. `extract-expression` is not in `PLAN_FLOWS` today, so it has no block; adding it as a `declared` flow (range and name args) is the follow-up. |
| Pipeline steps (`packages/engine/pipeline.mjs`, envelope `steps: [{layer, name}]`) | Needs a scope declaration | `pipeline.run` is one `declared` block; its steps declare no scope. Each step's file is `layerTargetFile(root, layer, name, feature)`, so the scope is derivable from the envelope (`feature` + `steps`) exactly as `expectedFiles` does for `create.layer`; run is already all-or-nothing in a shadow root. |
| CLI commands with no flow | Needs a flow | `refactor extract-expression`, `research impact`, `research spec` (`--generate` writes), `template` are CLI commands with no `PLAN_FLOWS` entry, so no block. `research impact` and `research spec` (without `--generate`) would be `empty`. |
| Research mode (free text to a plan) | Free-form | The text is input, not a write: empty project scope. Its output is a plan, checked by `validatePlan` (every step must name a real flow) and then run block by block. The free-text field is a `free` action on the plan block and is gated by the same four guardrails; any file it eventually causes is written by a flow block under that block's own scope. |
| Notes (`ui/server/src/notesApi.mjs`) | Free-form | Text a person owns, stored in the Cockpit's notes store outside the project tree: empty project scope, `writes: false` for the contract. Gated by the session gate, the project-open gate and server-side path derivation (containment: the client never names a path). It becomes project change only through Run, which hands a plan to the flow blocks. |
| Code drill-down ("View/edit code") | Free-form | The `view-code` (mechanical) and `edit-code` (free) actions every writing block offers. Edit is bounded by the opening block's `declaredScope`, produces a diff and passes all four guardrails (decision above). This is the escape hatch, not a primary surface. |

## Findings

- Of 36 flows, 23 fit as-is (12 read-only with an empty scope, 11 with a derived scope); 13 are writers that need a scope
  declaration from the plan step (`manual.task` among them, by definition).
- `test.run` and `review.analyze` are read-only in `PLAN_FLOWS` and get an empty scope; the contract makes that checkable
  (`RUN_READONLY_WROTE`) where before it was a comment.
- `create.workflow.from`, `create.page.from`, `create.service.openapi` and `sync` are the cheapest next derivations
  (their generators name their own output paths).

## Choosers and the decision seam (#617, part of epic #616)

(The step before a chooser, English to a noun-verb card whose unknown words are closed questions of the same shape, is
`packages/core/requirement-card.mjs`: see `docs/REQUIREMENT-CARD.md`, #640.)

(After the card and before the plan, each verb is placed by three fixed questions and assigned to the project's layers, and
the blocks compile to an ordinary plan: `packages/core/placement.mjs`, see `docs/PLACEMENT.md`, #641.)

A chooser is a block that asks ONE closed question with 2-5 options. Each option is a fixed `PLAN_FLOWS` flow plus fixed
`args` (nobody types them), so a chain of answers compiles to an ordinary plan and approval, containment and
`validatePlan` apply unchanged. `packages/core/chooser.mjs` and `packages/core/decision-provider.mjs`; nothing calls a model.

- `defineChooser({ id, question, options: [{ id, label, flow, args, why?, requires?, touches? }], exit? })` validates by
  named code (`CHOOSER_ERROR_CODES`): dotted id, 2-5 options, unique option ids, every flow in `PLAN_FLOWS`, every option's
  `args` accepted by `validatePlan` in a one-step plan (the same `argProblem` the flow blocks use), a writing flow whose
  files cannot be derived (a `declared` flow) carries `touches`. The `exit` is `{ flow: 'manual.task', args }` (default:
  do it by hand) or an `ai` action carrying every `GUARDRAILS` gate (`Fill with AI`, a reviewable diff).
- `chooserSummary(chooser, state)` is the on-demand summary, `{ id, question, options: [{ id, label, enabled, why }], chosen }`,
  at a fixed size (at most 5 options, question 160 / label 60 / why 120 characters, absolute paths redacted). A person's
  screen, an LLM's tool result and a decision model's input are all this object. `state` is
  `{ chosen?, facts?, disabled? }`: an option is disabled by a reason in `disabled`, or when its `requires` are not in `facts`.
- `compileChain(choosers, answers, ctx)` turns `{ [chooserId]: optionId }` into `{ ok, plan, decisions, errors }`. Each
  answer is a step (`deterministic` where the flow allows it), depending on the previous one, with `touches` from the option
  or from `flowBlock(flow).declaredScope(args, { root })`; the plan is returned only when `validatePlan` reports no errors.
  An unknown, missing or disabled answer, or files that cannot be derived, come back as typed errors, never a throw.
  Answer `'exit'` takes the manual exit (a `manual.task` step); an `ai` exit is not compiled into a step.
- Attribution: `ctx.by` (`person`, `llm`, `decision-model`, default `person`) and `ctx.provider`, or per answer
  `{ option, by, provider }`, are recorded per step in `decisions`. They come back BESIDE the plan, not inside it, because
  `validatePlan` rejects unknown top-level fields and is not changed for this.

The decision seam: a provider is `{ name, version, suggest(summary) }` and returns `{ option, reason, score?, runnerUp? }` or
`null`. `suggest(summary, { provider })` calls it with a deep-frozen copy of the summary (four fixed fields, paths hidden, a
secret refused; no project file) and validates the answer: the option must be an enabled option of that summary and there
must be a reason, else the result is `null` (a throw or a hang, 3 s by default, is `null` too). A provider can only suggest;
nothing it returns is executed. Built in: `rules` (frozen, deterministic: the first enabled option, reason `first available
step`, the next as runner-up) and `off` (always `null`). A plugin such as the decision model of #633 is selected per project
(`decision: { provider, plugin }` in `architecture.yml`, loaded lazily from inside the project, falling back to `rules` when it
fails or is slow) or registered by name with `registerDecisionProvider(name, provider)`. `construct decide` exposes the seam as
a read-only tool. The contract, the setting, the trust model and the tool are in `docs/DECISION-PROVIDERS.md`.

Worked example, run by `test/chooser.test.mjs` so it cannot go stale:

<!-- chooser-example:code -->
```js
import { defineChooser, compileChain } from '@line/construct-core/chooser';

const feature = defineChooser({
  id: 'app.feature',
  question: 'Which feature do you start with?',
  options: [
    { id: 'cart', label: 'Cart', flow: 'create.feature', args: { name: 'cart' }, why: 'The empty cart slice.' },
    { id: 'wishlist', label: 'Wishlist', flow: 'create.feature', args: { name: 'wishlist' } },
  ],
});
const unit = defineChooser({
  id: 'app.unit',
  question: 'What is its first unit?',
  options: [
    { id: 'rules', label: 'Cart rules', flow: 'create.unit', args: { layer: 'domain', name: 'cartRules', feature: 'cart' }, why: 'Pure business rules first.' },
    { id: 'page', label: 'Cart page', flow: 'create.unit', args: { layer: 'page', name: 'CartPage', feature: 'cart' } },
  ],
});

export const result = compileChain([feature, unit], { 'app.feature': 'cart', 'app.unit': 'rules' }, { root: process.cwd(), title: 'Start the cart' });
```

`result` (the files are derived from the arguments and the project's `architecture.yml`, not typed in):

<!-- chooser-example:result -->
```json
{
  "ok": true,
  "plan": {
    "version": 1,
    "ticket": {
      "source": "text",
      "title": "Start the cart"
    },
    "steps": [
      {
        "id": "s1",
        "title": "Cart",
        "flow": "create.feature",
        "args": {
          "name": "cart"
        },
        "executor": "deterministic",
        "touches": {
          "features": [
            "cart"
          ],
          "files": [
            {
              "path": "features/cart/types.ts",
              "change": "create"
            },
            {
              "path": "features/cart/index.ts",
              "change": "create"
            }
          ]
        },
        "rationale": "The empty cart slice."
      },
      {
        "id": "s2",
        "title": "Cart rules",
        "flow": "create.unit",
        "args": {
          "layer": "domain",
          "name": "cartRules",
          "feature": "cart"
        },
        "executor": "deterministic",
        "touches": {
          "features": [
            "cart"
          ],
          "files": [
            {
              "path": "features/cart/types.ts",
              "change": "create"
            },
            {
              "path": "features/cart/index.ts",
              "change": "create"
            },
            {
              "path": "features/cart/domain/CartRules.tsx",
              "change": "create",
              "layer": "domain"
            }
          ]
        },
        "rationale": "Pure business rules first.",
        "dependsOn": [
          "s1"
        ]
      }
    ]
  },
  "decisions": [
    {
      "step": "s1",
      "chooser": "app.feature",
      "option": "cart",
      "by": "person"
    },
    {
      "step": "s2",
      "chooser": "app.unit",
      "option": "rules",
      "by": "person"
    }
  ],
  "errors": []
}
```


## AI-ready by design (owner rule, 2026-09-24)

The decision model (a rules baseline today, a small trained model later, see #633, #643, #645, #647) is part of the design of every block from the first line, not something added afterwards. A new block, chooser or chain step is not done until it is AI-ready:

1. **A fixed-size summary** of its state and options that a person, an LLM and a decision model all receive (`chooserSummary`, `cardSummary`, `blockSummary` are the examples). No paths or secrets in it.
2. **Closed options with stable ids.** Decisions are a choice among 2-5 named options, never free text; ids do not change between versions, so recorded choices stay valid.
3. **Attribution and a trace.** Every choice records who made it (person, LLM, decision model, plugin) and is written as a `decision-trace.v1` record with its outcome (#643, `packages/core/decision-trace*.mjs`, see `docs/DECISION-TRACES.md`): `choicesFromChain`, `choiceFromCardQuestion` or `choicesFromPlacement` turn what the block returned into a choice, `recordChoices` writes it to the project's state directory (`traces: off` in `architecture.yml` stops it), and a new chooser is done only when its choices can be recorded and `construct traces replay` can score a provider on them.
4. **A rules-only fallback.** The block works with no model, and any model-backed proposal goes through the decision-provider seam, suggests only and never executes. The provider is pluggable per project and follows one contract, `{ name, version, suggest(summary) -> { option, reason, score?, runnerUp? } | null }`: it receives ONLY the frozen, path-free summary, returns a suggestion or `null`, and a plugin error or a slow answer falls back to the `rules` provider and is logged (`docs/DECISION-PROVIDERS.md`, #633). A new chain step shows the suggestion beside its options ("suggested by <provider>", with the reason), leaves the choice to the person, and records the answer with the suggestion and `accepted: true|false`.
5. **Replay-scorable.** A provider can be scored on recorded traces of this block (`construct traces replay --provider <name>`: agreement with what people chose, coverage, and beats/ties/loses against the `rules` baseline); the block never depends on a specific model.
6. **Cheap on a small machine.** No model file is loaded unless the feature is enabled; the block reports what it needs (see the low-end tiers, #648).

## The blocks as MCP tools (#649)

`packages/mcp` (`@line/construct-mcp`, private, stdio, `construct-mcp --root <project>`) exposes the blocks above to an LLM client as eight
read-only, plan-only tools: `requirement_parse`, `placement_place`, `plan_validate`, `decide`, `summarize`, `validate`,
`machine_capabilities`, `traces_stats` (`summarize` also takes `backend: true`, #634: the bounded backend summary, `docs/BACKEND-SUMMARY.md`). It is an adapter, not a block: each tool is a thin wrapper over an existing one and adds no logic, so
the AI-ready rules above hold by construction (fixed-size summaries, closed options with stable ids, the rules-only fallback of
`decide`). What the adapter adds is the boundary: one project root fixed at startup and never a tool argument, a link that leaves the root
refuses the call, every result path-free, secret-free and at most 32 KiB, a token-bucket rate limit (30 calls a minute), and nothing that
writes: a plan preview names the files each step would touch and says to apply it through the Cockpit's per-diff approval. Attribution:
answers passed to `placement_place` are returned as `by: 'llm'` with the MCP client's name as `provider`; no tool records a decision trace
in this slice, so a recording tool must add `recordChoices` with that attribution when it lands. Setup, the tool table and the safety model:
`packages/mcp/README.md`.
