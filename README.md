# Construct

![version](https://img.shields.io/badge/version-0.9.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

**AI guesses. Construct computes.**

Asking a model to build or refactor your app costs tokens every time, and a
wrong answer can slip in silently. Construct is the other half: small,
deterministic blocks that do the same job the same way, every time, under
rules you write down.

- **Blocks, not guesses.** Create, move, rename, validate, summarize and review code with commands that need no model. Same input, same result, zero tokens.
- **Your rules, enforced.** One file, `architecture.yml`, says where things live. `construct validate` tells you, with the reason and the fix, when code breaks a rule.
- **A cockpit, not an autopilot.** A web Cockpit lets you browse, preview, plan, review and correct, with a person always in the loop.

Status: version 0.9.0 (the MVP release). How versions are numbered is in
[docs/VERSIONING.md](docs/VERSIONING.md). What changed is in [CHANGELOG.md](CHANGELOG.md).

## Quickstart (about 60 seconds)

You need Node 20 or newer.

```bash
git clone https://github.com/thenewurbankid-web/construct.git
cd construct && npm install && npm link      # puts `construct` on your PATH

construct init my-app                        # a new project with the rules already in place
cd my-app && npm install
construct validate                           # checks the code against architecture.yml
construct --version                          # confirm which build you're running
```

`npm link` points `construct` at `packages/cli/construct.mjs` straight out of the
checkout — nothing to build first. If you want a single, portable file instead (to
copy elsewhere, or vendor into another project), build it:

```bash
npm run build:cli               # bundles packages/cli/construct.mjs -> packages/cli/dist/construct.mjs
node packages/cli/dist/construct.mjs --version
```

That's an esbuild bundle (the same approach as `ui/server`'s own build, see
[docs/DEPLOY.md](docs/DEPLOY.md)): it inlines this repo's own `packages/cli`
+ `packages/core` + `packages/ast` + `packages/engine` code into one file, so it has
no dependency on the workspace's folder layout; real npm dependencies still resolve
normally from `node_modules`. The root `npm run build` (`tsc --noEmit`) is a separate,
unrelated type-check — run both if you're touching the CLI's own source.

A fresh project passes. `construct validate` exits 0 and may print warnings,
each with a reason and a fix. Now open the Cockpit on that project (two
terminals):

```bash
cd construct/ui/server && npm install && npm start     # backend, port 4000
cd construct/ui/client && npm install && npm run dev   # frontend, port 3000
```

Open http://localhost:3000 and pick your project. On your own machine it needs
no login and listens only on localhost. For a shared server, see
[Run the Cockpit](#run-the-cockpit).

## What you can do

Three surfaces over the same blocks. Each is listed on its own.

### CLI

| Command | What it does |
|---|---|
| `construct init` | Start a project, or adopt Construct in a subfolder of an existing one |
| `construct validate` | Check code against your rules, with the reason and the fix (`--format json` for scripts) |
| `construct create ...` | Scaffold a feature, a layer, or a service from an OpenAPI spec |
| `construct refactor ...` | Move or rename a file, and update every import of it |
| `construct research ...` | Read-only: summarize, explain workflows in plain English, compute the impact of a change, run a doctor check |
| `construct summarize` | A plain summary of any feature, file, route or rule |
| `construct review <base> <head>` | Pull request health between two git refs, without a model |
| `construct import ...` | Bring an old file or a whole route into the architecture |
| `construct template ...` | Named, reusable plans |

Run `construct` with no arguments for the full list and every flag.

### Cockpit (web UI)

| Area | What it does |
|---|---|
| Browse and preview | Pages, components and features, with a live preview of your app and click to jump to the code |
| Edit | Pages editor, workflow editor (states and transitions, saved as a small source diff), Monaco source view |
| Plan and run | Turn a ticket into a checked plan, then run it as a process you can watch, pause and approve |
| Review | Pull requests grouped by feature and layer, with findings split into mechanical fixes and conversations |
| Tests | Generated Playwright tests per scenario, clone one to edit it in plain steps |
| Save | Commit from the Cockpit with a message that counts the impact |

### Core (the library)

| Block | What it does |
|---|---|
| Rule engine | Layer, boundary, purity, readability and workflow rules, all set in `architecture.yml` |
| Generators | Deterministic scaffolds for every layer, plus OpenAPI to RTK Query services |
| Impact and summaries | The blast radius of a change, with each entry marked derived or inferred |
| Plans and processes | A plan schema, a process runtime with logs and artifacts, and an approval gate |
| PR health engine | The indicators behind `construct review` |
| Frameworks | Next.js App Router and a client-routed React SPA, with the same rules on both |

A model is optional. `--llm <provider>` on `import` and `create` fills a file
using Claude or a local Ollama model, one small call per file, and only when
you ask.

## Run the Cockpit

**Locally.** Use the two commands in the Quickstart. Everything is served from
your machine and only you can reach it.

**Hosted, for a team.** Any non-local address requires GitHub login, and only
the GitHub accounts you list are let in. You need a GitHub OAuth app and
these settings, given as environment variables (never committed):

```bash
PUBLIC_HOST=<your ip or domain> \
CONSTRUCT_GITHUB_CLIENT_ID=<oauth app id> \
CONSTRUCT_GITHUB_CLIENT_SECRET=<oauth app secret> \
CONSTRUCT_ALLOWED_LOGINS=<comma-separated github logins> \
packages/tools/dev/run-hosted.sh
```

The script prints the callback URL to register on your OAuth app. Details,
every option and the security notes are in [ui/README.md](ui/README.md). The
Cockpit is confined to one workspace folder (`CONSTRUCT_WORKSPACE_ROOT`,
default `~/workspace`): it starts with no project open, and you choose one
from inside that folder.

## Docs

- Documentation site: https://thenewurbankid-web.github.io/construct/ (the latest docs; each release will also keep its own version of the docs, see [docs/VERSIONING.md](docs/VERSIONING.md))
- [docs/](docs/): architecture, execution model, impact analysis, PR health, unit summaries, workflow narrator, design
- [ui/README.md](ui/README.md): the Cockpit, its login and its tests
- The Cockpit's Help page has short tutorials

## Contributing

Read [CLAUDE.md](CLAUDE.md) first. It sets the working rules: an issue for each
unit of work, comments before and after, a real test for every change, a
Playwright test and screenshot for every UI change, and the deterministic-first
principle from the Vision below. Run `npm test` before you open a pull request.

## Open core

The core library and CLI are open source (MIT). The Cockpit UI (it lives in
`ui/` for now), the MCP server (`packages/mcp`, read-only and plan-only so far) and the curated predefined envelopes
are proprietary, not part of the open packages. The open packages never depend
on them.

## Vision

Construct is a framework of **non-LLM lego blocks** — small, deterministic,
code-driven pieces that compose together to build a web app, or refactor an
existing one, according to constraints the project defines (`architecture.yml`).
An LLM is one possible operator of these blocks, not a requirement baked into
them: every block does its job the same way whether a human clicks it, a
script calls it, or an agent invokes it.

**Think cockpit, not autopilot.** The blocks are extended by a UI (`ui/`) so
humans can observe what's happening and collaborate with whatever is doing the
building — construct, browse, and correct, rather than hand the whole thing to
a model and hope. The goal is enough blocks that you can build an app in a few
clicks, or correct an LLM-generated one in a few clicks, instead of re-prompting
and hoping the next generation is right. The same blocks are exposed to LLMs
through an MCP server with **deterministic flows**, so automated development
goes through the same repeatable machinery a human would use by hand — a team
doing the same kind of work over and over shouldn't burn time and tokens
reinventing it each time. The point of building this is to free LLM usage for
actual innovation, not repetitive plumbing.

**The mantra: an LLM understands an example better than an instruction.**
Layers are structured so that one layer's real output becomes the next layer's
concrete example, not an abstract spec to interpret from scratch. Each layer
is mostly code-driven, and calls an LLM only where a deterministic block
genuinely can't do the job (see `import --llm`, the route wizard's analysis
step — the *only* two places in this whole tool that ever call one).

