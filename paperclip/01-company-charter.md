# Company charter — Construct

Paste this as the company rules / CEO standing instructions.

## What we work on

One repository: `/Users/shashank/Repositories/construct`
(`github.com/thenewurbankid-web/construct`, fork `github.com/shashankpenumatchaberoe/construct`) —
and within it, **only `trace/`** (the project formerly called `line-matcher`). `studio-export/`
and Construct's own product code are not in scope for this company yet.

Trace is organized as four projects, inferred from its existing worktree/feature history —
correct the names below if they don't match your intent:

1. **Matching Engine** — the deterministic core: confidence scoring, extraction, labels,
   smartness/stub-scope heuristics, the eval gate, feature-grouper (Ollama-based grouping),
   the Qwen verification layer (must always sit behind a measured-accuracy check, never pick
   unverified — see `trace/CLAUDE.md`).
2. **Contracts & Import** — Swagger/OpenAPI contract import, contract-drift detection
   against a running backend, the import wizard, Subframe embedding.
3. **Studio & Demo** — the Seam demo shell, presenter mode, the Trace studio UI, layers
   view, the part inspector.
4. **Page Map & Releases** — the page-map feature, and the release train itself (R0/R1/R2
   and their minor releases), plus Trinity monitoring/training.

## Repo conventions this company must follow

- **Branching**: this repo's shared integration branch is `work/2026-09-23` (Construct's own
  convention — a persistent branch since their last stable freeze, not a daily-cut one). All
  work happens in a git worktree, never directly on that branch and never in the main
  working directory. See `/CLAUDE.md` (repo root) for the full rule.
- **Never commit or push to `work/2026-09-23` directly.** Cut a worktree/branch per task
  (`trace/<project>-<task-id>-<slug>`), following `trace/CLAUDE.md`'s existing worktree
  recipe (rsync mechanics — `trace/` is untracked in git). Push only to the `fork` remote;
  this account has no push access to `origin`. A PR into `work/2026-09-23` needs Shashank's
  approval; pushing a branch does not.
- **Definition of done** for any code task: whatever `trace/CLAUDE.md` and the relevant
  project's own conventions already require (tests + the eval gate green, the one reviewer's
  pass), with the diff attached to the task. A task closed without that gets reopened.
- **Trace's existing subagent workflow keeps doing the actual code changes for now.** This
  company's job is routing and reporting, not replacing `builder`/`reviewer` subagents.
  Leads dispatch to those the same way the main Claude Code session already does.
- **No secrets in tasks, logs, or code.** `.env*`, API keys, and tokens are never read into
  a task description.
- **Ask instead of guessing** on product behavior or scope. A wrong assumption shipped costs
  more than a blocked task.

## How work flows

Shashank talks to the **Delivery Manager** and no one else. The Delivery Manager turns the
request into a task and routes it to the right project's **Lead** (one of the four above),
who breaks it down and dispatches it (via the existing builder/reviewer subagents) → work
happens in a worktree → the reviewer verifies against the definition of done → the Lead
reports back to the Delivery Manager with the diff and verification output → the Delivery
Manager confirms the gate was met and reports to Shashank.

Only the Delivery Manager reports to Shashank, **and only when there's a demo-ready result
or a genuine blocker** — no progress narration, per the repo's standing rule (`/CLAUDE.md`).
Leads report to the Delivery Manager, not directly to Shashank. Nobody skips a level.
