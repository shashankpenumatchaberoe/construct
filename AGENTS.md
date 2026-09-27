# Construct Agent Contract

> **This is not this repo's contract.** This file (and `architecture.yml`
> next to it) is leftover output from once running `construct init .` in
> this repo. It describes the rules Construct *generates and enforces on
> target projects* that use the tool — not on Construct itself. If you are
> working on this repo (the Construct tool), read `CLAUDE.md` at the repo
> root instead; the rules below do not apply here.

1. Read `architecture.yml` before modifying code.
2. Respect the default architecture unless the project policy explicitly changes it.
3. Route → Controller → Workflow → Service → API.
4. Controller → Page → Component.
5. Pages cannot contain business logic, workflows, services, API calls, or `fetch()`.
6. Components cannot access controllers, workflows, services, APIs, or domain logic.
7. Domain is pure by default; services own external effects.
8. Features are isolated; consume another feature only through its `index.ts`.
9. Prefer one primary module per file.
10. Run `construct validate --format json` before finishing.
11. Fix violations; do not weaken policy merely to make validation pass.
