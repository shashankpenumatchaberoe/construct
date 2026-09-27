# tsc error-count ratchet (#606)

`npm run build` (`tsc --noEmit`, per the root `tsconfig.json`'s `checkJs`) reports a large number
of pre-existing type errors, none of which affect runtime — the server, wizard and the full test
suite are all unaffected. Fixing them by file risked colliding with in-flight PRs editing those
exact files (`packages/core/cli.mjs`, `packages/core/architecture-enforcer.mjs`,
`packages/ast/jsx*.mjs`, `packages/engine/testSteps.mjs`/`testClone.mjs`,
`workflowNarrator.mjs`, `workflowScenarios.mjs`, `packages/core/decision-model-bundle.mjs`,
`packages/engine/workflowGenerator.mjs`, `packages/core/plan-touches.mjs`, and more), and
narrowing `checkJs`'s scope in `tsconfig.json` would silently stop checking files that are
already clean. Instead — same shape as the API-doc-coverage ratchet
(`packages/tools/api-coverage/`, documented in `docs/API-DOCS.md`) — this is a ratchet: the
baseline only ever decreases, so a file with zero errors today stays gated at zero, and any new
error anywhere is caught immediately, without the untouched debt blocking anyone.

## Files

| File | What |
| --- | --- |
| `check.mjs` | Runs the real `tsc --noEmit -p tsconfig.json` (the same invocation `npm run build` uses), parses its diagnostics into per-file counts, and compares them against `baseline.json`. |
| `baseline.json` | Per-file error counts as of the last `--update`. `note` field repeats this pointer. |

Enforced by `test/tsc-error-ratchet.test.mjs` (part of the ordinary `npm test` run).

## Commands

```
node packages/tools/tsc-ratchet/check.mjs            # check against the baseline (exit 1 on regression)
node packages/tools/tsc-ratchet/check.mjs --report   # list every current tsc error, per file
node packages/tools/tsc-ratchet/check.mjs --update   # lower the baseline to the current counts (refuses to raise it)
```

## Baseline (measured 2026-09-27)

597 errors across 80 files. `packages/core/decision-model-bundle.mjs` (59),
`packages/engine/testSteps.mjs` (48), `packages/engine/workflowGenerator.mjs` (44),
`packages/core/plan-touches.mjs` (40) and `packages/engine/testClone.mjs` (34) are the largest.
The full per-file breakdown is `baseline.json`.

Note this is higher than the number issue #606 first measured (241): the tree has moved a lot
since then (16 open PRs at the time this ratchet was added). Whatever `check.mjs --report` prints
right now is the number that matters — trust the tool, not a number written down earlier,
including this one.

## Lowering it

1. Pick one file from `baseline.json` and actually fix its tsc errors (or move it out of
   `tsconfig.json`'s `include` if it turns out not to belong there — a real scope decision, not
   silent exclusion of otherwise-checked code).
2. Re-run `node packages/tools/tsc-ratchet/check.mjs --report` to confirm it's clean.
3. Run `node packages/tools/tsc-ratchet/check.mjs --update` to write the new (lower) baseline —
   it refuses to write a baseline that raises any file's count, so this is a one-way ratchet in
   code as well as in intent.
4. Commit `baseline.json` alongside the fix.

Never edit `baseline.json` by hand to raise a count; never touch `tsconfig.json`'s `checkJs`
scope to make errors disappear without fixing them — either defeats the point of the ratchet.
