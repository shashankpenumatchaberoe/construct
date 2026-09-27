# Design module (Module 9)

Charter: one place that decides how the Cockpit looks and behaves, so screens
built by different people (or agents) feel like one product, and so every
screen is drawn and reviewed before it is built. Owned by the `designer` agent
(`.claude/agents/designer.md`).

Scope: the Cockpit UI (`ui/`). It is proprietary-future (open-core boundary):
design docs live here, and no open-core package may depend on them.
Non-goals: MCP surfaces (future), marketing pages, product code.

## Contents

| File | What it is |
|---|---|
| [principles.md](principles.md) | The bar every screen is held to (calm, dense, keyboard-first, WCAG AA, dark+light, plain language, progressive disclosure) plus a review checklist |
| [tokens.md](tokens.md) | Audit of today's CSS variables and the proposed consolidated token set |
| [popovers.md](popovers.md) | The one dismissable popover/menu primitive: disclosure vs menu, dismissal contract, placement, states (#297) |
| [ia-five-screens.md](ia-five-screens.md) | Information architecture: five primary screens (Features, Pages, Components, Git, Tests) x four slots, profile menu, capability map, durable Notes, migration slicing. Supersedes the modes (concept) |
| [cockpit-layout.md](cockpit-layout.md) | The 3-pane Cockpit shell, per-screen rationale, and the ordered implementation plan |
| [live-preview-v2.md](live-preview-v2.md) | Click-to-source by reading React fiber internals: bridge delivery (injecting loopback proxy), fiber-to-source ladder, dev server as a process, hosted-mode threat model (#443) |
| [block-palette.md](block-palette.md) | Pages editor block palette (Providers/Expressions/Components, grounded in the real `canImport` graph and typed-contracts factories) and the "Wrap with…" interaction; MVP scope cut and accessibility review (#518, part of #500 phase 3) |
| [scope-binding.md](scope-binding.md) | Prop-to-scope binding: making the real, shipped `ScopeLinkGraph`/`ScopePanel` (#223) interactive so a person can pick a specific Provider value, parent prop or other unit's output for a control's `PropRef<T>` prop; click-to-link primary, drag-and-drop additive, full keyboard path, multi-field linking deferred (#523, follows #518) |
| [browser-panel-merge.md](browser-panel-merge.md) | Pages editor Browser pane: merging `PagesBrowser` + `TreePanel`/`ListBrowser` into one grouped panel, each independently collapsible via the same native `<details>/<summary>` idiom as `block-palette.md`'s palette groups; grounded in a real screenshot of the live Cockpit, not guessed from JSX (#536) |
| [git-panel.md](git-panel.md) | Git panel inside the Git screen's Changes/Branches/Commit tabs: stage/unstage (file-level, grouped by feature/layer via the real `ChangeTree`), diff (reuses the Pages editor's `DiffView`), commit (reuses `AutoCommitSettings`/`CommitIndicator`), push/pull with two named gates (sign-in vs. the #638 push-credential gap), branch switch/create; extends `/review`, not a new screen (#331, part of #277) |
| [mocks/](mocks/) | Concept mocks as static HTML+CSS (`*.html`) and rendered PNGs (`png/`) |

Concept mocks (1440x900, each in `png/<name>--dark.png` and `--light.png`):
- **Cockpit shell** (`build.mjs`): `cockpit-shell`, `pages-editor-in-shell`,
  `workflows-in-shell`, `plan-mode`, `processes-drawer`, `command-palette`,
  `states-and-narrow`.
- **PR review** (`build-pr-review.mjs`, styles in `pr-review.css`):
  `pr-review-list`, `pr-review-open`, `pr-review-findings`, `pr-review-autofix`,
  `pr-review-indicators`, `pr-review-no-plan`, `pr-review-states`.
- **QA test authoring** (`build-qa-tests.mjs`, styles in `qa-tests.css`):
  `qa-tests-scenarios`, `qa-tests-clone`, `qa-tests-editor`,
  `qa-tests-changes-code`, `qa-tests-new`, `qa-tests-run-failure`,
  `qa-tests-states`, plus the click-and-record screens `qa-tests-record-start`,
  `qa-tests-record`, `qa-tests-record-check`, `qa-tests-record-selector`,
  `qa-tests-record-review`.

- **Episode 1 Part 1 example** (`build-episode1.mjs`, styles in `episode1.css`; #472/#474):
  `episode1-shop-embedded`, `episode1-shop-fullscreen`, `episode1-shop-wishlist-states` (the frozen,
  MIT-licensed shop page + wishlist heart/panel, styled as someone else's app, wrapped by the
  Cockpit), `episode1-missing-prop-components`, `episode1-missing-prop-pages` (the missing-prop-link
  evidence: a declared prop never passed, shown calmly as a warn chip, not a red wall — detection
  gap filed as #473), `episode1-highlight-callout` (the feature-tour ring + label, legible at the
  1280x720 recording composite).

- **Flow tree and click to navigate** (`build-flow-nav.mjs`, styles in `flow-nav.css`;
  #328 and #321): `flow-nav-browser`, `flow-nav-selection`, `flow-nav-links`,
  `flow-nav-trail`, `flow-nav-states`. `render.mjs` takes an optional name
  prefix: `node docs/design/mocks/render.mjs flow-nav`.

- **Five-screen IA** (`build-ia.mjs`, styles in `ia.css`): `ia-features`, `ia-account-menu`,
  `ia-slot-matrix`, `ia-notes-states`, `ia-no-project`, `ia-git`, `ia-git-connect`, `ia-narrow`, and the POC-parity set `ia-pages`, `ia-pages-next`, `ia-pages-change`, `ia-components`, `ia-generate-states`, `ia-preview-states`, `ia-side-preview`, and the Story set `ia-story`, `ia-story-states`, `ia-story-modes`, `ia-story-indicators`, `ia-story-consent`, `ia-clip-bridge`, `ia-clipper`, and `ia-feature-structure` (a feature as a hierarchy). Spec: `ia-five-screens.md`. Also in `build-ia.mjs`: the block palette set (#518) — `ia-palette` (read-only, MVP slice 1), `ia-palette-suggest` and `ia-palette-confirm` (the interactive "Wrap with…" flow, pairs with #517), `ia-palette-states` (empty/loading/error/no-selection/no-block-yet/narrow). Spec: `block-palette.md`. Also the prop-to-scope binding set (#523) — `ia-scope` (read-only Scope tab), `ia-scope-link` (linking mode, type-fit candidates), `ia-scope-bound` (committed, mechanical rewrite + approval, existing auto-map shown alongside), `ia-scope-states` (empty/loading/error/no-fit/keyboard-focus/drag/deferred-multi-field/narrow). Spec: `scope-binding.md`. Also the Git panel set (#331) — `ia-git-changes` (Changes tab: stage/unstage groups, diff open, Commit tab push-ready), `ia-git-commit-blocked` (Commit tab, push blocked on no GitHub credential, #638), `ia-git-branches` (Branches tab: session branch, switch, create), `ia-git-clean` (Changes tab, clean tree), `ia-git-states` (sign-in gate vs. push-credential gate side by side), `ia-git-narrow` (390px). Spec: `git-panel.md`.

`plan-mode` was `research-mode` until the owner renamed the middle mode in #243:
the modes are **Explore / Plan / Build** and the brand in the top bar is
**Cockpit**. The CLI's `construct research …` is deliberately unchanged — "Plan"
is what the mode button says, "research" is what happens inside it.

The `qa-tests-*` mocks were rendered before that rename and still show the old
chrome; re-running `node docs/design/mocks/build-qa-tests.mjs` picks it up, since
they share `parts.mjs`.

The shell chrome shared by every mock lives in `parts.mjs`; each initiative adds
its own `build-*.mjs` (and its own stylesheet, if it needs one) rather than
growing a single build script.

PR review in the Cockpit (#308, explores #285), built by
`node docs/design/mocks/build-pr-review.mjs` with its own stylesheet
(`pr-review.css`): `pr-review-list`, `pr-review-open`, `pr-review-indicators`,
`pr-review-findings`, `pr-review-no-plan`, `pr-review-autofix`,
`pr-review-states`.

Pages editor Browser pane merge (#536), built by
`node docs/design/mocks/build-browser-merge.mjs` with its own stylesheet
(`browser-merge.css`, deliberately reusing the real `ui/client` class names —
`pe-browser`, `pages-browser`, `tree-panel`, `lb`/`lb-*` — so the mock is a literal
before/after of the shipped screen): `browser-merge-before` (today, two floating
panels), `browser-merge-after` (merged, two independently collapsible `<details>`
sections), `browser-merge-states` (collapse/keyboard-focus/no-feature/empty/error
states), `browser-merge-narrow` (390px). Spec: `browser-panel-merge.md`.

## How design tickets work

1. **Parent ticket per initiative**: `[Design] <initiative>` (Module: Design;
   Kind: Feature or Epic). Body: problem, who it is for, hero mock embedded,
   rationale (what changes versus today and why), open questions, contents table
   of sub-issues, "Part of #N" if under a roadmap epic.
2. **One sub-issue per screen or shippable slice**, linked with GitHub
   sub-issues. Each carries: the mock (filename + embedded PNG), an acceptance
   checklist, the accessibility checks that apply, and the existing e2e specs
   that must stay green.
3. **Mocks live in this repo** (`docs/design/mocks/`), are regenerated with
   `node docs/design/mocks/build.mjs && node docs/design/mocks/render.mjs`
   (Playwright from `ui/e2e`) and are published on the documentation website, not attached to tickets. Mocks are always
   bannered "Concept - not implemented" until the screen ships.
4. **Implementation tickets link back**: their body starts with
   `Design: #N (mock: <filename>)`. Ordinary CLAUDE.md rules apply (comment only
   with something to notify or a dev note, Playwright test for UI, rule-12
   closing comment).
5. **After build**: the designer compares the real screen to the mock and posts
   a short "intent vs result" comment; deliberate deviations update the mock so
   the mock never lies about the design.
6. **Freshness**: when a screen ships, its mock banner is removed or the mock is
   replaced by a real screenshot; superseded mocks are marked, not deleted.

## Board

Module: **Design** (new option; the field itself is set by the
project-manager/OG). Sub-modules proposed: Design system, Cockpit shell,
Screens, Accessibility & review, Other.

## Design-review overlay (dev-only, #454)

`ui/client` carries [`threadmark-react`](https://www.npmjs.com/package/threadmark-react)
(MIT) as a devDependency: an in-page annotation overlay so the owner and the
`designer` agent can mark up a real, running Cockpit screen (click an element,
highlight text, drag a region, or mark up a screenshot area) instead of writing
prose feedback. Its GitHub repo (`gtimeyin/threadmark`) 404s as of 2026-09-21 —
private, renamed, or moved — so it could not be source-reviewed; only the
published npm package and its README/type declarations were used.

**It is dev-only and cannot reach the hosted build.** The overlay is mounted
once, in `app/layout.tsx` (`ReviewOverlayController`, feature
`features/design-review`), and does nothing unless `NEXT_PUBLIC_REVIEW_OVERLAY=1`
is set **at build time** (Next.js inlines `NEXT_PUBLIC_*` vars when the app is
built, not when it is started, so setting the flag at `next start` time has no
effect). When the flag is not `1`:

- `features/design-review/services/ReviewOverlayLoader.ts` (the only file that
  imports `threadmark-react`) is swapped for a no-op stub via a `webpack.
  resolve.alias` in `next.config.ts` — the real package's source, and its own
  dependencies (`lucide-react`, `modern-screenshot`), are never read, resolved
  or emitted into any build output, client or server.
- This was verified against a real `next build`: with the flag unset, grepping
  `.next/` for `threadmark-react` finds nothing except
  `.next/cache/.tsbuildinfo` (TypeScript's local incremental-build cache,
  which is never served or included in `next start`); with the flag set at
  build time, the real package's code appears in the compiled chunks as
  expected.

**Turning it on locally**: `NEXT_PUBLIC_REVIEW_OVERLAY=1 npm run dev` (from
`ui/client`), or add the same line to `ui/client/.env.local`. Then, on any
Cockpit screen, press <kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> to enter
Review mode.

**How feedback comes out**: annotations and screenshot evidence stay in that
browser tab's memory only — nothing here persists or transmits them anywhere.
Press <kbd>C</kbd> in the overlay's toolbar to copy the current annotations as
structured Markdown, then paste that into a comment, ticket or chat by hand.
Feedback screenshots stay local and are never attached to an issue or posted
anywhere (standing rule 11) — the overlay's own screenshot capture is for the
reviewer's own eyes while marking up a crop, not for publishing.

**Exceptions / known limits**: beta package (`0.1.0-beta.1`); annotations are
not persisted across a reload (in-memory only, by design — see its README);
telemetry or an issue-sync integration from the overlay is explicitly a
separate, not-yet-made decision (it would send Cockpit screens somewhere) —
out of scope here.