**The hypothesis this project is testing**: if repetitive development work is
broken down into small enough pieces, most of it needs no LLM at all — and
wherever an LLM *is* still needed, its task is small, its guidance is a real
example rather than an instruction, and the framework's own validation
(`IMPORT-001`, the `PAGE-*`/`COMPONENT-*` rules, etc.) catches it immediately
if it goes off the rails, instead of a wrong answer silently shipping.

**Three tiers, one framework** — this is meant to be a genuinely new
development experience, not just a different chat window:
- **Beginner**: chat only (the guided import wizard, the UI's chat interface).
- **Intermediate**: a no-code UI editor — dig into forms, visual trees, drag
  interactions (the Dashboard, the pages/JSX editor, workflow visualization).
- **Expert**: full code, same architecture, same rules, no ceiling.

All three tiers operate on the same underlying blocks and produce the same
kind of output, so moving between tiers — or watching PRs, features, and
commits move through them — stays legible instead of being three unrelated
tools bolted together.

**Everything is feature-based** on purpose: business logic lives *in* the
code's own architecture (the 7-layer feature structure), not scattered across
prose instructions an LLM has to re-derive intent from every time — the
architecture itself is the spec. The runtime summarizer (`construct
summarize`) closes the loop by giving an AI (or a human) an on-the-fly,
plain-English summary of what a feature's code actually does, so exploring an
unfamiliar feature is cheap instead of a full read-through every time.

Every new capability in this repo should be judged against this: does it add
a deterministic block, make an existing one more atomic, make the *example*
a layer hands the next one better, or extend the cockpit UI — or is it quietly
routing around this and making the LLM do more work than it needs to?

## How we build

These are the principles behind every block, screen and decision in Construct.

- **Repeatable work belongs in blocks, not in prompts.** If a task is done the
  same way twice, it becomes a small, deterministic block with a known input
  and a known output. People and models then spend their time on what is new.
- **Stand on open source.** Where a well-maintained open-source tool already
  does a job, Construct wraps it instead of rewriting it. We build only the
  parts that make Construct what it is: the architecture rules, the plans and
  their impact, the flow narrator and test generator, the approval gate and
  the workspace boundary.
- **Every choice is yours, and reversible.** Mechanical or model-assisted,
  per action. Which model. Mock or real service. Which blocks a project may
  use. The guardrails do not move when you flip a switch: every change is a
  diff you approve, every path stays inside your workspace, every command
  says how many model calls it made.
- **No hidden single point of failure.** State lives in files you can read,
  work lives on branches you can inspect, and a failed step stops the plan
  instead of guessing. Where a weak point still exists, it is written down
  and tracked, not assumed away.
- **Automate the way we work, too.** The board, the milestones, the changelog,
  the versioned docs and the Cockpit itself are kept in sync by machinery,
  so what you read is what is true.

## Default architecture

```text
Route → Controller → Workflow → Service → API
             └────→ Page → Component

Workflow → Domain
Service  → Domain
Hook     → Workflow / Service / Domain
```

This layer graph — and every rule in `rules:` — is identical regardless of `project.framework`. The one thing that differs per framework is what a **Route** physically is and how a **Controller** gets wired into it; see [Framework targets](#framework-targets).

## Framework targets

Construct's feature-internal architecture (everything from Controller down: Workflow/Service/Domain, Controller → Page → Component) never changes based on `project.framework` — only the **route layer** does, because that's the one place a real difference in how the two kinds of app actually route requests shows up.

| | `nextjs` (default) | `react-spa` |
|---|---|---|
| Route layer pattern | `app/**/page.tsx` — one file per route folder (Next.js App Router file-system routing: route groups `(name)`, dynamic segments `[name]`) | `src/App.tsx` — one centralized react-router table for the whole app |
| How a controller gets registered as a route | A physical `app/<route>/page.tsx` imports the controller and renders it as the page's default export | A `<Route path="..." element={<XController />} />` entry inside `src/App.tsx` |
| `construct init [--framework ...]` scaffold | `app/page.tsx` | `src/main.tsx` (a real bootstrap: `BrowserRouter` + `createRoot`) + `src/App.tsx`, with the `core` feature's controller already registered as a route |
| `construct import --route <url>` entry resolution | Walks `app/` for the folder owning `page.tsx`, matching route groups/dynamic segments (`packages/core/route-resolver.mjs`) | Parses `src/App.tsx`'s `<Route>` table for the controller name registered at that URL, then locates it under `features/*/controllers/` |

Everything else — every generator, every rule, the controller's own composition (it still imports and renders a same-named `Page` from the feature's `pages/` folder either way, since that's Construct's own convention, not Next.js's) — is identical between the two targets. Set it in `architecture.yml`:

```yaml
project:
  framework: react-spa   # or nextjs (default)
  language: typescript
```

`fixtures/architecture-valid-react-spa/` is a complete, real, checked-in worked example — `construct validate` passes against it with zero errors — showing the shape end to end: `architecture.yml`, `src/main.tsx` + `src/App.tsx`, and a full `widget` feature slice.

## Non-negotiable defaults

- Routes are thin and delegate.
- Controllers compose; they do not become business-logic dumping grounds.
- Workflows own application state and flow.
- Hooks own React/application logic only when React context is needed.
- Domain is pure by default.
- Services own network/external effects.
- Pages are presentation-only.
- Components are presentation-only except local UI state.
- Features are isolated behind `index.ts` public APIs.
- One primary module per file.
- Every responsibility has an architectural owner.

## Typed contracts (allowlist enforcement)

**Installing `@line/construct-core` (#678).** A generated unit imports its factories from
`@line/construct-core/typed-contracts` (a real package specifier, proven against a real `tsc`
in `test/typed-contracts-publish.test.mjs`), and `construct create layer --shape ...` (or any
other generator that introduces it) now declares it in the project's `package.json` for you
through the existing `add.dependency` flow — never installs, never touches an already-present
entry. That line alone is not enough to `npm install` from outside this monorepo yet, though:
`packages/core/package.json`'s `publishConfig` points at `https://npm.pkg.github.com` with
`access: "restricted"`, the same as every other `@line/*` package here (`cli`, `mcp`, `studio`)
— a private GitHub Packages registry scoped to this org, not the public npm registry. Until
`@line/construct-core` is published somewhere publicly installable, a project outside this repo
has two supported paths: (1) get GitHub Packages access from the owner and add a `.npmrc` line
(`@line:registry=https://npm.pkg.github.com`) alongside an auth token, or (2) vendor
`packages/core/typed-contracts/` directly — it ships as plain, uncompiled `.ts` sources with no
build step (see the publish test above), so copying the directory into the project and pointing
a local path/alias at it works without the registry at all.

Most layer rules above are enforced two ways at once, not just one:

- **Composition prevents** — `packages/core/typed-contracts/` gives each layer a
  branded type (`DomainUnit<T>`, `PageUnit<T>`, `ComponentUnit<T>`,
  `ExpressionUnit<T>`, `ServiceUnit<T>`, `WorkflowUnit<Fn>`, `ControllerUnit<T>`,
  `RouteUnit`, `ProviderUnit`) and one `defineX<Props>(name, fn)` factory per
  layer. A factory's parameter types are the actual import boundary — a
  `defineDomain` unit's params have no slot that accepts a `ComponentUnit`, so
  a wrong wiring is a real `tsc` error at the call site, not a rule fired
  after the fact. `PropRef<T>` lets a param point at something already in
  scope instead of taking a literal, and `withFeature()` brands a unit to one
  feature so cross-feature sharing (`SLICE-004`) must go through an explicit
  wrapper. This is the allowlist half: the factory is the one shape to copy,
  matching the project's own mantra that an example teaches better than an
  instruction.
- **A service declares what it returns** — `defineService(name, fn, { schema })`
  parses `fn`'s value at the boundary. `schema` is any
  [Standard Schema](https://standardschema.dev) object (`~standard.validate`:
  zod 3.24+/4, Valibot, ArkType, or one written by hand) or a `safeParse`-shaped
  one; core imports no schema library. A mismatch is a typed state, never a
  throw, and the caller has to narrow on it before touching `value`:

  ```ts
  import { z } from 'zod';
  import { defineService } from '@line/construct-core/typed-contracts';

  const User = z.object({ id: z.string(), role: z.enum(['user', 'admin']).default('user') });

  const fetchUser = defineService(
    'fetchUser',
    async ({ id }: { id: string }): Promise<unknown> => (await fetch(`/api/users/${id}`)).json(),
    { schema: User },
  );

  const result = await fetchUser({ id: 'u1' });
  //    ^? { status: 'ok'; value: { id: string; role: 'user' | 'admin' } }
  //     | { status: 'error'; kind: 'schema'; issues: { message: string; path: PropertyKey[] }[] }
  if (result.status === 'error') return showIssues(result.issues);
  result.value.role; // narrowed to the schema's OUTPUT type (`.default()` applied), not `unknown`
  ```

  A sync `fn` stays sync; without `{ schema }` the two-argument form is
  byte-for-byte what it was. The schema also rides along as `fetchUser.schema`
  for tooling. `construct create service <name> --feature <f> --openapi <spec>`
  writes the schemas from the spec (`z<Op>Response`, zod 4) when the project
  has zod or `--schema` is passed (see "Service generator"). Fixtures: `examples/service-schema.ts` (hand-written Standard
  Schema, `safeParse`), `examples/service-schema-zod.ts` (real zod) and
  `examples/service-schema-invalid.ts` (using `.value` before narrowing is a
  `tsc` error).
- **Validation catches** — the existing rule engine (`construct validate`)
  remains the backstop for hand-edited files and cases a type system can't
  see: `EXPR-001`..`EXPR-006` (a new `expressions/` layer for If/Switch/
  template units), `HOOK-001`/`HOOK-002` (tracked state and Provider hooks),
  `PAGE-001`/`PAGE-006`/`PAGE-008`/`PAGE-009` (no state or effect of its own,
  only sanctioned hook imports, no inline JSX logic, a complexity budget),
  `COMPONENT-001` (no application state machine in a component), `PURE-001`
  (no `Math.random`/`Date.now`/`new Date()` in domain code), `DOMAIN-002` (purity as an allowlist —
  a domain function may reference only its own params/destructured bindings/
  type-only imports/JS built-in globals, opt-in via `architecture.yml`,
  additive alongside the older `DOMAIN-001` name-based denylist it will
  eventually replace), and `READ-004` (a unit's filename encodes its layer as
  a suffix — `Name.layer.ext`, e.g. `AddWidget.domain.ts`,
  `WidgetCard.component.tsx`, `useCartState.state.ts`,
  `useUserProvider.provider.ts` — a cheap string match, no `tsc`/AST pass
  needed, so it can run live on every keystroke; off by default since every
  fixture in this repo predates the convention, opt-in via
  `architecture.yml` once a project is ready to rename its own files), and
  `STATE-001` (a workflow's or hook's state is a discriminated union on one
  `status` field, not a bag of co-occurring flags — see below; off by
  default, opt in with `rules: { STATE-001: warning }`), and `SERVICE-003`
  (a service's `fetch` forwards the caller's `AbortSignal` so a superseded
  request never lands — off by default, opt in with
  `rules: { SERVICE-003: warning }`), and three more stale-input rules of
  story #577, each off by default: `CONTROLLER-003` (a controller calls no
  `useState`/`useRef`/`useEffect`/`useMemo`/`useCallback`, so it binds the hook's
  live value, never a copy), `HOOK-003` (an effect that adds a listener, timer,
  subscription or request returns its cleanup) and `ROUTE-003` (a route forwards
  `params`/`searchParams` whole instead of reading them); see
  [docs/staleness-by-layer.md](docs/staleness-by-layer.md).
- **Client boundary** — `CLIENT-001` (*a `'use client'` file cannot import
  server-only code*, #644). A file whose first statement is the `'use client'`
  directive, and every file only reachable through it, ships to the browser, so
  none of them may import a module in the `service` layer, the `server-only`
  package, a database or SDK adapter (`@prisma/client`, `pg`, `mysql2`,
  `mongodb`, `redis`, `stripe`, `aws-sdk`, `@aws-sdk/*`, `nodemailer`, `fs`,
  `child_process`, ...; extend the list with `serverOnly: [...]`), or a module
  that reads a `process.env` variable that is not `NEXT_PUBLIC_*`, and may not
  read one itself. It follows imports, re-exports (`export * from`) and
  `import('...')` through the project's import graph: a file imported by both a
  server and a client file is judged from the client edge, `import type` is
  erased and never counts, and a `'use server'` file is the sanctioned exit (a
  client imports the action, nothing behind it is followed). The finding sits
  on the file that draws the import, names the `'use client'` entry and the
  chain that puts it in the browser, and says the fix: move the call behind a
  server action or a service a server component calls. `construct init`
  scaffolds it as `error`; an existing project is untouched (default `off`) and
  opts in with the rule below. A project whose `services/` are browser-side
  API clients (a `'use client'` hook calling a `fetch` wrapper, as `ui/client`
  does) sets `serviceLayer: false` so the service layer is not treated as
  server-only; adapters, `server-only` and secret reads still are.

  ```yaml
  rules:
    CLIENT-001:
      severity: error
      serverOnly: [acme-billing, '@acme/*']   # optional: your own server-only packages
      serviceLayer: true                      # false: services are browser-side API clients
  ```
- **Type-check** — `TYPE-001` runs a real `tsc --noEmit` (the project's own
  `node_modules/typescript`, never a global one) and reports every diagnostic
  (`TS2304: Cannot find name 'useRef'`, with file and line) as a violation, so
  code that parses and matches its layer but does not compile (a typical
  `--llm` fill mistake, #495) fails `construct validate`. Off by default (it
  spawns `tsc`); opt in with `rules: { TYPE-001: error }`, or an options
  object `{ severity: error, tsconfig: tsconfig.app.json, timeoutMs: 120000 }`.
  If TypeScript or the tsconfig is missing it reports a
  `TYPE-001 could not run: <reason>` warning rather than passing silently.
  A solution-style `tsconfig.json` (a Vite/React template's root: `references`,
  no `files`/`include`) is expanded: each `references[].path` project is
  checked with `tsc --noEmit -p` (never `tsc -b`, which emits) and the
  diagnostics are merged; an unfindable reference, or any checked config that
  resolves to zero files, is a `could not run` warning naming it (#579). The
  configs actually checked are returned as `typeCheck.checked` by
  `validateArchitecture` (and `runTypeCheckDetailed`). When `validateArchitecture` is scoped to `files`, only errors in those files
  are reported (the whole program is still checked).

`STATE-001` reads the state shapes a workflow or hook file declares — an
interface, an object-literal type alias, the initial object (or inline type
argument) of `useState`/`useReducer`, a top-level const named like an initial
state, an XState `context` — and flags one whose fields combine two boolean
status flags (`isLoading` + `isError`, `pending` + `failed`, `ready` + `loaded`)
or one flag with both an `error` and a `data`-style field. A `data`-style field
is `data`/`result`/`response`/`payload`/`value`/`items`, or a nullable
non-primitive slot in a declared type whatever its name (`listing: Listing | null`,
`session?: Session`; never `notice: string | null`, `selectedId`, or an untyped
`null` in an initial object). Those objects can
express states that cannot happen (loading and failed at once, stale data next
to an error). One flag plus `data`, a `status` field, a union, or a flag-named
field that is not a boolean (`ready: Promise<void>`) is never reported. The
violation names the fields and carries the rewrite, built from the real field
names and types:

```ts
// Before (STATE-001): `loading`, `error` and `data` can all be set at once
type ItemsState = { loading: boolean; error: string | null; data: Item[] | null };

// After: each state carries only the fields that exist in it, and a
// `switch (state.status)` is checked for exhaustiveness by the compiler
type ItemsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'success'; data: Item[] };

const [state, setState] = useState<ItemsState>({ status: 'idle' });
```

Both layers are additive: a project using neither the new factories nor
`expressions/` sees no behavior change. See `packages/core/typed-contracts/`
and its `examples/` for real compiling and non-compiling fixtures, and issue
#500 for the full phased plan (this is phase 1 — proving the pattern in a
real dogfood run and wiring live Cockpit diagnostics are phases 2-3; removing
the now-superseded denylist rules is phase 4, not yet done).
`docs/staleness-by-layer.md` states, per layer, what "stale input" means, the
guard that rejects it, and which guards are enforced today versus proposed
(#577), with a copyable example per layer.

## Modifying conventions

Change `architecture.yml`:

```yaml
rules:
  PAGE-004: warning
  PURE-001: off
```

Severity:

- `error` — validation fails
- `warning` — reported but does not fail
- `off` — disabled

Temporary exceptions may be scoped and expired:

```yaml
exceptions:
  - id: LEGACY-001
    path: features/legacy/**
    rules: [PAGE-004]
    reason: Temporary migration
    owner: platform-team
    expires: 2026-12-31
```

## Commands

Three capabilities, each with its own namespace — a friendlier grouping over the same underlying commands, not a second implementation:

```bash
# create — scaffold a feature, a layer, or a whole vertical slice
construct create feature <name> [--format json] [--dir <path>]
construct create layer <name> --feature <feature> --layers <l1,l2,...> [--format json] [--dir <path>]
construct create <layer> <name> --feature <feature> [--format json] [--dir <path>]
construct create service <name> --feature <feature> --openapi <spec> [--schema | --no-schema] [--dir <path>]

# refactor — mechanical, LLM-free moves/renames within the architecture
construct refactor move <name> --feature <feature> --from <layer> --to <layer> [--format json] [--dir <path>]
construct refactor rename <name> <newName> --feature <feature> --layer <layer> [--format json] [--dir <path>]

# research — read-only: summarize a feature, or check environment/tooling
construct research summarize [--feature <name>] [--format json|md|compact|prose] [--since <ref>] [--dir <path>]
construct research impact <unit-ref>... [--files a,b] [--since <ref>] [--ticket <text>] [--depth N] [--format json|markdown] [--dir <path>]
construct research spec <file> [--format json|text] [--dir <path>]
construct research doctor [--dir <path>]
```

`construct research workflow <feature> [<file>] [--format prose|md|json|scenarios]` explains a feature's XState workflows in plain English (each state, every start-to-end scenario, health findings), derived from the real source every time with no LLM — see `docs/workflow-narrator.md`.

`construct research spec <file> [--format json|text]` checks a `machine-spec.v1` file — an English requirement, sentence by sentence, broken down into states, events, guarded transitions and typed functions, each linked back to the sentence it came from — and refuses it with a `SPEC-*` code, the path and the reason when a state is unreachable, a transition names an unknown state or event, a function has no types, or a sentence is neither covered nor marked out of scope. Deterministic, no LLM; the spec is the contract a person (or a model, given the schema and the worked example) drafts before anything is generated from it — see `docs/machine-spec.md`.

`construct summarize <ref> [--detail brief|standard|full] [--format json|markdown]` (and `--list`, `--usage`) returns a deterministic, LLM-free summary of any project, feature, layer, file, hook, workflow, route, rule or package, sized for a bot or a teammate — see `docs/unit-summary.md`.

`construct research impact <ref>... [--files a,b] [--since <ref>] [--ticket <text>] [--depth N] [--format json|markdown]` computes the blast radius of a change: which features and layers it touches, why each file is implicated, what is shared across features, and what your rules already say about those files. Every entry is marked `derived` (computed from the graph) or `inferred` (reached only from a seed that was guessed from ticket text or proposed by a model), so you can see exactly where judgement entered — see `docs/impact-analysis.md`.

`construct review <base> <head> [--plan <file>] [--features a,b] [--format json|markdown]` reports pull request health between two git refs with no model: what changed by feature and layer, changes nobody explained, rule regressions, public-surface changes and the flow diff, with findings split into mechanical fixes and conversations — see `docs/pr-health.md`. `construct template list|show|instantiate` prints named, reusable plans from a folder you point at with `--templates <dir>`; none are bundled.

`construct refactor` never rewrites a file's own logic or exported identifier — only its location/name and every other file's import of it (including the moved file's own same-layer imports, re-resolved for its new home). Whether the result is *valid* in its new layer — naming convention, purity, everything else — is `construct validate`'s job, reported immediately after the move so a mismatch shows up right away. There's no persistent activity log: each command prints one clear, scannable line for what it did (`Created ...`, `Moved ... -> ...`), and that line **is** the record — a file that changed without one wasn't done by the tool.

The flat commands below are unchanged and still work — `create`/`refactor`/`research` are just a grouping on top:

```bash
construct init [dir]
construct feature create <name> [--dir <path>]
construct generate <layer> <name> --feature <feature> [--dir <path>]
construct generate layer <name> --feature <feature> --layers <l1,l2,...> [--dir <path>]
construct sync [--dir <path>]
construct validate [--dir <path>]
construct validate --format json [--dir <path>]
construct doctor [--format json] [--dir <path>]
```

## Service generator: OpenAPI -> RTK Query

`construct create service <name> --feature <feature> --openapi <spec>` compiles a real OpenAPI 3.x spec straight into a working [Redux Toolkit Query](https://redux-toolkit.js.org/rtk-query/overview) `injectEndpoints` file — no LLM involved. [`@hey-api/openapi-ts`](https://heyapi.dev/) parses the spec (`$ref` resolution, `allOf`/`oneOf` composition, ...) into correctly-typed request/response TypeScript; Construct's own deterministic template turns that into RTKQ endpoints:

```bash
construct create service petStore --feature pet --openapi ./openapi/petstore.yaml
```

This writes:

- `features/core/services/client.ts` — the shared `api` (RTKQ `createApi`) and `baseQuery`, re-exported from `features/core/index.ts` so other features can consume it through the public API (`SLICE-002`-clean).
- `features/<feature>/services/<name>/{index.ts,types.gen.ts}` — hey-api's generated types for every operation.
- `features/<feature>/services/<name>Api.ts` — the RTKQ `injectEndpoints` file, one `query`/`mutation` per operation (GET/HEAD -> query, everything else -> mutation), plus its generated `use<Op>Query`/`use<Op>Mutation` hooks.
- `features/<feature>/services/<name>/zod.gen.ts` — only when asked (below): the spec's response shapes as [Zod](https://zod.dev) (MIT) schemas, `z<OperationId>Response`.

**Response schemas (#575).** hey-api's `zod` plugin writes the Zod file, and `defineService` (see "Typed contracts") checks it at the service's boundary. It is written when the project's `package.json` declares `zod`, or with `--schema`; `--no-schema` never writes it; without zod the file is skipped (it imports `zod`, so a project without it would stop compiling) and the command says so. A spec with no response schema writes none. Zod 4 is what hey-api emits by default.

```bash
construct create service petStore --feature pet --openapi ./openapi/petstore.yaml --schema
```

```ts
import { defineService } from '@line/construct-core/typed-contracts';
import { zListPetsResponse } from './petStore/zod.gen';

export const listPets = defineService('listPets', async (_: object): Promise<unknown> => (await fetch('/pets')).json(), {
  schema: zListPetsResponse,
});
// (await listPets({})) is { status: 'ok', value: Pet[] } | { status: 'error', kind: 'schema', issues }
```

Which transport `client.ts` instantiates is controlled by `project.dataLayer.provider` in `architecture.yml` — `fetchBaseQuery` (the default), `axios`, or a network-free `mock` adapter for tests/demos:

```yaml
project:
  dataLayer:
    provider: axios   # or fetchBaseQuery (default), or mock
```

Switching providers only ever touches `client.ts` — every generated `services/*.ts` endpoint file calls the same provider-agnostic `buildRequest(method, urlTemplate, data)` helper regardless of which adapter is active. Every operation in the spec needs an explicit `operationId` (used to line up the RTKQ endpoint with the type hey-api generated for it) — a spec without one fails fast with a clear error rather than guessing a name that might not match.

## Decision traces: what was chosen, recorded, and any decision provider scored on it (#643)

Every closed question a person answers in a chain (the Requirement screen's open questions and the list-shape offer, a placement question, a compiled chooser chain) is appended as one `decision-trace.v1` record: the question as it was offered, the option chosen, who chose, what the `rules` provider suggested and whether it was taken, and later whether the plan validated. Records go to the per-user state directory (`<state dir>/traces/<project>/decisions.jsonl`, next to process records), never into your project, hold no path or secret (a record that would is refused), and never leave the machine. A project switches recording off with a top-level `traces: off` in `architecture.yml` (default `on`, because they stay local).

```bash
construct traces list [--chooser <id>] [--json]
construct traces stats [--json]
construct traces replay --provider <name> [--min-traces 30] [--plugin <file.mjs>] [--json]   # beats / ties / loses vs the rules baseline
construct traces replay --model <name> [--all]                                             # the same for a model registered by `construct model import`, enabled or not
```

The suggestion that is recorded comes from the project's decision provider (`decision: { provider: rules|off|<name>, plugin: <file in the project> }` in `architecture.yml`, default `rules`). `construct decide --summary <file|-> | --requirement "<sentence>" [--format json]` is that provider as a read-only tool (a chooser summary in, one suggestion out; for a sentence, one per open question and offer), and the Requirement screen marks the suggested option "suggested by rules" with its reason, still one click to take and one to change. A plugin is a small file that default-exports `{ name, version, suggest(summary) }`, receives only the frozen, path-free summary and falls back to `rules` when it fails or is slow: see `docs/DECISION-PROVIDERS.md`.

Replay is deterministic and read-only: no model, no network. A provider is promotable only when it beats the `rules` baseline on at least 30 person-made traces.

A model is never trained on the dev machine. `construct traces export --out <dir>` previews and, with `--yes`, writes a dataset bundle (records re-validated, an 80/10/10 split by a hash of the id, a manifest with hashes); the kit in `train-kit/` trains on another machine (a MacBook, or any box with Python 3); `construct model import <dir>` verifies what comes back as plain data (no scripts, no pickles, checksums, a dataset this project exported), replays the held-out traces against the rules baseline and registers the model DISABLED until you enable it. See `docs/TRAIN-ELSEWHERE.md`. Fields, privacy and the command in full: `docs/DECISION-TRACES.md`.

## Cockpit execution mode: in-process engine or the real CLI (#541)

The Cockpit runs each **core activity** (the verbs `validate`, `summarize`, `research`, `review`, `create`, `refactor`, `import`) in one of two modes, chosen per project in `architecture.yml`, same shape as `project.dataLayer.provider`:

```yaml
project:
  execution:
    mode: cli   # or engine (default): call packages/core in-process
```

`project.execution.mode` is `engine` or `cli`; absent means `engine`, so nothing changes unless a project opts in. Any other value is a usage error (exit 2 on the CLI, HTTP 400 in the Cockpit) that names the allowed values. The CLI itself ignores the setting: it always is the CLI.

- `engine` (default): the Cockpit server calls the same `packages/core` and `packages/engine` functions the CLI does, in-process.
- `cli`: the server spawns the real binary, `node <construct.mjs> <verb> ... --format json --dir <project>`, with the project root as its working directory, a minimal allow-listed environment (a shell's basics plus only the `CONSTRUCT_*` names the CLI itself reads, e.g. `CONSTRUCT_TEMPLATES_DIR`, `CONSTRUCT_STATE_DIR`; never the server's secrets or e2e seams, never a `*_SECRET`/`*_TOKEN`/`*_PASSWORD`/`*_KEY` name), parses only the JSON document (never the human text), and shows a timeout, a crash or non-JSON output as an error (HTTP 502 with the CLI's own message), never as an empty result. The `--dir` it is given is always the server's own derived, contained project root, and the paths `create`/`import` read are the workspace-contained ones, never a client string. Runs go through the same per-login queue and concurrency cap as the in-process path. Use it where you want the Cockpit to run exactly the `construct` a project pins.
- Which binary: `CONSTRUCT_CLI_BIN=/path/to/construct.mjs` (a source `packages/cli/construct.mjs` or the built `packages/cli/dist/construct.mjs`); otherwise this repo's `packages/cli/construct.mjs`; otherwise an installed `@line/construct` (how the split Cockpit repo will get it, #540). `CONSTRUCT_CLI_TIMEOUT_MS` changes the 120 s limit.
- Every response says which mode ran (`mode`).

Per verb, what `cli` mode runs and what it deliberately does not:

| Verb | Cockpit endpoint | `cli` mode runs | Stays in-process even in `cli` mode |
|---|---|---|---|
| validate | `GET /api/validate` | `construct validate --format json` | nothing |
| summarize | `POST /api/research` `{action: summarize}` | `construct summarize --format json [--feature f]` | the `md`, `compact`, `prose` views and `since` (no JSON contract; the body says `mode: "engine"` and why) |
| research | `POST /api/research` `{action: doctor}` | `construct doctor --format json` (the text is rebuilt from the document) | nothing (`research workflow`, `impact`, `spec` have no Cockpit endpoint; they run as Processes, which already spawn the CLI) |
| review | Review mode's analysis (`review.analyze` Process step) | `construct review <base> <head> --format json`, the changed-file summaries still computed by the existing worker | nothing; refused with `CLI_ROOT_MISMATCH` when the repository top level is not itself the folder holding `architecture.yml` (the CLI would climb out of it) |
| create | `POST /api/create` | `construct create feature\|layer\|<layer> ... --format json` | any request with `useLlm` (a model call: the provider keys live in the Cockpit server) |
| refactor | `POST /api/refactor` | `construct refactor move\|rename ... --format json` | nothing |
| import | `POST /api/import` | `construct import ... --format json` | any request with `useLlm` or `llm`, and the Import Wizard (`/ws/wizard`, an interactive plan analysis with an LLM) |

`--format json` on `create`, `refactor` and `import` covers the deterministic forms only and prints one document (`{ok: true, verb, ...}`, or `{ok: false, error: {code, message}}` with the matching exit code); a flag that implies a model call or an external input (`--llm`, `--from` on `create`, `--bind`, `--openapi`, `--route`) is refused by name.

**Never switchable**, by rule (`ui/server/src/coreExecutor.mjs`): the UI-helper endpoints (scope links, Palette, the live-preview bridge, pane and resize state, the dev-server manager, and the read models `/api/units`, `/api/flow`, `/api/features`, `/api/components`) stay in-process in both modes. They fire on every hover, drag or tab change, and there is no CLI verb for them to be equal to.

Parity is a test, not a promise: `test/executionModeParity.test.mjs` (validate), `test/executionModeVerbs.test.mjs` (summarize, doctor), `test/executionModeReview.test.mjs` and `test/executionModeWrites.test.mjs` run the same throwaway project through both modes and assert byte-identical JSON (for the verbs that write files, also byte-identical project trees). The audit of which verb has which contract, and where the two paths would diverge, is in [docs/execution-model.md](docs/execution-model.md#cockpit-execution-mode-audit-of-the-seven-verbs-541-story-560).

**Recommendation for the hosted Cockpit (pending the owner's decision, not applied):** run it in `cli` mode. A hosted Cockpit runs many users' projects in one server process: `validate`, `summarize` and `review` are synchronous walks of a user's files, so in `engine` mode one large or malformed project stalls every user and a crash or out-of-memory takes the server down, whereas a subprocess is killed on timeout as a whole process group, cannot see the server's tokens (allow-listed environment), and fails as a clear per-request error. The price is one Node start-up and module load per action (measured at about 0.6 s for `construct --version` from source on the dev machine; the bundled `packages/cli/dist` is the lever to cut it) and a little more memory under load, both bounded by the existing concurrency cap; local single-user use keeps the `engine` default for the lowest latency. Open items before flipping it: the installed-package path from the split Cockpit repo (#540), and a Cockpit indicator/switch for the mode.

## Build order is enforced, not a convention to remember

`construct generate layer` scaffolds one logical unit across several layers in a single command:

```bash
construct generate layer PriceCheck --feature pricing --layers domain,hook,controller
```

You can list `--layers` in any order — Construct always generates them in dependency order (`domain -> service -> workflow -> hook -> component -> page -> controller`) so each file's imports resolve correctly by the time it's created.

This isn't just a convenience — it's backed by a real rule, `IMPORT-001`: any relative import that doesn't resolve to a file on disk is a validation error, checked both by `construct validate` and at generation time. A controller's template already imports its same-named page, so `construct generate controller X --feature F` fails immediately, with a clear message, if `pages/XPage.tsx` doesn't exist yet — you can't generate out of order and end up with a silently broken import. This is the mechanism, not `construct generate layer`'s ordering alone: any file, generated or hand-written, with a dangling relative import fails `construct validate` the same way.

## `construct init`'s project scaffold

Alongside `architecture.yml`, `AGENTS.md` and the `core` feature, `construct init` also writes a
minimal, runnable project shell for the chosen `--framework` — `package.json` (with `dev`/`build`
scripts), `tsconfig.json`, the bundler config (`vite.config.ts` + `index.html` for `react-spa`,
`next.config.mjs` + `next-env.d.ts` + `app/layout.tsx` for `nextjs`) and `.gitignore` — so
`npm install && npm run dev` (init prints this) works right after `init`, with no other
bootstrapping step. Versions are pinned to current stable majors; nothing is downloaded or
installed by `init` itself (static template files only). **An existing file is never
overwritten** — init reports it as "kept" and moves on — so re-running `init` in a project that
already has its own `package.json`/`tsconfig.json` is always safe. Pass `--no-scaffold` to write
only the Construct files and skip the project shell entirely.

## Adopting Construct inside an existing project

Construct doesn't need to own your whole repository. `construct init` accepts a directory, so you can scope it to one subdirectory of a larger, unrelated project — no changes required anywhere else in that project:

```bash
# from the root of an existing, non-Construct app:
construct init tools/construct
cd tools/construct && npm install && construct sync
```

Every other command accepts `--dir <path>` to target that subdirectory without `cd`-ing into it first (handy for CI, scripts, or running from the parent app's root):

```bash
construct generate domain PriceCheck --feature pricing --dir tools/construct
construct validate --dir tools/construct
```

`--dir` resolves the same way `cd`-ing in would — walking upward from that path to find the nearest `architecture.yml` — and every command still only ever reads or writes inside that project; nothing outside it is touched.

## Wrapping frozen, externally-authored UI (Subframe, Figma-to-code, ...)

Some UI is not yours to edit: a design tool (Subframe, Figma-to-code, a shared design system) generates or syncs it, and the team treats it as fixed design output. Construct supports this as a first-class adoption path: **a controller wraps the frozen component** — imports it and forwards props — while all data-fetching, gating and state live in `hooks/`, `workflows/`, `services/` and `domain/`. The design output stays the single source of truth and is never forked.

Declare the externally-authored files in `architecture.yml`. Globs are resolved relative to the project root and may reach *outside* it:

```yaml
frozen:
  - ../../src/subframe-pages-v2/**
  - ../../src/ui-v2/components/**
```

```tsx
// features/cpo/controllers/CpoHomeController.tsx — the whole wrapper
import CpoHome from '../../../../../src/subframe-pages-v2/Cpo/CpoHome';
import { useCpoHome } from '../hooks/useCpoHome';

export function CpoHomeController() {
  const { title, items } = useCpoHome();
  return <CpoHome title={title} items={items} />;
}
```

What `frozen:` changes (and only when it is set — projects without it behave exactly as before):

- **Read-only to Construct.** Every write path — `create`/`generate` (feature, layer, vertical), `import`, `refactor move`/`rename` (as source, destination, or an importing file that would be rewritten), and `pipeline` — refuses to touch a path matching a frozen glob, with an error naming the glob. Frozen globs are references only; nothing Construct writes is ever derived from one.
- **Wrap, don't duplicate.** Three new rules (default `warning`; set `error` to gate CI) flag a layer file that re-authors markup already present in a frozen source: `PAGE-007` (pages), `COMPONENT-004` (components), `CONTROLLER-002` (controllers). Detection is deterministic and AST-based (no LLM), with three signals:
  1. *same name* — the file exports a component with the same name as one exported by a frozen file, without importing it;
  2. *same structure* — the file has at least `minDuplicateElements` (default 6) JSX elements and at least `similarity` (default 0.8) of its element tags are contained in one frozen file's JSX, without importing that file;
  3. *not thin* — the file imports a frozen file but declares more than `maxOwnElements` (default 5) JSX elements of its own.
  Tune per rule, e.g. `PAGE-007: { severity: error, similarity: 0.9 }`, or silence one file with a normal `exceptions:` entry.
- **Frozen files inside the project root** are treated as externally authored and skipped by Construct's layer rules.

Limits: the duplicate-markup check compares JSX element tags, not props/text/styling, and only looks at files under the frozen globs; a controller that re-authors frozen markup with different tags will not be caught. A frozen file *outside* the project root that imports a file you `refactor move` cannot be rewritten by Construct (and is never touched) — update it in its own repository. See `fixtures/frozen-presentation/` for a working example (a good wrapper project and a deliberately bad one).

## AI-agent workflow

Agents should read `architecture.yml`, make the smallest local change, and run validation. JSON diagnostics expose rule ID, severity, file, line, message, rationale, expected boundary, and suggested fix.

## Architecture source of truth

`architecture.yml` is policy. Construct's implementation provides generators, validation, CLI orchestration, diagnostics, and integration configuration. This is deliberately opinionated but modifiable.

## Tooling

`packages/tools/github-comment-bridge/` is a standalone, separately-run poller (own `package.json`, not part of the Construct CLI) that lets a human dispatch a real `claude` CLI run by posting a `/claude <instruction>` comment on a GitHub issue. See its own README for setup and the exact trigger syntax.

## Reusable building blocks

`docs/capabilities.md` inventories the deterministic "lego blocks" already in the codebase (with where they live, who uses them, and what to group next). All AST parsing/walking/extraction/generation lives in one package, `packages/ast/` (entry `packages/ast/index.mjs`, see its README): `import { extractImports, collectCalls } from './packages/ast/index.mjs'`.
