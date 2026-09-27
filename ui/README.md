# Construct Web UI

A local, click-through web UI over Construct's four capabilities
(create / refactor / research / import), plus a chat-style interface for
the `import --route` guided wizard, and a visual pages/JSX editor. As of
epic #64 (#70-74), `ui/client` is itself a real Construct feature project
(`framework: nextjs`) — it passes `construct validate` the same way any
other project built on Construct does. `ui/server` stays a plain Express
process, untouched: nothing in `src/` or `bin/` behaves differently than
before.

## Layout

```
ui/
  server/   Node.js backend (Express + ws). Imports src/cli.mjs (etc.)
            directly — no subprocess, no shelling out to the `construct`
            binary. Own package.json/node_modules, independent of the
            core project's dependencies.
  client/   Next.js (App Router, TypeScript) frontend, organized as real
            Construct features under features/ (dashboard, settings,
            wizard, help, pages-editor, project-gate) — each a
            domain/service/workflow/hook/component/page/controller slice,
            plus its own architecture.yml (framework: nextjs). Routes
            live under app/ as thin files that import and render each
            feature's controller. Own package.json/node_modules.
  e2e/      Playwright end-to-end tests that drive both of the above in a
            real browser (not curl, not just a build check). Own
            package.json/node_modules, kept separate from client/ since it
            tests the app rather than being part of it.
```

## Why a backend at all (not just calling the CLI from the browser)

The backend is what actually calls Construct's real, exported functions
(`create`, `refactor`, `research`, `importCommand` from `src/cli.mjs`) in
the same process/module graph as this repo — same code, same behavior as
running `construct <command>` from a terminal, just invoked as a function
call instead of a subprocess. The one exception is the import wizard: it's
inherently a multi-turn conversation (a prompt, wait for an answer, another
prompt, …), so it's exposed over a WebSocket instead of a single REST call.

