# Git panel: changes, stage, diff, commit, push/pull, branches (#331)

Status: concept (nothing here is implemented). Part of #331, which is part of the hosted-Cockpit
epic #277. Mocks: `mocks/ia-git-changes.html`, `mocks/ia-git-commit-blocked.html`,
`mocks/ia-git-branches.html`, `mocks/ia-git-clean.html`, `mocks/ia-git-states.html`,
`mocks/ia-git-narrow.html` (built by `build-ia.mjs`, styles reused from `ia.css`); PNGs in
`mocks/png/ia-git-{changes,commit-blocked,branches,clean,states,narrow}--{dark,light}.png`. These
extend the already-approved `ia-git.html` / `ia-git-connect.html` (Git screen shell, #374) rather
than replacing them.

## 0. This is not a green field — read the real code first

Before drawing anything, the real screens and blocks this extends were found and read, not assumed:

- **The Git screen shell already has a spec and an open implementation ticket**: `ia-five-screens.md`
  (section 7) and #374 `[Design IA 7/9]` (part of epic #367) already lay out the Git screen's four
  left tabs (Changes / Branches / PRs / Commits) and four right tabs (Findings / Detail / Plan match /
  Commit), and already decided the Commit tab hosts today's auto-commit settings. **#374 is about the
  shell/placement; this document is about what actually goes inside the Changes, Branches and Commit
  tabs** — the stage/unstage list, the diff, the commit box, push/pull and branch switch/create that
  #331 asks for and #374 only gestures at ("git settings: auto-commit on save, dirty-tree choice").
  An implementer should build #374's shell first (or alongside), then fill it per this spec.
- **`PRIMARY_SCREENS`** (`ui/client/features/shell/domain/PrimaryScreens.ts`) already routes the Git
  top-bar item to `/review`. **Decision: reuse `/review`, do not add a new route.** The existing
  `ui/client/features/review/*` feature (`ReviewListPage`, `ReviewChangePage`, `ChangeTree`,
  `BranchList`, `ReviewSources`, `ReviewController`) is exactly the "PRs"/"Branches" comparison view
  ia-git.html already shows; the Changes/Commit content this spec adds is a sibling tab inside the
  same screen, not a competing route. `useGitBranchCount` (badge on the Git nav item) already counts
  "branches to review" — it should be extended to also reflect uncommitted changes (see §6).
- **The changed-file tree, grouped by feature then layer, already exists and is reusable as-is**:
  `ChangeTree.tsx` + `types.ts`'s `ChangedFile = { path, status: 'A'|'M'|'D'|'T', feature, layer,
  scope }`, with a `By feature / By layer / Files` toggle (`ChangeTree.tsx:3-7`) — this is the "same
  impact-counting the commit messages already use" #331 asks for; nothing new to build for grouping,
  only a `staged: boolean` + checkbox to add to each row (§2).
- **The server already has the exact deterministic building block for staging**:
  `ui/server/src/git.mjs` `status(root)` returns `{path, kind: 'add'|'update'|'delete', staged,
  untracked}` for every changed file (git.mjs:90-109); `stage(root, paths)` stages an explicit path
  list, never `git add -A` (git.mjs:120-128, `PATH_ESCAPE` refused outside the project root); `commit`,
  `hasStagedChanges`, `createBranch`, `currentBranch`, `branchExists` also already exist. **Missing and
  needed**: `unstage(root, paths)` (`git reset -- <paths>`, same path-escape guard as `stage`), a
  `diff(root, path, {staged})` that returns `DiffRow[]`-shaped hunks (not raw text — see §3), and
  `push`/`pull`/`remoteStatus` (ahead/behind counts, remote URL) — none of these exist in `git.mjs`
  today and are the real server-side gap, not a design gap.
- **The diff viewer is not reinvented** (#331 explicitly forbids this). Two real components already
  exist and this spec reuses one of them:
  - `ui/client/features/pages-editor/components/DiffView.tsx` — a presentational unified diff with
    line numbers, `rows: DiffRow[]`, kinds `added|removed|context|gap` (`DiffView.tsx:1-30`). **This
    is the one the Git panel reuses** for a selected file's diff — it is already generic (its own
    comment says "the renderer is swappable... props only"), already used for "what changed on disk"
    (`DiffTab.tsx`), and needs no git-specific behaviour added to it, only a `DiffRow[]` computed
    server-side from `git diff`.
  - `ui/client/features/pages-editor/components/SnippetDiffPreview.tsx` — a **confirm-before-write**
    diff for one in-progress edit (`hunks: DiffHunk[]`, Confirm/Cancel), used when a save is about to
    happen. **Not reused here**: the Git panel diffs already-written files against git, it does not
    confirm a pending edit — wrong shape for this job. Named so the implementer does not reach for it
    by mistake.
- **Commit-on-save (#283) already has a working indicator and settings form**: `CommitIndicator.tsx`
  (state badge, last-commit subject/impact/branch, "Commit now") and `AutoCommitSettings.tsx` (mode:
  `coalesce`/`every-save`/`manual`, window, message prefix, branch prefix/suffix) both exist today and
  are rendered inline wherever an editor is open (`GitSessionPage.tsx`'s own comment: "rendered inside
  whichever editor is open rather than as a route of its own"). `ia-five-screens.md` already recorded
  the owner's decision to move both onto the Git screen's Commit tab instead. **This spec's Commit tab
  is `AutoCommitSettings` (collapsed to a one-line summary + a link to the full form) plus
  `CommitIndicator`'s data, extended with a manual "stage → message → Commit staged / Amend last" flow
  and the new Push/Pull section** — not a new commit UI built from scratch.
- **Auth model, read from `ui/server/src/auth.mjs`**: `/auth/session` returns `{authRequired,
  authenticated, oauthConfigured, ...}`. On loopback with no OAuth app configured, `authRequired` is
  `false` and every route is open — this is where local commit-on-save already runs today. When
  `authRequired` is `true` (hosted, or `CONSTRUCT_AUTH=required`), routes need a valid session. Two
  facts that shape §5 directly: (a) the OAuth scope requested is `read:user` only, **not `repo`**
  (`auth.mjs:41`, deliberately narrow) — so even a signed-in Cockpit session cannot push today, being
  signed in and being able to push are genuinely different gates; (b) this is exactly what #638 is
  about (a separate GitHub App credential for git network operations), and #638 is blocked on the
  owner registering that App — not something this design can resolve, only design around.

## 1. Decision: extend `/review`, do not add a new screen

`PRIMARY_SCREENS` already sends "Git" to `/review`; `ia-five-screens.md` already renamed the mental
model from "Review mode" to "the Git screen, Review is a verb inside it." Adding a second route (e.g.
`/git`) would either fork the nav model #374 already committed to, or require redirecting one to the
other for no benefit. Concretely:

- The **Changes** tab (this spec) and the **PRs**/**Branches** tabs (today's `ReviewListPage`/
  `BranchList`, and #374's shell) are sibling tabs of the same left panel, reusing the same tab strip.
- The right panel's **Commit** tab (this spec) is a sibling of **Findings** / **Detail** / **Plan
  match** (today's `ReviewChangePage` internals), reusing the same tab strip.
- No new top-level route, no new item in `PRIMARY_SCREENS`, no change to `activeOn`.

## 2. Left panel: Changes tab

Mock: `ia-git-changes.html` (populated), `ia-git-clean.html` (empty). Reuses `ChangeTree.tsx` and its
grouping toggle (`By feature | By layer | Files`) exactly; adds:

- **A session-branch banner** above the tree (new, small): branch name, "Session branch (#283) · save
  N", and the active auto-commit mode in one line (`coalesce`/`every-save`/`manual` — reuses
  `CommitConfig['mode']` and `GitSessionView`'s formatted text, not a new vocabulary). This is the
  concrete "show which auto-commit mode is active" #331 constraints ask for, visible without opening
  the Commit tab.
- **Two disclosure groups**, `<details><summary>` (the same pattern already used throughout
  `docs/design/mocks/ia.css`'s `.dt` class for collapsible sections, e.g. block-palette's group
  headers — reused, not invented): "Staged · ready to commit · N" and "Not staged · N", each with a
  group-level "Stage all" / "Unstage all" button and one row per file (checkbox, layer chip, filename,
  `+N -N`). Clicking a row's checkbox stages/unstages that one file (`git.mjs`'s `stage`/new
  `unstage`, one path at a time — never `-A`); clicking the filename (not the checkbox) opens it in the
  center diff.
- **Grouping still applies inside each group**: "By feature"/"By layer" groups the *staged* set and
  the *not-staged* set independently, so a partially-staged feature shows the right file under both
  headers rather than disappearing from one.
- **Granularity decision**: file-level stage/unstage only for v1, not hunk-level (`git add -p`). This
  matches the real server primitive (`stage(root, paths)` takes whole-file paths) and commit-on-save's
  own model (it stages whole files); hunk staging is real added complexity (UI for partial hunks, a
  different git plumbing call, a way to represent "half of this file is staged" in the tree) that
  nothing in #331 or the existing building blocks asks for. Flagged as an explicit non-goal, not a
  silent gap — if it turns out to matter, it is its own follow-up ticket.
- **Empty state** (`ia-git-clean.html`): "Nothing to commit" card in the center stage, "0" tab badges,
  and (when auto-commit is `manual`) copy that says plainly that nothing will commit on its own even
  after the next save — see #9 in principles.md, "recoverable and honest," applied to a state where
  there is genuinely nothing wrong.

## 3. Center stage: file diff

Mock: same file as above (diff is shown inline once a file is selected, not a separate mock — it is
one state of the same screen, per progressive disclosure).

- Selecting a file (staged or not) shows its diff via **`DiffView.tsx`** (`rows: DiffRow[]`, unified,
  line-numbered) — the same component `DiffTab.tsx` already uses for "what changed on disk outside the
  editor." The server computes `DiffRow[]` from `git diff [--cached] -- <path>` (new: this parsing does
  not exist yet; it is a small, deterministic block — no model involved, same posture as everything
  else in `git.mjs`).
- A small `Deterministic` tag on the diff toolbar (reusing `.tag.det` and the "Deterministic" language
  already used everywhere else in the Cockpit) makes explicit that this is git's own diff, not a model
  summary — consistent with principles.md #8, "show provenance."
- A one-line callout under the diff states the file-level staging decision from §2 in the same place
  ("staged as a whole file"), so a person is never surprised that there is no per-line stage control
  here.

## 4. Right panel: Commit tab

Mock: `ia-git-changes.html` (push ready), `ia-git-commit-blocked.html` (no push credential),
`ia-git-clean.html` (nothing staged, last commit only). Sibling of Findings/Detail/Plan match; three
stacked sections:

1. **Auto-commit summary** — one line, reusing `GitSessionView`'s already-formatted `modeHint`/mode
   text ("Commit on save: every save"), with a link to the full `AutoCommitSettings` form (still the
   real settings component, just relocated here per the owner decision already recorded in
   `ia-five-screens.md`, not redesigned).
2. **Commit box** — commit message field pre-filled by the same deterministic summarizer commit-on-save
   already uses (`CommitImpactText.ts`'s `describeImpact`/`describePerFeature`, so the message the
   panel shows can never disagree with the one an auto-commit would have written), editable, "Commit
   staged" (disabled when nothing is staged) and "Amend last" (disabled when the branch has no commit
   yet or `HEAD` is already pushed — amending a pushed commit is out of scope for v1, flagged as an
   open question in §7).
3. **Push / Pull** — see §5.

## 5. Push and Pull: two independent gates, both shown honestly

Mock: `ia-git-states.html`. #331's constraints name one gate ("push needs credentials the Cockpit does
not fully have yet, #638") but reading `auth.mjs` surfaces a second, earlier one that the panel must
not conflate with it:

| Gate | What it is | Blocks | Cockpit state today |
|---|---|---|---|
| **A — signed in** | `authRequired` is true (hosted/non-loopback) and the request carries no valid Cockpit session | Push, Pull (both touch the remote) | Already built (#278); loopback dev has `authRequired: false` and never hits this gate |
| **B — push credential** | Even signed in, the Cockpit's own OAuth scope is `read:user` only (`auth.mjs:41`), and there is no GitHub App token yet | Push only | Not built; blocked on the owner registering a GitHub App (#638) |

Designed states, all shown with the real reason named rather than a generic disabled button
(principles.md #9):

- **Gate A open, Gate B open (future, once #638 ships)** — `ia-git-changes.html`: "Push · 3 ahead of
  origin/main", enabled Push and Pull buttons.
- **Gate A closed (hosted, not signed in)** — `ia-git-states.html`, card 2: Push and Pull disabled,
  "Sign in to push" button to `/auth/login`; staging and committing stay enabled (local-only, no
  session needed — same posture #283 already has).
- **Gate B closed (signed in, or loopback, but no push credential — today's real default)** —
  `ia-git-commit-blocked.html` / `ia-git-states.html` card 3: "Connect GitHub to push", disabled
  (there is nothing to connect to yet), with a note that a terminal `git push` still works if the
  machine already has its own git credentials — **the panel must never claim push is impossible**,
  only that *this panel* cannot do it yet, because `git.mjs` shells out to the user's real local git
  installation and inherits whatever credential helper or SSH agent is already configured. This is the
  literal reading of #331's instruction to "degrade gracefully... rather than assuming #638 is done":
  build Push so it attempts a real `git push` today (works out of the box for a developer on their own
  loopback machine with existing credentials) and only falls back to the "Connect GitHub" messaging
  when the attempt itself fails with an auth-shaped git error, or when the Cockpit is hosted and has no
  credential to try at all.
- **Pull** is gated by A only, not B — reading a remote does not need the same elevated credential
  pushing does for most repos (public, or already-cloned with working fetch access); if a `git pull`
  attempt fails for a real credential reason, surface git's own error rather than inventing a second
  "Connect GitHub" flow for it.

## 6. Branches tab

Mock: `ia-git-branches.html`. Left panel, sibling of Changes/PRs/Commits:

- **Session branch** pinned at the top, visually distinct (`ia-git-branches.html`'s highlighted row):
  name, "Current · save N", auto-commit mode — the same banner data as §2, so the session branch is
  never just another row in an alphabetical list.
- **New branch**: a name field + Create button, using `createBranch(root, name)` (already exists,
  `git.mjs:77-89`, validates the name against `BRANCH_OK` server-side).
  Newly-created branches follow the same session-branch model #283 already established (not a second
  branch concept).
- **Other branches**: `currentBranch`/`branchExists` plus the already-existing "N files ahead" data
  `BranchList.tsx` already computes for the PRs tab — reused, not recomputed twice.
  Each has a **Switch** button. Switching with a dirty tree reuses the **existing `DirtyTreePrompt`**
  component and its stash/commit/discard choice (`git-session/components/DirtyTreePrompt.tsx`,
  #283) rather than inventing a second dialog for the same decision — the center stage explains this
  in place of a diff while no specific change is selected (`ia-git-branches.html`'s state card).
- `useGitBranchCount` (today: "branches to review") should additionally count `1` when the current
  branch has any uncommitted change, so the Git nav badge reflects "there is something to look at here"
  consistently with the Changes tab, not only PRs-to-review. Flagged as a one-line hook change for the
  implementer, not part of this visual spec.

## 7. States and transitions

| State | Where | Trigger | Next |
|---|---|---|---|
| Clean | Changes tab | `status()` returns `[]` | stays until a file changes on disk |
| Partial stage | Changes tab | some `status()` rows have `staged: true`, some `false` | Commit staged / Stage all / Unstage all |
| Diff open | Center stage | a file row clicked | closes on selecting another file or leaving the tab |
| Committing | Commit tab | "Commit staged" pressed | button shows busy state (reuse `busy` prop pattern from `AutoCommitSettings`/`CommitIndicator`); on success, staged list clears, "Last commit" updates |
| Push ready | Commit tab | Gate A and B both open, `ahead > 0` | "Push" pressed → busy → success updates ahead/behind, or a real git error is shown inline |
| Push blocked (A) | Commit tab | `authRequired && !authenticated` | "Sign in to push" → `/auth/login` |
| Push blocked (B) | Commit tab | signed in (or loopback) but no push credential | "Connect GitHub to push" (informational only until #638 ships) |
| Switching branch, clean tree | Branches tab | Switch pressed | checks out immediately |
| Switching branch, dirty tree | Branches tab | Switch pressed | `DirtyTreePrompt` (stash/commit/discard), same as #283's save-time prompt |
| Narrow (390 px) | any | viewport | one panel at a time, `ia-git-narrow.html`; Changes/Branches/Commit collapse into the existing tab bar `#283` and `ia-narrow.html` already established |

