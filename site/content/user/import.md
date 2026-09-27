`import` brings existing code into a Construct project: it scaffolds the layers you ask for and leaves a `TODO(import)` note in each pointing at the old source file. Porting the logic is a separate step, by you or, optionally, a model.

## One file

```bash
construct import PriceCheck --feature pricing --layers domain,hook --from ./old/PriceCheck.tsx
```

## A whole page, guided

```bash
construct import --route /v2/home
```

The route wizard traces the real import graph from that route's page, proposes a plan for the whole feature, and asks **"Approve this plan and build it now?"** before writing anything. By default it makes exactly one analysis call, to a hosted model, to produce the plan. Afterwards it runs `validate` and tells you what is left to fill in. The same wizard is available as the Import Wizard in the [Cockpit UI](@user-guide/cockpit/).

### Plan without a model: `--planner mechanical`

```bash
construct import --route /v2/home --planner mechanical
```

Reads each traced file's syntax tree — JSX, its own state/effects, fetch/storage I/O, reducer/machine shape, plain exported functions — and computes the same `{ feature, units }` plan no LLM call, instantly, offline, repeatably. Every layer the plan proposes prints a one-line reason (`hook: keeps its own state/effects in the component (useState)`), and files it leaves out (types-only, a barrel) are listed with why. The plan still goes through the same approval step and the same deterministic repair (`normalizePlanLayers`) as the AI-produced plan — only how the plan is computed changes. AI stays the default until it's been compared against the mechanical plan on more real routes; pick "Plan with: Mechanical" in the Cockpit wizard for the same choice.

## From an approved plan

```bash
construct import --plan ./plan.json
```

A plan is `{ feature, units: [{ name, layers, from }, ...] }`; the command runs the same scaffold once per unit.

## Add `--llm` to have a model write the ported logic

Adding `--llm <provider>` (`claude` or `ollama`) makes one call per generated file. See [Using an AI model, optionally](@user-guide/how-to/use-an-llm/).

{{include README.md#Adopting Construct inside an existing project level=2}}