**Why Next.js's own API routes don't replace this backend** (decided on
epic #64): Next.js API routes don't handle a long-lived WebSocket
connection well without a custom server, which would reintroduce exactly
the coupling between the frontend framework and the wizard's transport
that keeping them separate avoids. So the split is: Next.js owns the
frontend, Express keeps owning the wizard's real-time transport and every
REST endpoint, called from the Next.js app exactly like it was called from
the previous Vite app. `ui/client`'s service layer talks to `ui/server`
directly over HTTP/WebSocket (`ui/client/lib/apiBase.ts`,
`NEXT_PUBLIC_API_BASE`/`NEXT_PUBLIC_WS_BASE`, defaulting to
`http://localhost:4000`) rather than through a Next.js rewrite proxy —
`ui/server` already runs with `cors()` enabled for every origin, so no
extra server-side configuration is needed for this.

## Install

From this `ui/` directory (each side has its own `package.json`):

```bash
cd ui/server && npm install
cd ui/client && npm install
```

## Run (two terminals)

```bash
# Terminal 1 — backend, default port 4000
cd ui/server
npm start
# or: npm run dev   (restarts on file changes)

# Terminal 2 — frontend, default port 3000
cd ui/client
npm run dev
```

Open http://localhost:3000. The frontend talks to `http://localhost:4000`
directly for every REST call and the wizard's WebSocket (see "Why a
backend at all" above) — no dev-server proxy involved. Override the
backend's address with `NEXT_PUBLIC_API_BASE=http://host:port` /
`NEXT_PUBLIC_WS_BASE=ws://host:port` if it runs somewhere else (both must
be set before `npm run dev`/`npm run build`, since they're read at build
time via `process.env`). The backend's own port is configurable via `PORT`
(e.g. `PORT=4001 npm start`).

Production build/start:

```bash
cd ui/client
npm run build
npm start   # serves the production build, default port 3000
```

## Workspace: one folder, no project at start — #365

The Cockpit server can only ever open, browse, read, write or run commands in **one workspace
folder**, and it starts with **no project open**.

| Setting | Meaning |
| --- | --- |
| `CONSTRUCT_WORKSPACE_ROOT` | Absolute path of the workspace root, set by DevOps. Created if missing, resolved with `realpath` once at startup. Relative paths and `/` are refused (the server does not start). Default `$HOME/workspace` **only when login is off** (loopback dev): every user then shares that one folder. When login is required (hosted) there is **no default** — it must be set, and the server refuses to start if it is unset or overlaps the Construct checkout or the server's working directory. |
| Per-user directory | With login required, each signed-in user gets `<CONSTRUCT_WORKSPACE_ROOT>/<github-login>` (login lowercased, letters/digits/`-`/`_` only, at most 64 characters; created `0700` on first use, resolved with `realpath`). It is the workspace for that user's requests, so browsing, cloning, opening and running commands are all confined to it; another user's directory is refused with the same `403 OUTSIDE_WORKSPACE` as any outside path. A login that is not one safe path segment gets `403`. |
| `CONSTRUCT_STATE_DIR` | Where process records, bot worktrees and the remembered "last project" live. Server-owned, outside the workspace, never client-addressable. |

- **No project at start.** `GET /api/settings` returns `projectDir: null, noProject: true`. The Cockpit shows one
  **Open a project** screen on every project screen, with a folder picker that starts at (and cannot leave) the
  workspace, workspace-relative breadcrumbs and a hint (`git clone <url> <workspace>/my-project`). The project that
  was open last is offered as **Reopen <name>**; it is never opened automatically. **Close project** and the switcher
  are in the top bar. Layout memory stays per project.
- **Every path is contained by realpath**: a project choice (`POST /api/settings`), the folder browser
  (`GET /api/fs/browse`), and the files `POST /api/import` reads (`from`, `planPath`). `..`, absolute paths elsewhere,
  symlinks that lead out, dangling symlinks, sibling prefixes (`/ws-evil` vs `/ws`), NUL bytes and over-long paths are
  refused (`403 OUTSIDE_WORKSPACE`, `400 BAD_PATH`, `404 NOT_FOUND`). A relative path means workspace-relative, never
  the server's working directory. The open project is re-verified on every request, so a folder later replaced by a
  symlink out of the workspace stops being served (`409 NO_PROJECT`).
- **`409 { code: 'NO_PROJECT' }`** is what every project route (pages, workflows, units, flow, nav, validate, git,
  processes, plan, review, tests, create/refactor/research/import/init) answers with no project open. If the only
  `architecture.yml` is *above* the workspace it is not used: `409 PROJECT_ROOT_OUTSIDE_WORKSPACE` (`init` still works
  and creates a project inside the workspace).
- `browseRoots` is no longer a setting (`POST /api/settings { browseRoots }` is `400 BROWSE_ROOTS_FIXED`); the picker's
  only root is the workspace. `POST /api/settings { closeProject: true }` closes the project.

### Timeouts: no command or model call can hang the Cockpit (#413)

| Setting | Meaning |
| --- | --- |
| `CONSTRUCT_LLM_TIMEOUT_SEC` | Cap on one model call (`claude -p` is killed with SIGKILL; the Ollama request is aborted). The error names the provider, the seconds and this variable. Default 300. Read by core (`src/llm.mjs`), so the CLI's `--llm` honours it too. |
| `CONSTRUCT_COMMAND_TIMEOUT_SEC` | Cap on one interactive command (`/api/create`, `/api/import`, ...). A command still running at the deadline is abandoned: `504 {ok:false, error}`, and the next queued command runs. Default 900. |
| `CONSTRUCT_MAX_CONCURRENT_COMMANDS` | How many interactive commands may run at once across every signed-in user (#569). Commands are queued per login — one user's long `import` never delays another user's `create` — and this cap keeps the whole server from running more than this many at a time; the rest wait in the order they arrived. Default 2 (the two-heavy-jobs budget of a 15 GB machine). |

### Clone a public repository (#330 slice A)

From **Open a project** paste an address such as `https://github.com/octocat/Hello-World`; the repository is copied into
the workspace as a new folder and opened, with `origin` set to that address. The clone is a cancellable job, listed in
the Processes drawer under **Clones**. Settings has **Connect a remote** for a project that is a repository but has no
`origin` (it only ever adds one; it never overwrites, and never pushes).

| Setting | Meaning |
| --- | --- |
| `CONSTRUCT_CLONE_HOSTS` | Comma-separated hosts a clone or remote may name. Default `github.com`; add `gitlab.com,bitbucket.org` to allow them. Only plain hostnames are read. |
| `CONSTRUCT_CLONE_MAX_MB` | Size cap; a clone larger than this is stopped and removed. Default 500. |
| `CONSTRUCT_CLONE_TIMEOUT_SEC` | Time cap; a longer clone is stopped and removed. Default 300. |

REST (below the session gate, foreign-Origin refused): `POST /api/clone {url, name?, depth?}` -> `202 {job}`;
`GET /api/clone`, `GET /api/clone/:id`, `POST /api/clone/:id/cancel`; `GET|POST /api/git/remote {url}`. Only `https://<allowed host>/<owner>/<repo>`
is accepted (no userinfo, port, query or other scheme); the host must resolve to public addresses only; git runs with
protocols locked to https, no credential helper or prompt, no hooks, no redirects, no submodules and a scrubbed
environment, one clone at a time. A private repository takes a one-time `token` (a read-only access token, used once and never stored), or, when
the GitHub connection of docs/DEPLOY.md ("Private repositories with a GitHub login", #638) is set up, `useLogin: true` (never both).
Tests only: `CONSTRUCT_E2E_CLONE_LOCAL_ROOT` lets a `file://` URL under one directory be cloned; the server refuses to
start with it on a non-loopback host.

Clone needs **git 2.37.0 or newer** (#423): older versions silently ignore `http.curloptResolve`, the setting that pins
git to the addresses that were just checked to be public, so the protection against DNS rebinding would be off without
a word. On an older or missing git, `POST /api/clone` answers `503 {code: 'GIT_TOO_OLD' | 'GIT_MISSING'}` and the rest of
the Cockpit works as before; the startup log and `/api/health` say so.

`GET /api/health` (public, no session) answers `{ok:true, degraded, node, git:{ok, version, minimum, cloneEnabled, reason?},
workspace:{writable, freeBytes, low}, stateDir:{writable, freeBytes, low}, thresholds:{minFreeBytes}, warnings:[...], checkedAt}`.
`ok` is always `true` when the server answers (liveness, unchanged for existing probes); `degraded` is `true` when any
check failed. Writability is a real 1-byte write in each directory; `low` compares free space with
`CONSTRUCT_HEALTH_MIN_FREE_MB` (default 500). No filesystem path is in the document. Results are cached for 10 seconds.
The same facts are logged at startup as `Preflight:` lines (those may name paths: the log is local). A save that hits a
full disk fails with a clear "No space left on device" error and leaves the previous record intact.

A clone never outlives the server (#422): when the server exits or is stopped by a signal, every running clone's
process group is killed. While a clone runs, a hidden marker `<workspace>/.construct-clone-<name>.json` sits beside the
destination and is removed on every outcome; at the next start the server recovers what a crashed server left — stops
the orphaned `git` if it is still running, removes the partial folder (only one that carries a marker, only directly
under the workspace, never through a symlink) — and logs a `Clone recovery:` line per folder, so cloning the same
repository again just works. A folder without a marker is never removed.

Hosted example (see `tools/dev/run-hosted.sh`):

```bash
mkdir -p /srv/construct/workspace
CONSTRUCT_WORKSPACE_ROOT=/srv/construct/workspace PUBLIC_HOST=cockpit.example.com \
  CONSTRUCT_GITHUB_CLIENT_ID=... CONSTRUCT_GITHUB_CLIENT_SECRET=... CONSTRUCT_ALLOWED_LOGINS=you \
  tools/dev/run-hosted.sh
git clone https://github.com/you/shop /srv/construct/workspace/shop   # then pick "shop" in the Cockpit
```

**Test harness only:** `CONSTRUCT_E2E_PROJECT_DIR` preloads a project. It goes through the same containment as any client
choice and the server **refuses to start** with it on a non-loopback host. The ordinary e2e configs set the workspace to
the OS temp dir (their fixtures are `mkdtemp` directories) and preload one initialised project;
`playwright.workspace.config.js` runs a narrow workspace with nothing preloaded and attacks the boundary
(`tests/workspace.spec.js`), and also runs `tests/project-gate.spec.js` and `tests/new-project.spec.js` (#445);
`playwright.directory-picker.config.js` runs the picker spec against the same harness.

Known limits: files *inside* a project are guarded by each route's own project-relative checks (a symlink inside a
project that points out of the workspace is followed by the CLI commands that generate into it); a project whose git
top level is above the workspace (a workspace nested in another repository) is the operator's set-up choice.

## Authentication (GitHub login) — #278

`ui/server` runs Construct CLI commands, browses the filesystem and reads
and writes source files under the project directory the user opens (confined to the workspace above, #365).
Unauthenticated plus reachable from another machine equals remote code
execution, so the server is deliberately hard to get into that state:

- **Default (nothing configured)**: binds `127.0.0.1`, no login required,
  exactly as before. A loud `Authentication is OFF` banner at startup.
  This is the local-development posture; a cookie does not defend against
  "an attacker already on your machine, as you".
- **`HOST` set to anything non-loopback**: the process **refuses to start**
  unless a GitHub login is configured. Exposure without authentication is
  unreachable rather than merely warned about.
- **OAuth configured**: login required, always, loopback or not.

### Setting up GitHub login

1. Register an OAuth app at <https://github.com/settings/developers> →
   *New OAuth App*. Set **Authorization callback URL** to
   `http://localhost:4000/auth/callback` (or your real host/port — it must
   match `CONSTRUCT_OAUTH_CALLBACK_URL` exactly).
2. Generate a session secret: `openssl rand -hex 32`.
3. Start the server with the environment set. Never commit these; never
   write them into the repo.

```bash
cd ui/server
CONSTRUCT_GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx \
CONSTRUCT_GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
CONSTRUCT_ALLOWED_LOGINS=your-github-login \
CONSTRUCT_SESSION_SECRET=$(openssl rand -hex 32) \
npm start
```

| Variable | Meaning |
|---|---|
| `CONSTRUCT_GITHUB_CLIENT_ID` / `_SECRET` | the OAuth app. Setting one without the other refuses to start. |
| `CONSTRUCT_ALLOWED_LOGINS` | comma- or space-separated GitHub logins, case-insensitive. **Required** whenever OAuth is configured — without it, "login with GitHub" would mean every GitHub account on earth. Anyone else authenticates with GitHub successfully and is still refused with `403`. |
| `CONSTRUCT_SESSION_SECRET` | signs the session cookie, ≥16 chars. If unset, one is generated once and persisted at `<stateDir>/session-secret` (mode 0600; refused if anyone else can read it), so sessions survive a restart from the same state directory — set this explicitly for full control over rotation (#418). |
| `CONSTRUCT_SESSION_TTL_HOURS` | session lifetime, default `8`. Rolling: re-issued once past half its life. |
| `CONSTRUCT_OAUTH_CALLBACK_URL` | defaults to `http://localhost:<PORT>/auth/callback`. Must match the OAuth app exactly. |
| `CONSTRUCT_AUTH` | `required` forces the gate on with no OAuth app; `off` disables it, and is honoured **only** on loopback. |
| `CONSTRUCT_AUTH_TEST_USER` | the e2e escape hatch — see below. |

### Endpoints

`/auth/*` sits outside `/api`, and therefore outside the gate: you cannot
log in through a door that requires being logged in.

| Route | Purpose |
|---|---|
| `GET /auth/session` | public. `{authRequired, authenticated, user, githubConfigured, loginPath, testLogin, testLoginUser}` |
| `GET /auth/login` | sets a signed, single-use, 10-minute state cookie and redirects to GitHub |
| `GET /auth/callback` | checks state, exchanges the code, identifies the user, applies the allowlist, sets the session cookie |
| `POST /auth/logout` | clears the session |
| `POST /auth/test-login` | only when `CONSTRUCT_AUTH_TEST_USER` is set; otherwise `404` |

Everything under `/api/*` answers `401` without a session, and the
`/ws/wizard` upgrade is refused at the handshake. The single exception is
`GET /api/health`, which returns `{ok:true}` and nothing else so liveness
probes and Playwright's `webServer` block work before a session exists.
It is registered *above* the middleware, so it is the only public `/api`
route by construction. **Add new routes below the gate comment in
`index.mjs`.**

### The e2e test login

The end-to-end suite cannot do a real OAuth round trip, so
`CONSTRUCT_AUTH_TEST_USER=<login>` enables `POST /auth/test-login`, which
mints an **ordinary signed session cookie** for that login. It is a login,
not a bypass: it does not touch `requireSession`, and there is no code path
where "an env var is set" substitutes for "this request carries a valid
signed session". Four independent things must hold:

1. the variable is set (otherwise the route `404`s);
2. `NODE_ENV` is not `production` (case-insensitively) — otherwise the
   process **refuses to start**;
3. the server is bound to loopback — otherwise, likewise;
4. the request carries the Cockpit's own `Origin` (fail-closed: no
   `Origin` at all is also refused), and the login passes the allowlist if
   one is configured.

It is used only by `ui/e2e/playwright.auth.config.js`, so the rest of the
suite keeps running in the ordinary unauthenticated-loopback posture:

```bash
cd ui/e2e
E2E_CLIENT_PORT=3051 E2E_SERVER_PORT=4051 npx playwright test -c playwright.auth.config.js
```

### Running the whole e2e suite

The default config runs almost everything; three specs need a server or a login of their own and run under their
own configs. Run all four for the full picture. Wrap heavy runs in `tools/dev/heavy.sh` (this box is 15 GB with no
swap), keep `--workers=1`, and use distinct ports so parallel runs never share a server.

`heavy.sh` (#414) takes one machine-wide lock with a bounded wait (`CONSTRUCT_HEAVY_LOCK_WAIT_SEC`, default 3600; on
giving up it prints who holds it and exits 75), waits for free RAM with the lock released between checks and a bound of
its own (`CONSTRUCT_HEAVY_RAM_WAIT_SEC`, default 1800), and afterwards prunes `/tmp/construct-*` directories **whose
owner pid is gone** (the pid is in every directory name Construct creates, or in a `.owner` file) — never by age
alone, so a run longer than 30 minutes no longer loses its state to another session's sweep. `tools/dev/heavy.sh
--prune-only` runs just the sweep; `node --test tools/dev/test/` runs its tests.

```bash
cd ui/e2e
export WATCHPACK_POLLING=true CHOKIDAR_USEPOLLING=1   # fs.inotify.max_user_instances can be as low as 128
../../tools/dev/heavy.sh npx playwright test --workers=1                                # the default config
../../tools/dev/heavy.sh npx playwright test -c playwright.auth.config.js               # login gate, and the account chip half of popover-dismiss
../../tools/dev/heavy.sh npx playwright test -c playwright.processes.config.js          # Processes drawer (fake step executor)
../../tools/dev/heavy.sh npx playwright test -c playwright.processes-approval.config.js # approve/reject (seeds a finished process)
../../tools/dev/heavy.sh npx playwright test -c playwright.workspace.config.js          # workspace boundary + "Open a project" (#365)
../../tools/dev/heavy.sh npx playwright test -c playwright.directory-picker.config.js   # folder picker inside a narrow workspace
../../tools/dev/heavy.sh npx playwright test -c playwright.clone.config.js              # clone a repository, connect a remote (#330)
../../tools/dev/heavy.sh npx playwright test -c playwright.github-repo.config.js        # connect GitHub, clone a private repo with the login (#638; a mock GitHub, ports 49210-49212)
```

`a11y.spec.js` and `tests-tab.spec.js` import `@axe-core/playwright`, a declared devDependency: run `npm install` in
`ui/e2e` once before running them, or they fail at import.

### Deploying client and server apart

The session cookie is `SameSite=Lax`, so it travels between `:3000` and
`:4000` only because they are the same *site* (`localhost`; ports do not
count). If you ever serve the Cockpit from a different domain than the
API, `Lax` will drop the cookie on both `fetch` and the WebSocket — put
both behind one origin, or change the cookie policy deliberately rather
than discovering it as a bug.

## Commit on save (#283)

Every save in the Cockpit makes a real git commit, on a branch the session
creates, with a message Construct builds itself — impact counts from
`analyzeImpact` (#288), prose from `summarizeUnit`. No model is involved,
so a commit costs no tokens, is byte-identical for the same tree, and works
with the network and the provider both down.

**Full reference: [`docs/commit-on-save.md`](../docs/commit-on-save.md).**
The deterministic half is core (`src/engine/commitMessage.mjs`, open
source); the trigger and the UI are here (`ui/server/src/autoCommit.mjs`,
`ui/client/features/git-session/`).

```
CON-a3f7-0007: checkout: update ProductsPage and CheckoutController

2 features, 5 layers, 7 files
  checkout: page, controller, hook
  billing:  domain, service
...
Construct-Session: a3f7
Construct-Serial: 7
```

- `<prefix>` is yours (may be empty); the session id and the serial are
  ours. The serial is monotonic **within the branch**, read from that
  branch's own commit subjects — no counter file, so parallel sessions have
  nothing to race on.
- The branch is `<prefix>/<slug>-<id><suffix>` (e.g.
  `cockpit/billing-invoice-a3f7`), created on the **first save** and never
  renamed afterwards.
- Three modes, all switchable in Settings: `coalesce` (default, 30s
  window), `every-save`, `manual`. Auto-commit is on by default and the off
  switch is real.
- A dirty working tree at session start is **asked** about — carry or
  stash — with the changed files grouped by feature and layer. Carried
  files are committed but never counted in the impact block.
- Nothing is pushed, only the files the Cockpit wrote are staged
  (`git add -- <paths>`, never `-A`), and a commit that cannot be made
  never fails the save.

Configure it on the Settings screen, or over REST:

| Route | Purpose |
|---|---|
| `GET /api/git/session` | config, repo/branch, pending saves, window countdown, the dirty-tree question, recent commits |
| `POST /api/git/config` | `{enabled, mode, coalesceMs, messagePrefix, branchPrefix, branchSuffix}` |
| `POST /api/git/dirty-answer` | `{answer: 'carry'\|'stash', remember}` |
| `POST /api/git/commit` | commit what is pending now |
| `POST /api/git/plan` | `{plan, planTitle}` — name the branch after the work |

Pages-editor saves and committed workflow edits also return an
`autoCommit` block alongside their usual response.

**Git plumbing** is `ui/server/src/git.mjs` — `execFile` with argument
arrays, never a shell string, commit message on stdin. It is deliberately
narrow so #296 can replace its body with `simple-git` or `isomorphic-git`
without anything else moving.

## Storybook

`ui/client` has Storybook configured (`ui/client/.storybook/main.js` +
`preview.js`, framework `@storybook/nextjs`, reusing the same Next.js/
webpack setup as the real app) so components can be developed and
visually reviewed in isolation, one story per component. `preview.js`
imports the app's real `app/globals.css`, so every story renders against
the actual black/grey glassmorphism theme tokens (see "Theme" below), not
an unstyled default canvas.

```bash
cd ui/client
npm run storybook          # dev server, default port 6006
npm run build-storybook    # static build to ui/client/storybook-static/
```

Every component in `ui/client/components/ui/` (see "Theme and reusable
components" below) has a co-located `<Name>.stories.jsx`. Kept
deliberately minimal: only `@storybook/addon-docs` beyond the framework
itself — the default `storybook init` also offers
`@storybook/addon-vitest`'s browser-mode Vitest+Playwright integration,
`@storybook/addon-a11y`, `@chromatic-com/storybook`, and
`@storybook/addon-mcp`; all four are left out as unnecessary scope — this
repo's real regression guard for the rendered app is the separate
Playwright suite in `ui/e2e` (see below), and duplicating that stack
behind a Storybook addon would add dependencies without adding coverage.

## Theme

`ui/client/app/tokens.css` defines the whole visual language as CSS custom
properties, mapped per theme on `<html data-theme="dark|light">`. Dark is the
default (and also applies when no attribute is set); the light theme keeps the
same hue family with deeper values so text stays readable on light surfaces.
The top-bar switch (or "Toggle dark" in the command palette) changes theme and
the choice is remembered in the browser. Components use the semantic tokens
(`--surface-*`, `--text`, `--muted`, `--accent`, `--tool`, `--llm`, `--error`);
older names such as `--bg`, `--border` and `--panel-glass` remain as aliases,
and the shared `.glass-panel` class documents the background/border/blur recipe
once. Token rules live in `docs/design/tokens.md`.

## Reusable UI components

`ui/client/components/ui/` holds the themed, reusable functional
components every feature builds its forms/panels out of, instead of each
page hand-rolling its own `<button>`/`<select>`/`<div className="...">`
markup. These are deliberately still plain `.jsx` (not rewritten to
`.tsx`) per #71's "reuse as-is" instruction — real prop types for the
TypeScript feature code that consumes them come from hand-authored,
colocated `.d.ts` files (`components/ui/index.d.ts`,
`components/AttributionBadge.d.ts`, `components/CommandResult.d.ts`)
rather than converting the implementations themselves:

- **Button** — every button in the app (`variant="primary"`, the default;
  `variant="ghost"` exists as a themed lower-emphasis option, not yet used
  by any page).
- **GlassPanel** — the `.glass-panel` surface as a component. Takes an
  `as` prop for the rendered tag (`form`, `nav`, `div`, …) and a
  `className` that's *appended* rather than replaced, since several call
  sites still need their own layout-only class alongside the shared glass
  treatment (e.g. `<GlassPanel as="form" className="command-form">` — the
  exact class ui/e2e's Playwright suite locates the Create form by).
- **Field** — the label/hint wrapper around a form control.
- **Input** / **Select** — thin, themed passthroughs to real
  `<input>`/`<select>` elements (deliberately trivial: Playwright's
  `getByPlaceholder`, native `<select>` interaction, etc. all keep working
  unchanged since the underlying DOM node is untouched).
- **Badge** — the tool/llm/llm-none/error status label.

`components/AttributionBadge.jsx` and `components/CommandResult.jsx` are
similarly shared, non-feature presentation components (used by the
dashboard, wizard, and help features) — not part of any one feature slice,
same reasoning as `components/ui/`.

Every one of the `components/ui/` primitives has a Storybook story (see
above) rendered on the real theme. The full e2e suite was re-run after the
Next.js migration to confirm no visual/behavioral regression (see "What
was verified" below).

## Construct feature layout (client)

`ui/client`'s own `architecture.yml` sets `project.framework: nextjs` —
the same target every other Construct project defaults to. Its features:

- **project-gate** — blocks a route behind a project-init screen until the
  selected directory resolves to a real Construct project. Not routed on
  its own; `dashboard`/`wizard`/`pages-editor`'s controllers wrap their
  content with `ProjectGateController` (imported from project-gate's
  public API), a real, `SLICE-002`-checked cross-feature dependency.
- **dashboard** — the four command forms (create/refactor/research/import).
- **settings** — project directory + LLM provider form. Not gated (it's
  how you fix an invalid project).
- **wizard** — the import route wizard as a chat, over `ui/server`'s
  `/ws/wizard`. Gated.
- **help** — CLI reference (fetched live from `GET /api/help`) plus static
  guides. Not gated.
- **pages-editor** — epic #48's pages browser / JSX tree / structural
  preview / snippet editor / props inspector / auto-map / prop-flow
  diagram. Gated. (Not explicitly named in #71's body, but migrated on the
  same footing as the other four — #73 requires its e2e scenario to keep
  passing, and CLAUDE.md forbids breaking working, tested UI code.)

Routes under `app/` are thin: each `app/<route>/page.tsx` imports its
feature's controller directly from `features/<name>/controllers/` (not
through the feature's barrel `index.ts` — `ROUTE-001` checks for a literal
`controllers/` substring in the route file's own import path) and renders
it. `app/page.tsx` (root) and `app/dashboard/page.tsx` both render
`DashboardController`, matching "/ is the Dashboard" from before this
migration while adding the canonical `/dashboard` route.

Run `construct validate` from inside `ui/client` to check it yourself:

```bash
cd ui/client
node ../../bin/construct.mjs validate
# ✓ Construct validation passed
```

## End-to-end tests (Playwright)

`ui/e2e/` drives the real, rendered app in an actual browser (Chromium) —
navigating pages, clicking buttons, filling forms, and asserting on what's
actually painted (including computed CSS visibility, not just DOM
presence). This is the one layer of verification the two dev-server
sections above don't cover: `npm run build` only checks the code compiles,
and `curl` against `/api/*` only checks the backend, neither of which ever
loads a page.

Install (one-time):

```bash
cd ui/e2e
npm install
npx playwright install chromium   # downloads the Chromium browser binary
```

Run:

```bash
cd ui/e2e
npm test           # headless — starts both dev servers automatically, runs all tests, tears them down after
npm run test:headed   # same, but with a visible browser window
npm run test:smoke    # just the trivial "does the harness even work" smoke test
```

You do **not** need to start `ui/server`/`ui/client` yourself first —
`ui/e2e/playwright.config.js`'s `webServer` option starts `npm start` in
`ui/server` and `npm run dev` in `ui/client` (Next.js, port 3000 — moved
from Vite's 5173 in #73) before the first test and stops them after the
run.

### Ports and concurrent runs (#140)

Several people/agents can share one machine, so the suite never attaches to
servers it didn't start by default:

| Env var | Default | Effect |
|---|---|---|
| `E2E_CLIENT_PORT` | `3000` | Port for `next dev` (Playwright `baseURL`) |
| `E2E_SERVER_PORT` | `4000` | Port for `ui/server` (`PORT`); specs read it as `E2E_API_BASE` |
| `E2E_REUSE_SERVERS` | off | Set `1` to reuse servers already running on those ports (local debugging only) |
| `E2E_DEVSERVER_PORT_BASE` | `E2E_SERVER_PORT` + 1000 | First port the Cockpit's "Start dev server" tries for a fixture app (#378); passed to the server as `CONSTRUCT_DEV_SERVER_PORT_BASE` |

The config passes `UI_CLIENT_ORIGIN` (server CORS/WebSocket origin
restriction) and `NEXT_PUBLIC_API_BASE`/`NEXT_PUBLIC_WS_BASE` (client to
server) automatically, so a non-default pair just works:

```bash
E2E_CLIENT_PORT=3104 E2E_SERVER_PORT=4104 npx playwright test
```

If a port is already taken and `E2E_REUSE_SERVERS` isn't set, the run fails
loudly instead of silently talking to someone else's server. Limitation: two
suites in the *same checkout* share `ui/client/.next`, so a cold-start
compile can race; use a different checkout/worktree per concurrent run.
Don't write per-run copies of `playwright.config.js` any more — use the env
vars.

`tests/smoke.spec.js` is a minimal "did the harness even work" check
(loads `/`, asserts the Dashboard or ProjectGate heading renders, no
console/page errors). `tests/walkthrough.spec.js` is the fuller pass: it
points the backend at a fresh empty temp directory, walks through the
ProjectGate → init → Dashboard (create a feature, check the tool/LLM
attribution badges render with a non-zero, visible computed style) →
Settings → Import Wizard (a scripted session that fails fast at local
route-resolution, so it never needs to shell out to the `claude` CLI) →
Help → Pages Editor flow, taking one screenshot per step into
`ui/e2e/screenshots/`. `tests/pages-editor-editing.spec.js` covers the
save/edit/enforcement round trips (#52-#56) the walkthrough stops short
of. All 13 tests currently pass.

Both dev servers' console/page errors are captured live during every test
(`page.on('console', ...)`/`page.on('pageerror', ...)`) and printed at the
end of the run if any showed up, rather than being silently ignored.

## Using it

0. **The Cockpit frame.** Every screen sits in one shell: a **Browser** pane on
   the left (a screen's own tabs first, then **Screens**, the list of every
   screen), the **stage** in the middle, and a **Tools** panel on the right.
   The top bar carries the project switcher, the Explore / Research / Build
   modes, the search box (`Ctrl K`, or `Cmd K`, opens the command palette),
   the local-model status and the light/dark switch. `Ctrl J` opens the bottom
   drawer (Diagnostics from `construct validate`, Logs, Processes); `Ctrl B`
   and `Ctrl Alt B` show or hide the Browser and Tools panes. Below 900 px
   wide only one pane shows at a time, switched from a bottom bar. A guided
   walkthrough with screenshots lives in `docs/demos/cockpit/`.
1. **Pick your project once.** Each gated route (Dashboard, Wizard, Pages
   Editor) fetches project status (`GET /api/settings`) independently on
   mount via project-gate's `useProjectGate` hook: if the selected project
   directory doesn't resolve to a Construct project (`valid: false` /
   `needsInit: true`), it shows a "No Construct project here yet" screen
   with an **Initialize Construct here** button (calls `POST /api/init`,
   i.e. the real `construct init`) instead of rendering. Settings and Help
   stay reachable either way, since Settings is how you fix it.
2. **Settings** — set the LLM provider for each capability (import fill,
   create fill, plan analysis; sourced live from `src/llm.mjs`'s `PROVIDERS`
   map, and a local model is never allowed for plan analysis) and the project directory
   every command targets (passed as `--dir` to the underlying functions,
   exactly like the CLI's `--dir`). Nothing is persisted to disk;
   restarting the backend resets to its defaults (project directory
   defaults to wherever the backend process was started from).
3. **Dashboard** — forms for `create` (feature / vertical slice / single
   layer), `refactor` (move / rename), `research` (summarize / doctor), and
   a non-interactive `import` (single unit or an approved plan file). Each
   result panel shows the command's deterministic output, and — separately
   — the `[tool: ...] [llm: ...]` attribution line every one of these
   commands ends with in the CLI (`printAttribution` in `src/cli.mjs`), so
   it's never collapsed into a generic success toast.
4. **Import Wizard** — the guided, whole-route import as a chat. Optionally
   seed it with a route, click "Start wizard session", and answer its
   questions as they arrive. Progress lines stream in as their own chat
   bubbles the instant they happen (not batched at the end); its one LLM
   call (route analysis) is shown as a distinct attribution bubble, same
   split as everywhere else. Only one wizard session may run at a time per
   backend process (see "Limitations" below).
5. **Pages Editor** — epic #48: browse a feature's `pages/` layer, view a
   page's JSX as a tree, frame your running app and click an element to jump
   to its code, see which values flow into a component (Scope tab), read the
   whole file with type errors marked (Source tab), see what changed on disk
   outside the editor (Diff tab), select a node from either the tree or the
   structural preview (bidirectional), edit its isolated snippet or props
   and save straight back into the source file, auto-map unwired props,
   and see the whole tree's prop flow as a colored diagram. Every save is
   scoped to `pages/` and checked against the PAGE-*/COMPONENT-*
   architecture rules before it lands — a rejected save (e.g. a `fetch()`
   call added to a page) never touches disk.
6. **Workflows** — pick a workflow file to see its diagram; the Narrative tab
   explains it in plain English with every scenario and a health check, and
   the Edit and Context & actions tabs change it (each edit is previewed as a
   diff, then written, and the English follows).
7. **Help** — documents both the CLI and this UI: a getting-started
   tutorial, an explanation of the tool/LLM attribution badges, a guide to
   every screen, and a full CLI reference. The CLI reference section is
   fetched from `GET /api/help` (read-only), which returns text imported
   directly from `src/usage.mjs` and `src/repl.mjs`'s
   `HELP_TOPICS`/`TOPIC_ORDER`/`getTopLevelHelpText()` — the same strings
   `construct` and `construct repl`'s `help` actually print — rather than a
   hand-copied duplicate that could drift from the real CLI.

## Endpoints (for reference)

REST (`ui/server/src/index.mjs`), all `POST` except settings' `GET`:

- `GET /api/help` — `{ usage, topLevelHelp, topics: string[], helpTopics: Record<string,string> }`,
  all sourced live from `src/usage.mjs` and `src/repl.mjs` (read-only, no side effects)
- `GET|POST /api/settings` — `{ projectDir?, closeProject?, llmProvider? }` in (POST only; GET takes
  nothing); both return `{ projectDir (null until one is opened, #365), noProject, workspaceRoot, lastProject,
  llmProvider, availableProviders, resolvedProjectRoot, valid, needsInit }`. `projectDir` must be inside the workspace
  (see "Workspace" above). `resolvedProjectRoot` is
  `findProjectRoot(projectDir)` (src/config.mjs) — the exact upward search
  `getRoot` in src/cli.mjs uses to resolve every command's root, so `valid`
  here means exactly what it means when a command actually runs (a
  subdirectory of an existing project counts; an arbitrary directory with no
  `architecture.yml` above it doesn't). `needsInit` is `!valid`.
- `POST /api/init` — no body; runs `init` (from `src/cli.mjs`, same as
  `construct init`) against the *currently selected* project directory.
  Responds `{ ok, output, attribution, error?, ...settings-shape above }` —
  same envelope as the command endpoints below, plus the refreshed
  project-status fields so the frontend can update in one round trip.
- `POST /api/create` — `{ kind: 'feature'|'layer'|'single', name, feature?, layer?, layers? }`
- `POST /api/refactor` — `{ action: 'move'|'rename', name, newName?, feature, from?, to?, layer? }`
- `POST /api/research` — `{ action: 'summarize'|'doctor', feature?, format?, since? }`
- `POST /api/import` — `{ mode: 'unit'|'plan', name?, feature?, layers?, from?, planPath?, llm? }`
- `GET /api/pages/features`, `GET /api/pages`, `GET /api/pages/tree`,
  `GET|POST /api/pages/node`, `GET|POST /api/pages/props`,
  `GET /api/pages/unmapped`, `POST /api/pages/automap` — the pages-editor
  endpoints (see `ui/server/src/pagesEditor.mjs`), each scoped
  server-side to `features/<feature>/pages/`.

- `GET /api/dev-server`, `POST /api/dev-server/start|restart|stop` (#378) — the open project's dev server as a
  managed process (`ui/server/src/devServer.mjs`). `start` runs the project's own `scripts.dev` (else `scripts.start`)
  as `npm run <script>`, never a different command and only on this explicit POST; `{ port? }` picks a port ("Use port
  N"). The status is `{ state: 'not-running'|'starting'|'running'|'failed', refusal, command, url, port, failure,
  branch, branchKind: 'session'|'other'|null }`. It refuses a project whose root is outside the workspace
  (`PROJECT_ROOT_OUTSIDE_WORKSPACE`) or with no script (`NO_DEV_SCRIPT`), runs with an allowlisted environment (plus
  `PORT`/`HOST`), streams its output to the Logs tab, and stops on Close project, Sign out and server exit. The first
  port tried is `CONSTRUCT_DEV_SERVER_PORT_BASE` (default 5173; never 80, 443, 3000 or 4000). The dev server runs in
  the project's own working tree, so on a Cockpit session branch (`cockpit/...`) it sees exactly the files Cockpit
  saves; `branchKind` only reports which kind of branch is checked out.

Every command endpoint responds `{ ok, output: string[], attribution: {tool, llm} | null, error? }`.

WebSocket: `/ws/wizard` —
`{ type: 'start', seedRoute? }` / `{ type: 'answer', text }` from the
client; `{ type: 'log'|'question'|'done', text?, kind? }` from the server.

## What was verified

- `npm test` in the repo root: 304/304 passing, both before and after the
  Next.js migration (`ui/` isn't exercised by this suite; nothing in
  `src/`/`bin/` changed).
- `ui/client`: `npm run build` (Next.js production build) compiles,
  type-checks, and statically generates all 6 routes with no errors;
  `npm run dev` starts cleanly and serves the app on port 3000.
  `node ../../bin/construct.mjs validate` reports zero errors and zero
  warnings.
- `ui/e2e`'s full Playwright suite (13 tests) passes against the migrated
  stack — re-run after every structural change during the migration, not
  just once at the end. Fresh screenshots captured for every scenario.
- Storybook (`npx storybook build`) still builds successfully against all
  7 existing component stories after switching its framework from
  `@storybook/react-vite` to `@storybook/nextjs`.

## Known limitations / follow-ups

- **No auth.** This is a local dev tool wrapping filesystem-mutating
  commands; it's assumed to run on localhost for one trusted user. Add
  auth before exposing it beyond that.
- **One wizard session at a time per backend process.** The event-driven
  wizard adapter (`runImportRouteWizardEventDriven` in `src/cli.mjs`)
  patches `console.log`/`warn`/`error` for the duration of a run, which is
  process-global — a second concurrent session would interleave the first
  one's captured output. The backend rejects a second `start` while one is
  already active.
- **Settings aren't persisted** — by design, to keep this additive and
  simple; restarting the backend resets the project directory/LLM provider
  to their defaults.
- **The wizard's project directory is applied via `process.chdir()`** at
  session start (it has no `--dir` flag of its own), which is also
  process-global. Combined with the one-session-at-a-time constraint
  above, this is safe today but worth keeping in mind if this ever grows
  into a multi-project, multi-session tool.
- **Each gated route fetches its own project status independently**
  rather than sharing one app-wide store (the pre-migration Vite app had a
  single top-level `App` component that fetched once and passed it down;
  Next.js's App Router has no equivalent single top-level client
  component across routes without introducing a context provider in
  `layout.tsx`). Functionally equivalent, but means switching projects on
  Settings and then navigating to an already-open Dashboard tab needs a
  fresh navigation/reload to pick up the change, rather than updating in
  place — a `layout.tsx`-level context provider would be the natural next
  step if that matters in practice.
- **DRY-001 warnings**: `construct validate` currently reports zero
  warnings, but a handful of structurally-similar small workflow reducers
  across features (e.g. dashboard's per-form visibility helpers) are
  intentionally not further unified into one shared generic — each is a
  one-line pure function and unifying them would trade a warning-severity
  heuristic for a genuine abstraction few readers would want.