Conflict state (a `git pull`/branch switch that cannot fast-forward) is explicitly **not designed
here** — `git.mjs` has no merge/rebase surface at all today, and #331 does not ask for a merge editor.
Left as an open question in §8 rather than guessed at.

## 8. Open questions / explicit non-goals

- **Hunk-level staging** — deferred (see §2); file-level only for v1.
- **Amending a pushed commit** — deferred; "Amend last" is disabled once the branch's `HEAD` has
  already been pushed (needs the same ahead/behind data §5's Push section computes).
- **Merge conflicts** — no design surface exists yet for a failed pull/switch; needs its own ticket
  once `git.mjs` grows a merge-aware primitive to design against (designing UI for an error shape that
  does not exist yet would be guessing).
- **One git mechanism for the whole Cockpit** — `git.mjs`'s own top comment says it is deliberately
  the narrow, boring `execFileSync` wrapper until #296 (open-from-GitHub) picks a real library; this
  spec adds `unstage`/`diff`/`push`/`pull`/`remoteStatus` to that same narrow module rather than
  pre-empting that decision, per #331's own constraint ("decide the library question once, with the
  sibling ticket").
- **Token storage for #638** — explicitly out of scope; server-side only, whenever it ships, per #331's
  constraint. This spec's job was to make sure Push degrades honestly without it, not to design it.

## 9. Accessibility (principles.md checklist, applied)

- Stage/unstage checkboxes, Switch/Create/Commit/Push/Pull buttons all reach 24px targets already used
  elsewhere (`.btn.sm` is 24px tall); the `<details>` disclosures are native, keyboard-toggleable
  (Enter/Space), no custom widget.
- The `Deterministic` tag on the diff and the auto-commit mode line are text, not colour-only
  (principles.md #4).
- Push-blocked states never hide the button behind a tooltip-only explanation — both the disabled
  state and the reason are always-visible text, reachable by keyboard, matching principles.md #9.
- Reviewed in dark and light (`ia-git-changes`, `ia-git-commit-blocked`, `ia-git-branches`,
  `ia-git-clean`, `ia-git-states` all rendered both ways) and narrow (`ia-git-narrow.html`, 390px, one
  panel at a time via the existing tab bar).

## Implementation plan (ordered, for a build agent)

1. **Server**: `unstage(root, paths)`, `diff(root, path, {staged}) -> DiffRow[]`, `push`/`pull`/
   `remoteStatus(root)` in `ui/server/src/git.mjs`, each with the same path-escape/argv-array
   discipline the existing functions use. Size: M. No UI yet; unit-testable in isolation.
2. **Changes tab**: session banner, staged/not-staged `<details>` groups over `ChangeTree.tsx` (extend
   `TreeFile`/`ChangeTreeProps` with `staged`, add checkbox + Stage all/Unstage all), diff pane wiring
   `DiffView.tsx` to the new `diff` endpoint. Size: M. Must keep `review-tree-keyboard.spec.js` green
   (tree keyboard model unchanged); new spec: `git-changes-stage.spec.js`.
3. **Commit tab**: relocate `AutoCommitSettings`/`CommitIndicator` per `ia-five-screens.md`'s existing
   decision, add the commit box (message prefilled from `CommitImpactText.ts`, Commit staged/Amend
   last) and the Push/Pull section with both gates from §5. Size: M. Must keep `commit-on-save.spec.js`
   green (settings relocation, not behaviour change); new spec: `git-commit-push.spec.js` covering both
   blocked states and the ready state (can mock the push credential state, does not need a real GitHub
   App).
4. **Branches tab**: session branch banner (shared component with Changes tab), new-branch form,
   switch wired to the existing `DirtyTreePrompt`. Size: S. New spec: `git-branches.spec.js`.
5. **Nav badge**: extend `useGitBranchCount` to also count "current branch has uncommitted changes".
   Size: XS.

Each step keeps `review-mode.spec.js`, `review-findings.spec.js`, `review-processes.spec.js` green
(no change to the PRs/Findings/Detail/Plan-match tabs this spec does not touch).
