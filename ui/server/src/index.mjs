// Construct UI backend — a small Express server that calls the core CLI's
// exported functions (create/refactor/research/importCommand from
// src/cli.mjs) directly, in-process. It never shells out to the `construct`
// binary: this is the same Node project, same module graph, so the real
// functions are imported and called exactly as bin/construct.mjs does.
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { AuthConfigError, createAuth, isLoopbackHost, resolveAuthConfig } from './auth.mjs';
import { create, refactor, research, importCommand, init } from '../../../packages/core/cli.mjs';
import { containedProjectRoot, requireProject, NO_PROJECT_BODY } from './projectGuard.mjs';
import { WorkspaceError, baseWorkspaceRoot, containInWorkspace, contain, userWorkspaceMiddleware, workspaceRoot } from './workspace.mjs';
import { USAGE } from '../../../packages/core/usage.mjs';
import { HELP_TOPICS, TOPIC_ORDER, getTopLevelHelpText } from '../../../packages/core/repl.mjs';
import { listProjectTree } from './projectTree.mjs';
import { getSettings, updateSettings, getBrowseRoots, getProjectDir, preloadProject } from './settings.mjs';
import { handleBrowse } from './dirBrowse.mjs';
import { runCapturing, withDir } from './commandRunner.mjs';
import { attachWizardSocket } from './wizardSocket.mjs';
import { createProcessesService } from './processesService.mjs';
import { createProcessesRouter } from './processesApi.mjs';
import { createDevServerService } from './devServer.mjs';
import { createDevServerRouter } from './devServerApi.mjs';
import { isSessionBranch } from '../../../packages/engine/commitMessage.mjs';
import { createPlanService } from './planService.mjs';
import { createPlanRouter } from './planApi.mjs';
import { createRequirementRouter } from './requirementApi.mjs';
import { attachProcessesSocket } from './processesSocket.mjs';
import { createReviewRouter } from './reviewApi.mjs';
import { createTestsRouter } from './testsApi.mjs';
import { createCloneJobs, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from './cloneJobs.mjs';
import { createHealth } from './health.mjs';
import { createDevActivity, createDevStatusRouter } from './devActivity.mjs';
import { resolveStateDir } from '../../../packages/engine/processStore.mjs';
import { createCloneRouter, createRemoteRouter } from './cloneApi.mjs';
import { resolveHarnessSeams } from './testSeams.mjs';
import { createRepoConnections, resolveRepoConnectionConfig, sessionKeyOf } from './repoConnection.mjs';
import { createGithubRouter, mountRepoAuthRoutes } from './githubRepoApi.mjs';
import { createNewProjectRouter } from './newProjectApi.mjs';
import { resolveCloneHosts } from './gitUrl.mjs';
import { createReviewJobs } from './reviewJobs.mjs';
import { createReviewExecutor, createAnalyses } from './reviewAnalyses.mjs';
import { createPlanSource } from './reviewPlans.mjs';
import { createTestRunExecutor, createTestRuns, createTestRunJobs } from './testRuns.mjs';
import { refuseUnknownUpgrades } from './wsUpgrade.mjs';
import { getOllamaStatus, listOllamaModels, startOllamaPull, removeOllamaModel } from './ollama.mjs';
import {
  PagesEditorError,
  listFeatures,
  listPages,
  listAllPages,
  resolvePageFile,
  serializeTree,
  getNodeSnippet,
  patchNode,
  assertContentHash,
  getNodeProps,
  buildAttributeSnippet,
  findUnmappedProps,
  getScopeLinks,
  applyAutoMap,
  buildPaletteInsertion,
  buildWrapSuggestion,
  applyWrapConfirm,
  checkEnforcement,
  parseSnippetToTree,
  rewireWireInSnippet,
  removeNodeInSnippet,
  moveNodeInSnippet,
  addChildInSnippet,
} from './pagesEditor.mjs';
import { handleValidateForProject } from './validateApi.mjs';
import { handleResearch } from './researchApi.mjs';
import { handleCreate, handleRefactor, handleImport } from './writeVerbsApi.mjs';
import { validateArchitecture } from '../../../packages/core/architecture-enforcer.mjs';
import { createComponentsRouter } from './componentsApi.mjs';
import { createNotesRouter } from './notesApi.mjs';
import { openNotesStore } from './notesStore.mjs';
import { createBlocksRouter } from './blocksApi.mjs';
import { openBlockSettingsStore } from './blockSettingsStore.mjs';
import { handleLogs } from './logBuffer.mjs';
import { unitsIndex, unitSummary, featuresIndex, featureSummary } from './unitsApi.mjs';
import { buildPalette } from '../../../packages/engine/palette.mjs';
import { readPageSource } from './pageSource.mjs';
import { viewPage, openReference, openSourceLocation, viewProjectFile } from './projectNav.mjs';
import { featureFlow, flowFilePaths } from './flowApi.mjs';
import { describePageChange, adoptOwnWrite, pageChangeTracker } from './pageChanges.mjs';
import { listWorkflowFeatures, listWorkflowFiles, readWorkflowMachines, readWorkflowNarrative, editWorkflowFile } from './workflowsViewer.mjs';
import {
  AutoCommitError, answerDirtyPrompt, flushSession, getSessionStatus,
  recordSave, setSessionPlan, updateCommitConfig,
} from './autoCommit.mjs';

// This server is a local dev tool, but it has real teeth: /api/import (and
// friends) read an arbitrary path off disk and, with --llm, send that
// content to an external LLM provider — a fully open CORS policy would let
// any web page a developer happens to have open in another tab drive that
// from their own browser, with no consent step ("drive-by localhost").
// Restricting to the actual client origin (configurable, since the client
// dev server's port is the one thing that might legitimately change) closes
// that off: the browser's CORS preflight rejects the cross-origin request
// before it ever reaches a route handler.
export const CLIENT_ORIGIN = process.env.UI_CLIENT_ORIGIN || 'http://localhost:3000';

const port = Number(process.env.PORT) || 4000;
// Bind loopback unless HOST says otherwise (#277). This server runs CLI
// commands, browses the filesystem and writes source files, and
// `listen(port)` alone binds 0.0.0.0, which on a host with a public IP puts
// all of that on the internet. Exposing it is an explicit opt-in — and as
// of #278 it is refused outright unless a GitHub login is configured.
const host = process.env.HOST || '127.0.0.1';

// Whether a GitHub session is required, and how one is obtained, is
// resolved once, here, from the environment (see auth.mjs for the rules).
// A configuration the server must not run with — exposed without a way to
// log in, the e2e test login left on in production, OAuth configured with
// an empty allowlist — throws, and the process exits rather than starting
// in an unsafe state.
// #378: the target app's dev server. Created BEFORE auth because signing out stops it (it is project code
// running on the developer's machine for the signed-in session). Nothing starts it but an explicit POST.
export const devServer = createDevServerService({
  getProjectDir,
  // Which branch is checked out in the project's working tree, and did Cockpit create it. This is the same
  // tree the dev server runs in, so on a session branch the server and Cockpit's saves see the same files.
  getBranchInfo: (root) => {
    const s = getSessionStatus(root);
    return { branch: s.branch, isSession: isSessionBranch(s.branch, { prefix: s.config.branchPrefix, sessionBranch: s.session?.branch ?? null }) };
  },
});

// #638: the per-session GitHub connection for private clones (repoConnection.mjs). Declared before `auth` because
// signing out wipes it; assigned right after, and null-safe in the sign-out hook until then.
export let repoConnections = null;
let auth;
let harnessSeams;
try {
  harnessSeams = resolveHarnessSeams(process.env, { host });
  auth = createAuth(resolveAuthConfig(process.env, { host, port, clientOrigin: CLIENT_ORIGIN }), {
    onLogout: (login) => {
      devServer.stopForLogin(login ?? '');
      repoConnections?.wipeKey(sessionKeyOf({ login }));
    },
  });
  repoConnections = createRepoConnections(resolveRepoConnectionConfig(process.env, { host, port }), { maxTtlMs: auth.config.sessionTtlMs });
} catch (e) {
  if (e instanceof AuthConfigError && isEntrypoint()) {
    console.error(`\nConstruct UI server refused to start:\n\n  ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

// #365 / #330 / #650 harness-only seams (testSeams.mjs): CONSTRUCT_E2E_PROJECT_DIR opens a project at start (through the
// same workspace containment as a client's choice) and CONSTRUCT_E2E_CLONE_LOCAL_ROOT lets a file:// URL under that
// directory be cloned. Both, like every CONSTRUCT_E2E_* seam, are refused outright under NODE_ENV=production and when the
// server is exposed beyond loopback, so they can never be a production bypass. They are resolved inside the try above.
if (harnessSeams.projectDir) preloadProject(harnessSeams.projectDir);
const cloneLocalRoot = harnessSeams.cloneLocalRoot;

const app = express();
// `credentials: true` is required for the session cookie to survive the
// cross-origin hop from the Next.js client (:3000) to this server (:4000).
// It is exactly why `origin` must stay a single, specific origin rather
// than `*` — a credentialed wildcard is both rejected by browsers and the
// thing that would make a drive-by page able to mint or use a session.
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
// #596: `/api/notes` carries its own, larger body parser (a note may be 256 KiB; this one stops at 100 KB) and
// mounts it below the session gate, so no unauthenticated request is ever parsed at that size.
const jsonBody = express.json();
app.use((req, res, next) => (req.path === '/api/notes' || req.path.startsWith('/api/notes/') || req.path === '/api/blocks' ? next() : jsonBody(req, res, next)));
// A body that is not valid JSON gets a fixed answer. The default handler prints the parser's message, which quotes
// a snippet of the body, and a clone request's body may carry a one-time access token (#330 slice B): nothing the
// client sent is ever echoed back or logged from here.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.type === 'charset.unsupported' || err.type === 'encoding.unsupported')) {
    return res.status(err.status === 413 ? 413 : 400).json({ ok: false, error: 'The request body was not valid JSON.' });
  }
  return next(err);
});

function respond(res, result) {
  res.status(result.httpStatus).json(result);
}

// Public on purpose. Playwright's `webServer` block and any liveness probe
// poll it before a session can exist. It is registered *above* the gate
// below, so it is the only unauthenticated `/api` route by construction
// rather than by a path comparison something could be smuggled past.
// `ok: true` first, always (= "the server answers"); the rest (#423) is
// states only — writability and free space of the workspace and the state
// directory, node and git versions, whether clone is enabled — never a path
// and never a secret (health.mjs). `cloneJobs` is defined further down; the
// closure runs per request, long after this module has finished loading.
export const health = createHealth({
  getWorkspaceRoot: workspaceRoot,
  getStateDir: () => resolveStateDir(),
  gitStatus: () => cloneJobs.gitStatus(),
});
app.get('/api/health', (req, res) => {
  res.json(health.snapshot());
});

// Log in / out. Deliberately outside `/api`, and therefore outside the
// gate — you cannot log in through a door that requires being logged in.
auth.mountRoutes(app);
// #638: the separate "connect GitHub for private repositories" consent. Also outside `/api` (the browser navigates
// to it), so each route checks the session itself; both answer 404 when CONSTRUCT_GITHUB_REPO_CLIENT_ID/SECRET are unset.
mountRepoAuthRoutes(app, { connections: repoConnections, auth, clientOrigin: CLIENT_ORIGIN });

// Is an agent or model working on the framework itself right now? Public, read-only, booleans only (devActivity.mjs): the docs
// site's logo reads it. Above the gate on purpose (a visitor has no session). It is on where the server runs on the machine the
// framework is built on: any loopback dev server, or a hosted one told so with CONSTRUCT_DEV_ACTIVITY=1 (the repository whose
// agent sessions count is CONSTRUCT_DEV_ACTIVITY_REPO, default this checkout).
const devActivityRepo = process.env.CONSTRUCT_DEV_ACTIVITY_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
app.use('/api/dev-status', createDevStatusRouter({
  read: createDevActivity({ repoRoot: devActivityRepo, enabled: () => !auth.required || process.env.CONSTRUCT_DEV_ACTIVITY === '1' }),
}));

// ---------------------------------------------------------------------------
// THE GATE (#278). Every route below this line requires a valid, signed
// GitHub session when authentication is enabled; `/api/*` answers 401
// without one. Add new routes BELOW this middleware — a route registered
// above it is public, and this API runs CLI commands and writes files.
// ---------------------------------------------------------------------------
app.use('/api', auth.requireSession);
// #567: right after the gate, scope the request to the signed-in user's own workspace directory (`<root>/<login>`),
// so every `workspaceRoot()` below is per user. Mounted once, here, so no route can forget it.
app.use('/api', userWorkspaceMiddleware);

// Read-only. Returns the CLI's *real* help/usage text, imported directly
// from the same source modules bin/construct.mjs and the REPL use (see
// src/usage.mjs and src/repl.mjs's exported HELP_TOPICS/TOPIC_ORDER/
// getTopLevelHelpText) — never a hand-copied duplicate — so the UI's Help
// page can render the CLI reference from the exact same source of truth
// as `construct` (no args) and `construct repl`'s `help`/`help <topic>`.
app.get('/api/help', (req, res) => {
  res.json({
    usage: USAGE,
    topLevelHelp: getTopLevelHelpText(),
    topics: TOPIC_ORDER,
    helpTopics: HELP_TOPICS,
  });
});

// `findProjectRoot` (src/config.mjs) is the exact same upward-search
// `getRoot` (src/cli.mjs) uses to resolve every command's working root —
// walks up from the given directory looking for the nearest
// `architecture.yml`, falling back to null if none is found all the way to
// the filesystem root. Reusing it here (rather than e.g. a plain
// `fs.existsSync(path.join(dir, 'architecture.yml'))`) means "valid" here
// means exactly what "valid" means when a command actually runs: a
// subdirectory of an existing Construct project counts (matches --dir's
// monorepo support), but an arbitrary directory with no architecture.yml
// anywhere above it does not, and must be `init`-ed first.
function projectStatusFor(projectDir) {
  // #365: no project open is its own state (the client shows "Open a project"), and a project root found by
  // climbing OUT of the workspace does not count.
  if (projectDir === null) return { resolvedProjectRoot: null, valid: false, needsInit: false, noProject: true };
  const resolvedProjectRoot = containedProjectRoot(projectDir);
  return {
    resolvedProjectRoot,
    valid: resolvedProjectRoot !== null,
    needsInit: resolvedProjectRoot === null,
    noProject: false,
  };
}

/** A WorkspaceError is the client's mistake (400/403/404, with a stable `code`); anything else is a plain 400. */
function settingsErrorBody(e) {
  const known = e instanceof WorkspaceError;
  return { status: known ? e.status : 400, body: { ok: false, error: e.message, ...(known ? { code: e.code } : {}) } };
}

app.get('/api/settings', (req, res) => {
  const settings = getSettings();
  res.json({ ...settings, ...projectStatusFor(settings.projectDir) });
});

/** Apply a settings change; #378: closing a project, or opening a different one, stops the dev server it was running.
 * Returns the body `/api/settings` answers with. Shared by POST /api/settings and "New project" (#445). */
function applySettings(change) {
  const before = devServer.currentRoot();
  const settings = updateSettings(change);
  if (before && before !== devServer.currentRoot()) devServer.stopForRoot(before);
  return { ...settings, ...projectStatusFor(settings.projectDir) };
}

app.post('/api/settings', (req, res) => {
  try {
    res.json(applySettings(req.body || {}));
  } catch (e) {
    const { status, body } = settingsErrorBody(e);
    res.status(status).json(body);
  }
});

// #223 + #365 + #568: "My projects" list for the project picker. The ONLY root is the signed-in user's
// workspace (never $HOME, never a client-set list) and only that ONE level is listed, directories only, each
// flagged with whether it holds architecture.yml; any `path` other than the root itself is a 403. All listing
// logic lives in src/dir-browser.mjs (+ ./dirBrowse.mjs adapter).
app.get('/api/fs/browse', (req, res) => {
  const { status, body } = handleBrowse(req.query, {
    origin: req.get('origin'),
    clientOrigin: CLIENT_ORIGIN,
    roots: getBrowseRoots(),
  });
  res.status(status).json(body);
});

// #600: one directory of the OPEN project at a time, for the Import Wizard's route/folder picker.
app.get('/api/project/tree', (req, res) => {
  const { status, body } = listProjectTree(getProjectDir(), req.query.path);
  res.status(status).json(body);
});

// #365: every route below that works on a project answers 409 {code:'NO_PROJECT'} when none is open (never a
// crash, never a fallback to process.cwd()), and refuses a project whose architecture.yml lives outside the
// workspace. Mounted once, here, so no individual route can forget it. `init` creates a project, so it only
// needs a folder to be open.
app.use('/api/init', requireProject({ allowEscapingRoot: true }));
app.use(
  [
    '/api/create', '/api/refactor', '/api/research', '/api/import',
    '/api/pages', '/api/workflows', '/api/units', '/api/features', '/api/flow', '/api/nav', '/api/validate',
    '/api/git/session', '/api/git/dirty-answer', '/api/git/commit', '/api/git/plan',
    '/api/processes', '/api/plan', '/api/requirement', '/api/review', '/api/tests', '/api/project', '/api/notes', '/api/blocks',
  ],
  requireProject(),
);

// Initializes a Construct project (architecture.yml + AGENTS.md + a `core`
// feature) at the *currently selected* project directory — the same
// `init` function `construct init` runs, called in-process like every
// other command endpoint. Exists so the frontend's "this isn't a Construct
// project yet" state (see projectStatusFor above) has somewhere to send the
// user other than a dead end: pick a directory in Settings, then either
// select an existing project or press "Initialize Construct here".
app.post('/api/init', async (req, res) => {
  const projectDir = getProjectDir();
  const result = await runCapturing(() => init([projectDir]));
  const settings = getSettings();
  res.status(result.httpStatus).json({ ...result, ...settings, ...projectStatusFor(settings.projectDir) });
});

// create feature <name> | create layer <name> --feature f --layers l1,l2 | create <layer> <name> --feature f
// #541: create, refactor, research and import honour project.execution.mode (engine = the in-process call, cli =
// the real CLI's --format json); requests that ask for a model call always run in-process (writeVerbsApi.mjs).
// LLM use is opt-in PER RUN (#109): Settings only says WHICH provider a capability uses; nothing is called
// unless the request itself asks (`useLlm: true`). A "feature" has no fillable body, so it never applies.
app.post('/api/create', async (req, res) => {
  const { status, body } = await handleCreate({
    body: req.body,
    projectDir: getProjectDir(),
    findRoot: containedProjectRoot,
    inProcess: (args) => runCapturing(() => create(withDir(args))),
    llmProvider: () => getSettings().llmProviders.createFill,
  });
  res.status(status).json(body);
});

// refactor move <name> --feature f --from l1 --to l2 | refactor rename <name> <newName> --feature f --layer l
app.post('/api/refactor', async (req, res) => {
  const { status, body } = await handleRefactor({
    body: req.body,
    projectDir: getProjectDir(),
    findRoot: containedProjectRoot,
    inProcess: (args) => runCapturing(() => refactor(withDir(args))),
  });
  res.status(status).json(body);
});

// research summarize [--feature ...] [--format ...] [--since ...] | research doctor
// #541: honours project.execution.mode (engine = the in-process call below, cli = the real CLI's --format json).
app.post('/api/research', async (req, res) => {
  const { status, body } = await handleResearch({
    body: req.body,
    projectDir: getProjectDir(),
    findRoot: containedProjectRoot,
    inProcess: (args) => runCapturing(() => research(withDir(args))),
  });
  res.status(status).json(body);
});

// import <name> --feature f --layers l1,l2 --from path [--llm p] | import --plan path [--llm p]
app.post('/api/import', async (req, res) => {
  const { status, body } = await handleImport({
    body: req.body,
    projectDir: getProjectDir(),
    findRoot: containedProjectRoot,
    inProcess: (args) => runCapturing(() => importCommand(withDir(args))),
    // #365: `from` and `planPath` are files the server will READ (and, with --llm, send to a provider). They must
    // resolve, by realpath, inside the workspace; a relative one is relative to the open project, not to the server.
    resolveRead: (value) => contain(workspaceRoot(), value, { base: getProjectDir() }),
    mapError: settingsErrorBody,
    // An explicit `llm` provider name (direct API use) still wins; the UI sends `useLlm: true` instead and the
    // provider comes from Settings.importFill.
    llmProvider: () => getSettings().llmProviders.importFill,
  });
  res.status(status).json(body);
});

// ---------------------------------------------------------------------------
// Ollama (Epic 6.1, #97) — detect/list/pull/remove models through Ollama's
// own local HTTP API (see ollama.mjs). Read-only detection/listing never
// throws a hard error to the client; a non-running daemon is a normal state
// the UI renders (install guidance), not a 500.

app.get('/api/ollama/status', async (req, res) => {
  res.json(await getOllamaStatus());
});

app.get('/api/ollama/models', async (req, res) => {
  try {
    res.json({ models: await listOllamaModels() });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Streams Ollama's own newline-delimited JSON pull-progress events straight
// through to the browser as they arrive (see startOllamaPull's comment) —
// the client reads this response body incrementally rather than waiting for
// it to finish, so a multi-GB pull shows live progress instead of a blocked
// spinner.
app.post('/api/ollama/pull', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
  try {
    const upstream = await startOllamaPull(name);
    res.setHeader('Content-Type', 'application/x-ndjson');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.delete('/api/ollama/models/:name', async (req, res) => {
  try {
    res.json(await removeOllamaModel(req.params.name));
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Pages editor (epic #48: #49 pages browser, #50 JSX tree, #52 snippet
// save-back, #53 props inspector, #54 auto-map). All of this is read/write
// only within features/<feature>/pages/ — see pagesEditor.mjs's
// resolvePageFile for the #56 scope guard, applied on every route below,
// and checkEnforcement for the #56 pre-save architecture-rule gate applied
// on every route that writes.
function currentRoot() {
  const { projectDir } = getSettings();
  const root = containedProjectRoot(projectDir);
  if (!root) throw new PagesEditorError('No Construct project found for the current project directory — set one in Settings first.', { status: 400 });
  return root;
}

function handlePagesEditorError(res, e) {
  if (e instanceof PagesEditorError) {
    return res.status(e.status).json({ ok: false, error: e.message, violations: e.violations, code: e.code });
  }
  return res.status(500).json({ ok: false, error: e.message });
}

app.get('/api/pages/features', (req, res) => {
  try {
    res.json({ features: listFeatures(currentRoot()) });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.get('/api/pages', (req, res) => {
  try {
    const { feature } = req.query;
    if (!feature) return res.status(400).json({ ok: false, error: 'feature is required' });
    res.json({ feature, files: listPages(currentRoot(), feature) });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #431: every page of the project for the Pages screen's Browser list (read-only).
app.get('/api/pages/all', (req, res) => {
  try {
    const pages = listAllPages(currentRoot());
    res.json({ ok: true, count: pages.length, pages });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.get('/api/pages/tree', (req, res) => {
  try {
    const { feature, file } = req.query;
    const root = currentRoot();
    const { absPath, relPath } = resolvePageFile(root, feature, file);
    const source = fs.readFileSync(absPath, 'utf8');
    pageChangeTracker.observe(relPath, source); // #224 baseline: what the editor is showing
    res.json(serializeTree(source));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// Read-only source view: the whole page file + TypeScript/architecture
// diagnostics (core src/engine/diagnostics.mjs), scoped by resolvePageFile.
app.get('/api/pages/source', (req, res) => {
  try {
    const { feature, file } = req.query;
    res.json(readPageSource(currentRoot(), feature, file));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.get('/api/pages/node', (req, res) => {
  try {
    const { feature, file, nodeId } = req.query;
    const root = currentRoot();
    const { absPath } = resolvePageFile(root, feature, file);
    res.json(getNodeSnippet(fs.readFileSync(absPath, 'utf8'), nodeId));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// Shared by both the raw-snippet save (#52) and the props-form save (#53):
// patch in memory, run #56's enforcement gate against the patched content,
// write to disk only if it's clean, and always return the up-to-date tree +
// hash so the client can refresh without a second round trip.
function saveAndRespond(res, root, relPath, absPath, patched) {
  const enforcement = checkEnforcement(root, relPath, patched);
  if (!enforcement.ok) {
    return res.status(422).json({ ok: false, error: 'Save blocked: violates architecture rules.', violations: enforcement.violations });
  }
  const isNew = !fs.existsSync(absPath);
  fs.writeFileSync(absPath, patched);
  adoptOwnWrite(relPath, patched);
  res.json({ ok: true, violations: enforcement.violations, autoCommit: afterSave(root, relPath, isNew), ...serializeTree(patched) });
}

// #283 — every save in the Cockpit goes through here on its way to git. Deliberately best-effort:
// a commit that cannot be made (not a git repo, a mid-rebase tree, a git binary that is not there)
// must never turn a successful save into a failed request. The save already happened; the worst
// case is history that is quieter than the user expected, and the response says so.
function afterSave(root, relPath, isNew = false) {
  try {
    return recordSave(root, relPath, { kind: isNew ? 'add' : 'update' });
  } catch (e) {
    return { committed: false, status: 'error', error: e.message };
  }
}

// #224 — last external change to a page file, as a diff. The client polls
// this; each poll observes the file, so a write from an agent/CLI/other
// editor (anything that didn't go through saveAndRespond) shows up here.
// Same resolvePageFile scope guard as every other route.
app.get('/api/pages/changes', (req, res) => {
  try {
    const { feature, file } = req.query;
    const { absPath, relPath } = resolvePageFile(currentRoot(), feature, file);
    res.json({ ok: true, ...describePageChange(absPath, relPath) });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.post('/api/pages/changes/dismiss', (req, res) => {
  try {
    const { feature, file } = req.body || {};
    const { relPath } = resolvePageFile(currentRoot(), feature, file);
    pageChangeTracker.dismiss(relPath);
    res.json({ ok: true });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.post('/api/pages/node', (req, res) => {
  try {
    const { feature, file, nodeId, snippet, contentHash } = req.body || {};
    if (!nodeId || typeof snippet !== 'string') return res.status(400).json({ ok: false, error: 'nodeId and snippet are required' });
    const root = currentRoot();
    const { absPath, relPath } = resolvePageFile(root, feature, file);
    const source = fs.readFileSync(absPath, 'utf8');
    const patched = patchNode(source, nodeId, snippet, contentHash);
    saveAndRespond(res, root, relPath, absPath, patched);
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.get('/api/pages/props', (req, res) => {
  try {
    const { feature, file, nodeId } = req.query;
    const root = currentRoot();
    const { absPath } = resolvePageFile(root, feature, file);
    res.json(getNodeProps(fs.readFileSync(absPath, 'utf8'), nodeId));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.post('/api/pages/props', (req, res) => {
  try {
    const { feature, file, nodeId, propName, kind, value, contentHash, index } = req.body || {};
    // A spread prop has no name (it's `{...expr}`, not `name={expr}`) —
    // identified by `index` instead (#77 follow-up to #53).
    if (!nodeId || !kind || (kind !== 'spread' && !propName)) {
      return res.status(400).json({ ok: false, error: 'nodeId, kind, and (for non-spread props) propName are required' });
    }
    const root = currentRoot();
    const { absPath, relPath } = resolvePageFile(root, feature, file);
    const source = fs.readFileSync(absPath, 'utf8');
    assertContentHash(source, contentHash);
    const attrSnippet = buildAttributeSnippet(source, nodeId, propName, kind, value, index);
    const patched = patchNode(source, nodeId, attrSnippet, contentHash);
    saveAndRespond(res, root, relPath, absPath, patched);
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.get('/api/pages/unmapped', (req, res) => {
  try {
    const { feature, file, nodeId } = req.query;
    const root = currentRoot();
    const { absPath } = resolvePageFile(root, feature, file);
    res.json(findUnmappedProps(fs.readFileSync(absPath, 'utf8'), nodeId, root, absPath));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #223: which page-scope names flow into which of this element's props (path-scoped to pages/;
// cross-origin browser reads are refused by the global CORS policy above).
app.get('/api/pages/scope-links', (req, res) => {
  try {
    const { feature, file, nodeId } = req.query;
    const root = currentRoot();
    const { absPath } = resolvePageFile(root, feature, file);
    res.json(getScopeLinks(fs.readFileSync(absPath, 'utf8'), nodeId, root, absPath));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #527 (Slice 1 of #518's design) -- read-only Palette tab: the Providers/Expressions/Components
// pages in this feature could actually import, computed from the real canImport graph
// (packages/engine/palette.mjs). Feature-scoped, not file-scoped: identical for every page in the
// same feature, so the client recomputes it only when the open feature changes.
app.get('/api/pages/palette', (req, res) => {
  try {
    const { feature } = req.query;
    res.json(buildPalette(currentRoot(), typeof feature === 'string' ? feature : ''));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #532 (Slice 2 of #518's design) -- click a Component/Provider entry in the read-only Palette (#527)
// to insert its real import + usage at the end of the currently open page. `kind`/`name`/`path` are
// only a LOOKUP KEY: the actual entry inserted is re-derived from a fresh buildPalette call for this
// page's own feature (never the client-sent object verbatim), the same "never trust a client-named
// path directly" discipline componentsApi.mjs's `pick()` already uses. Goes through the same #56
// enforcement gate (saveAndRespond) as every other Pages editor write.
app.post('/api/pages/palette/insert', async (req, res) => {
  try {
    const { feature, file, kind, name, path: entryPath, contentHash } = req.body || {};
    if (kind !== 'component' && kind !== 'provider') {
      return res.status(400).json({ ok: false, error: 'kind must be "component" or "provider" (Expressions are Slice 3, "Wrap with...").' });
    }
    const root = currentRoot();
    const { absPath, relPath } = resolvePageFile(root, feature, file);
    const source = fs.readFileSync(absPath, 'utf8');
    assertContentHash(source, contentHash);
    const palette = buildPalette(root, feature);
    if (!palette.ok) return res.status(400).json({ ok: false, error: palette.error });
    const list = kind === 'provider' ? palette.providers : palette.components;
    const entry = list.find((e) => e.name === name && e.path === entryPath);
    if (!entry) return res.status(404).json({ ok: false, error: 'That Palette entry is no longer available for this feature — reload the Palette tab and try again.' });

    const result = await buildPaletteInsertion(root, absPath, source, { ...entry, kind });
    if (!result.ok) return res.status(422).json({ ok: false, error: result.error });
    saveAndRespond(res, root, relPath, absPath, result.source);
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #533 (Slice 3 of #518's design, docs/design/block-palette.md section 3) -- "Wrap with...": given a
// JSX selection (`nodeId`, from the same tree/preview selection every other tab already uses), does
// it fall inside a PAGE-008-flagged conditional/loop, does an existing Expression in scope
// structurally fit it, and -- once a name is available -- a real dry-run preview of exactly what
// `construct refactor extract-expression` (#517) would write. Read-only: `dryRun: true` throughout,
// nothing here ever touches disk (the write is the separate POST below, reached only from Approve).
app.get('/api/pages/palette/wrap-suggest', (req, res) => {
  try {
    const { feature, file, nodeId, name, preview } = req.query;
    const root = currentRoot();
    const { absPath } = resolvePageFile(root, feature, file);
    const source = fs.readFileSync(absPath, 'utf8');
    const palette = buildPalette(root, feature);
    if (!palette.ok) return res.status(400).json({ ok: false, error: palette.error });
    const opts = { includeFiles: preview === '1' || preview === 'true' };
    res.json(buildWrapSuggestion(root, absPath, source, nodeId, palette, typeof name === 'string' && name ? name : undefined, opts));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #533 -- confirm ("Approve") one Wrap-with: re-derives the same flagged hit from `nodeId` (never a
// client-sent range/offset) and calls the real, non-dry-run extractExpression(), which writes the
// page plus a new Expression (and, if native markup was hoisted out, one or more new Components).
// No #56 checkEnforcement gate here (unlike every other Pages editor write): extractExpression.mjs's
// own contract is to satisfy EXPR-004/005/006 BY CONSTRUCTION, and checkEnforcement itself assumes
// the file it patches already exists on disk, which a brand-new Expression/Component file does not
// -- `construct refactor extract-expression`'s CLI form validates and reports the same way (writes,
// then reports any violation found), which this mirrors instead of inventing a second gate shape.
app.post('/api/pages/palette/wrap', (req, res) => {
  try {
    const { feature, file, nodeId, name, contentHash } = req.body || {};
    const root = currentRoot();
    const { absPath, relPath } = resolvePageFile(root, feature, file);
    const source = fs.readFileSync(absPath, 'utf8');
    assertContentHash(source, contentHash);
    let result;
    try {
      result = applyWrapConfirm(root, absPath, source, nodeId, name);
    } catch (e) {
      if (e instanceof PagesEditorError) throw e;
      return res.status(422).json({ ok: false, error: e.message });
    }
    const touched = [result.page.file, result.expression.file, ...result.components.map((c) => c.file)];
    const { violations } = validateArchitecture(root, { files: touched });
    for (const t of touched) adoptOwnWrite(t, fs.readFileSync(path.join(root, t), 'utf8'));
    const newSource = fs.readFileSync(absPath, 'utf8');
    let autoCommit;
    try {
      autoCommit = recordSave(root, touched, { kind: 'add' });
    } catch (e) {
      autoCommit = { committed: false, status: 'error', error: e.message };
    }
    res.json({
      ok: true,
      violations,
      autoCommit,
      expression: result.expression,
      components: result.components,
      ...serializeTree(newSource),
    });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #321 click-to-navigate. Both routes sit below the session gate. They return only project-root-relative
// paths and never take a path to read from the client: the first view is a page (the editor's own pages/
// guard), every later hop is a reference in a file, resolved server-side (see projectNav.mjs).
app.get('/api/nav/page', (req, res) => {
  try {
    const { feature, file } = req.query;
    res.json(viewPage(currentRoot(), feature, file));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #328: open a row of the Flow view. The client names a feature and a path; the path is accepted only if
// it is one of the files that feature's flow (computed here) draws, then read through the same guard.
app.get('/api/nav/file', (req, res) => {
  try {
    const { feature, path: rel } = req.query;
    const root = currentRoot();
    const { files, refusal } = flowFilePaths(root, feature);
    if (refusal) return res.status(refusal.status).json(refusal.body);
    if (typeof rel !== 'string' || !files.has(rel)) return res.status(404).json({ ok: false, error: "That file is not part of this feature's flow." });
    res.json(viewProjectFile(root, rel));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #558: two shapes -- `{ from, ref, start }` follows a resolved reference (the reference trail); `{ file,
// line, column }` opens a bare file at a known position with no reference name (the live preview's
// "Show in source" button, which already has the exact location from the app's own error stack).
app.post('/api/nav/open', (req, res) => {
  try {
    const { from, ref, start, file, line, column } = req.body || {};
    res.json(typeof file === 'string' && file ? openSourceLocation(currentRoot(), file, line, column) : openReference(currentRoot(), from, ref, start));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.post('/api/pages/automap', (req, res) => {
  try {
    const { feature, file, nodeId, propNames, contentHash } = req.body || {};
    if (!nodeId || !Array.isArray(propNames) || propNames.length === 0) {
      return res.status(400).json({ ok: false, error: 'nodeId and a non-empty propNames[] are required' });
    }
    const root = currentRoot();
    const { absPath, relPath } = resolvePageFile(root, feature, file);
    const source = fs.readFileSync(absPath, 'utf8');
    assertContentHash(source, contentHash);
    const patched = applyAutoMap(source, nodeId, propNames);
    saveAndRespond(res, root, relPath, absPath, patched);
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// Ticket F.1 (#120, epic #119) — the visual composer's live parse. POST
// (not GET) since a snippet's text can be long/contain query-unsafe
// characters; no `feature`/`file`/disk access at all here — pure text in,
// tree out, so the graph the client renders is always derived fresh from
// whatever text is currently in the editor, never a cached/persisted
// layout.
app.post('/api/pages/snippet-tree', (req, res) => {
  try {
    const { snippet } = req.body || {};
    if (typeof snippet !== 'string') return res.status(400).json({ ok: false, error: 'snippet is required' });
    res.json(parseSnippetToTree(snippet));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// Ticket F.2 (#121, epic #119) — the visual composer's wire-rewrite. Body
// carries the snippet's own current text (not feature/file) plus the wire's
// endpoints; the response is the new snippet text (or a rejection reason),
// never a disk write — the client hands the result to the existing
// save-back-to-source + diff-preview flow itself.
app.post('/api/pages/snippet-rewire', (req, res) => {
  try {
    const { snippet, parentId, propName, fromChildId, toChildId } = req.body || {};
    if (typeof snippet !== 'string' || !parentId || !propName || !fromChildId || !toChildId) {
      return res.status(400).json({ ok: false, error: 'snippet, parentId, propName, fromChildId, and toChildId are required' });
    }
    res.json(rewireWireInSnippet(snippet, { parentId, propName, fromChildId, toChildId }));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// Ticket F.3 (#122, epic #119) — the visual composer's structural node
// edits. Same contract as snippet-rewire above: the snippet's own current
// text in, a rewritten snippet (or a rejection reason) out, never a disk
// write here — the client hands the result to the existing save-back-to-
// source + diff-preview flow itself.
app.post('/api/pages/snippet-remove-node', (req, res) => {
  try {
    const { snippet, nodeId } = req.body || {};
    if (typeof snippet !== 'string' || !nodeId) return res.status(400).json({ ok: false, error: 'snippet and nodeId are required' });
    res.json(removeNodeInSnippet(snippet, nodeId));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.post('/api/pages/snippet-move-node', (req, res) => {
  try {
    const { snippet, nodeId, direction } = req.body || {};
    if (typeof snippet !== 'string' || !nodeId || !direction) {
      return res.status(400).json({ ok: false, error: 'snippet, nodeId, and direction are required' });
    }
    res.json(moveNodeInSnippet(snippet, nodeId, direction));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.post('/api/pages/snippet-add-child', (req, res) => {
  try {
    const { snippet, parentId } = req.body || {};
    if (typeof snippet !== 'string' || !parentId) return res.status(400).json({ ok: false, error: 'snippet and parentId are required' });
    res.json(addChildInSnippet(snippet, parentId));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// ---------------------------------------------------------------------------
// Workflows viewer (epic #57: #59 screen, #60 extraction). Read-only, scoped
// to features/<feature>/workflows/ (see workflowsViewer.mjs's
// resolveWorkflowFile). Machines are re-extracted from real source on every
// request; nothing is stored.
app.get('/api/workflows/features', (req, res) => {
  try {
    res.json({ features: listWorkflowFeatures(currentRoot()) });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.get('/api/workflows', (req, res) => {
  try {
    const { feature } = req.query;
    if (!feature) return res.status(400).json({ ok: false, error: 'feature is required' });
    res.json({ feature, files: listWorkflowFiles(currentRoot(), feature) });
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

app.get('/api/workflows/machines', (req, res) => {
  try {
    const { feature, file } = req.query;
    res.json(readWorkflowMachines(currentRoot(), feature, file));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// Epic #185: the same file's machines explained in plain English + scenarios
// + health findings, re-derived from the real source on every request.
app.get('/api/workflows/narrative', (req, res) => {
  try {
    const { feature, file } = req.query;
    res.json(readWorkflowNarrative(currentRoot(), feature, file));
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// #61: POST body { feature, file, machine, op, ...opArgs, commit?, contentHash? }.
// commit=false -> patched source for the diff preview (nothing written);
// commit=true -> re-apply, hash check, enforcement gate, write.
app.post('/api/workflows/edit', (req, res) => {
  try {
    const { feature, file, commit, contentHash, ...edit } = req.body || {};
    const root = currentRoot();
    const result = editWorkflowFile(root, feature, file, edit, { commit: !!commit, contentHash });
    res.json(result.savedPath ? { ...result, autoCommit: afterSave(root, result.savedPath) } : result);
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// ---------------------------------------------------------------------------
// Commit-on-save (#283). The deterministic message assembly lives in core
// (src/engine/commitMessage.mjs); these routes are the policy surface the
// Cockpit drives: what mode we are in, what the session branch is, and the
// one question the feature is allowed to ask the user (a dirty tree at
// session start). Read ui/server/src/autoCommit.mjs for the rules.
function handleAutoCommitError(res, e) {
  if (e instanceof AutoCommitError) return res.status(e.status).json({ ok: false, error: e.message });
  return handlePagesEditorError(res, e);
}

app.get('/api/git/session', (req, res) => {
  try {
    res.json(getSessionStatus(currentRoot()));
  } catch (e) {
    handleAutoCommitError(res, e);
  }
});

app.post('/api/git/config', (req, res) => {
  try {
    res.json({ ok: true, config: updateCommitConfig(req.body || {}) });
  } catch (e) {
    handleAutoCommitError(res, e);
  }
});

// The answer to "you had uncommitted changes when this session started — carry them onto the
// session branch, or stash them?". `remember` keeps the answer for this project so a user who
// always answers the same way is not asked forever (#283).
app.post('/api/git/dirty-answer', (req, res) => {
  try {
    const { answer, remember } = req.body || {};
    res.json({ ok: true, result: answerDirtyPrompt(currentRoot(), { answer, remember: !!remember }) });
  } catch (e) {
    handleAutoCommitError(res, e);
  }
});

// Commit whatever is pending right now: the Commit button in `manual` mode, and the "don't wait
// for the coalescing window" action in `coalesce`.
app.post('/api/git/commit', (req, res) => {
  try {
    res.json({ ok: true, result: flushSession(currentRoot()) });
  } catch (e) {
    handleAutoCommitError(res, e);
  }
});

// Optional: tell the session which plan/ticket it is working from, so the branch is named after
// the work and the commit body can say what was planned versus not (#286's planTouches).
app.post('/api/git/plan', (req, res) => {
  try {
    const { plan, planTitle } = req.body || {};
    res.json({ ok: true, ...setSessionPlan(currentRoot(), { plan: plan || null, planTitle: planTitle || '' }) });
  } catch (e) {
    handleAutoCommitError(res, e);
  }
});

// ---------------------------------------------------------------------------
// Unit summaries (deterministic, LLM-free; src/engine/unitSummary.mjs). Read-only, scoped to the
// current project root. /api/features* are thin aliases of the feature-kind unit calls.
function sendUnits(res, fn) {
  try {
    const { status, body } = fn(currentRoot());
    res.status(status).json(body);
  } catch (e) {
    handlePagesEditorError(res, e);
  }
}
app.get('/api/units', (req, res) => sendUnits(res, (root) => unitsIndex(root, req.query)));
app.get('/api/units/summary', (req, res) => sendUnits(res, (root) => unitSummary(root, req.query)));
app.get('/api/features', (req, res) => sendUnits(res, (root) => featuresIndex(root)));
app.get('/api/features/:name/summary', (req, res) => sendUnits(res, (root) => featureSummary(root, req.params.name, req.query)));

// #328: the Browser pane's Flow view. Read-only; the feature name is validated against the current
// project's real feature list (flowApi.mjs) and never becomes a path.
app.get('/api/flow/:feature', (req, res) => {
  try {
    const { status, body } = featureFlow(currentRoot(), req.params.feature);
    res.status(status).json(body);
  } catch (e) {
    handlePagesEditorError(res, e);
  }
});

// Cockpit drawer: Diagnostics (construct validate for the current project) and
// Logs (bounded in-memory ring of recent command/validate output). Both are
// read-only and refuse a foreign browser origin.
app.get('/api/validate', async (req, res) => {
  const { status, body } = await handleValidateForProject({ origin: req.get('origin'), clientOrigin: CLIENT_ORIGIN, projectDir: getProjectDir(), findRoot: containedProjectRoot });
  res.status(status).json(body);
});

app.get('/api/logs', (req, res) => {
  const { status, body } = handleLogs(req.query, { origin: req.get('origin'), clientOrigin: CLIENT_ORIGIN });
  res.status(status).json(body);
});

// #378: the dev server of the open project (Start / Restart / Stop, states, branch provenance). Below the gate.
app.use('/api/dev-server', createDevServerRouter(devServer, { clientOrigin: CLIENT_ORIGIN }));

// #292: the Processes drawer. Registered below the gate like every other
// `/api` route; the WebSocket (createUiServer) takes the same `auth`.
// #351: `review.analyze` steps (a Review-mode analysis) run in the read-only review executor, never in the
// bot runner: no worktree, no bot branch, no artifacts, so they can never reach the approval gate.
export const reviewExecutor = createReviewExecutor();
// #305: `test.run` steps (a Tests-tab run) run the same way: a forked worker, no bot branch, no artifacts.
export const testRunExecutor = createTestRunExecutor();
// #611: startPlan itself refuses a plan that uses a block turned off for the project, whoever starts it.
export const processesService = createProcessesService({ getProjectDir, reviewExecutor, testRunExecutor, getBlockSettings: (root) => openBlockSettingsStore(root).disabledFlows() });
app.use('/api/processes', createProcessesRouter(processesService));

// #289/#332: Plan mode. Below the gate like every other `/api` route. The plan comes from the browser, so
// planService re-validates it (validatePlan + the Cockpit's path/argument checks) and only then starts a
// process through the same service the Processes drawer reads. The project is always the current one.
export const planService = createPlanService({
  getRoot: () => containedProjectRoot(getProjectDir()),
  startPlan: (plan) => processesService.startPlan(plan),
  // #407: blocks turned off for this project (Features, Blocks tab) are refused by the plan check, read fresh on every call.
  getBlockSettings: (root) => openBlockSettingsStore(root).disabledFlows(),
  // #609: Run marks the note it was run from as ran (same project root the Notes router uses, see below).
  onStarted: ({ noteId, plan, processId }) => {
    const dir = getProjectDir();
    const root = dir ? containedProjectRoot(dir) || dir : null;
    if (root) openNotesStore(root).markRan(noteId, { plan, processId });
  },
});
app.use('/api/plan', createPlanRouter(planService));

// #642: the requirement chain (a sentence read back as card, placement, plan and timeline). Below the session gate and the
// project-open gate; read-only and model-free. Approving its plan goes through the Plan route above, unchanged.
app.use('/api/requirement', createRequirementRouter({
  clientOrigin: CLIENT_ORIGIN,
  getRoot: () => {
    const root = containedProjectRoot(getProjectDir());
    return root ? { ok: true, root } : { ok: false, status: 409, body: NO_PROJECT_BODY };
  },
}));

// #312/#313: Review mode (read-only). Registered below the gate like every other `/api` route. The
// repository is always the current project's -- the client sends branch names only, and each is
// checked against `git for-each-ref` of that repository (reviewRefs.mjs). The synchronous PR-health
// engine runs in a child process per job (reviewRunner.mjs), never on this request thread, and each job is a
// Process (#351) in the Processes drawer.
export const reviewJobs = createReviewJobs({ analyses: createAnalyses({ service: processesService, results: reviewExecutor.results }) });
app.use('/api/review', createReviewRouter({
  jobs: reviewJobs,
  clientOrigin: CLIENT_ORIGIN,
  // #316: the saved plans of the current project are the plans of its processes (the store lists them).
  plans: createPlanSource({ records: () => processesService.store()?.all().processes }),
  getRoot: () => {
    const root = containedProjectRoot(getProjectDir());
    return root ? { ok: true, root } : { ok: false, error: 'No Construct project found for the current project directory. Pick a project first.' };
  },
}));

// #431/#434: the Components screen (list, props from react-docgen, plain-file source and its one write path).
// Registered below the gate like every other `/api` route; the client names a component by a path that must be in the
// real list for this project (componentsApi.mjs).
app.use('/api/components', createComponentsRouter({
  clientOrigin: CLIENT_ORIGIN,
  afterSave,
  getRoot: () => {
    const root = containedProjectRoot(getProjectDir());
    return root ? { ok: true, root } : { ok: false, error: 'No Construct project found for the current project directory. Pick a project first.' };
  },
}));

// #596: durable Notes (drafts kept per project in the per-user state directory, never in the project). Below the
// session gate and the project-open gate above; the client names a note by id only (notesApi.mjs).
app.use('/api/notes', createNotesRouter({
  clientOrigin: CLIENT_ORIGIN,
  getRoot: () => {
    const dir = getProjectDir();
    const root = dir ? containedProjectRoot(dir) || dir : null;
    return root ? { ok: true, root } : { ok: false, status: 409, body: NO_PROJECT_BODY };
  },
}));

// #407: the Blocks catalogue and its per-project settings (which blocks are on, default engine and local model). Below the
// session gate and the project-open gate; the same project root the plan check reads the settings for (planService).
app.use('/api/blocks', createBlocksRouter({
  clientOrigin: CLIENT_ORIGIN,
  getRoot: () => {
    const root = containedProjectRoot(getProjectDir());
    return root ? { ok: true, root } : { ok: false, status: 409, body: NO_PROJECT_BODY };
  },
}));

// #300/#301: the Tests tab. Registered below the gate like every other `/api` route. The client sends a
// feature name, a generated file NAME and a clone name only; all three are validated and every path is derived
// on the server (testsApi.mjs / src/engine/testClone.mjs). The clone and generate POSTs are mutating.
// #305: a run is a Process too; the routes below start, read and cancel it by feature name.
export const testRunJobs = createTestRunJobs({ runs: createTestRuns({ service: processesService, results: testRunExecutor.results }) });
app.use('/api/tests', createTestsRouter({
  clientOrigin: CLIENT_ORIGIN,
  runs: testRunJobs,
  getRoot: () => {
    const root = containedProjectRoot(getProjectDir());
    return root ? { ok: true, root } : { ok: false, error: 'No Construct project found for the current project directory. Pick a project first.' };
  },
}));

// #330: clone a PUBLIC repository into the workspace (https, allowlisted host, cancellable job) and connect a
// local project to a remote. Below the gate like every other `/api` route. The client sends a URL (and optionally
// a folder name) only; everything else is built and checked on the server (cloneJobs.mjs, gitUrl.mjs).
const cloneHosts = resolveCloneHosts(process.env);
export const cloneJobs = createCloneJobs({
  getRoot: workspaceRoot,
  hosts: cloneHosts,
  localRoot: cloneLocalRoot,
  maxBytes: Number(process.env.CONSTRUCT_CLONE_MAX_MB) > 0 ? Number(process.env.CONSTRUCT_CLONE_MAX_MB) * 1024 * 1024 : DEFAULT_MAX_BYTES,
  timeoutMs: Number(process.env.CONSTRUCT_CLONE_TIMEOUT_SEC) > 0 ? Number(process.env.CONSTRUCT_CLONE_TIMEOUT_SEC) * 1000 : DEFAULT_TIMEOUT_MS,
  loginToken: (sessionKey) => repoConnections.acquire(sessionKey), // #638: a Buffer copy for one job, zeroed by the job
});
// #445: "New project" -- a validated name becomes an empty folder in the caller's workspace, `init`-ed and opened.
// Below the gate, deliberately NOT behind requireProject (nothing is open yet); the client sends a name only.
app.use('/api/projects', createNewProjectRouter({
  clientOrigin: CLIENT_ORIGIN,
  runInit: (dir, framework) => runCapturing(() => init([dir, '--framework', framework])),
  openProject: (dir) => applySettings({ projectDir: dir }),
}));

app.use('/api/clone', createCloneRouter({ jobs: cloneJobs, clientOrigin: CLIENT_ORIGIN }));
app.use('/api/github', createGithubRouter({ connections: repoConnections, clientOrigin: CLIENT_ORIGIN })); // #638
app.use('/api/git/remote', createRemoteRouter({
  clientOrigin: CLIENT_ORIGIN,
  hosts: cloneHosts,
  getRoot: () => {
    const root = containedProjectRoot(getProjectDir());
    return root ? { ok: true, root } : { ok: false, error: 'No Construct project found for the current project directory. Pick a project first.' };
  },
}));

/** True when this file is the process entry point (`npm start`), false when
 * it is imported — by a test, or by anything else that wants the app
 * without a listener. */
function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

/** The Express app and the resolved auth surface, exported so tests can
 * exercise the real route table (and the real gate) without a listener. */
export { app, auth };

/** Build the HTTP server with the wizard WebSocket attached. The socket
 * gets the same `auth` object the REST gate uses, so it can never be the
 * more permissive of the two. */
export function createUiServer() {
  const server = http.createServer(app);
  attachWizardSocket(server, '/ws/wizard', CLIENT_ORIGIN, auth);
  attachProcessesSocket(server, processesService, '/ws/processes', CLIENT_ORIGIN, auth);
  refuseUnknownUpgrades(server, ['/ws/wizard', '/ws/processes']);
  return server;
}

export function start() {
  // Creates the workspace if missing; throws (and the process exits) if it cannot. With login required the root has
  // no default and must be outside the checkout and cwd (#567).
  const root = baseWorkspaceRoot({ authRequired: auth.required });
  // #422: a server that died mid-clone left a marker and maybe a partial directory (and maybe a git still running).
  const recovered = cloneJobs.recoverInterrupted();
  for (const slug of recovered.killed) console.warn(`Clone recovery: stopped an orphaned git clone of ${slug} left by a previous server.`);
  for (const slug of recovered.removed) console.warn(`Clone recovery: removed the partial clone ${slug} left by a previous server. It can be cloned again.`);
  for (const { slug, why } of recovered.kept) console.log(`Clone recovery: left ${slug} alone (${why}).`);
  const server = createUiServer();
  server.listen(port, host, () => {
    console.log(`Construct UI server listening on http://${host}:${port}`);
    console.log(`Workspace: ${root} (the only place projects can be opened; set CONSTRUCT_WORKSPACE_ROOT to change it). No project is open until one is chosen.`);
    if (repoConnections.enabled) console.log('GitHub connection for private repositories: enabled (callback /auth/repo/callback).');
    else if (repoConnections.config.halfConfigured) console.warn('WARNING: GitHub connection for private repositories is OFF: set both CONSTRUCT_GITHUB_REPO_CLIENT_ID and CONSTRUCT_GITHUB_REPO_CLIENT_SECRET, or neither (#638).');
    for (const line of [...auth.describeStartup(), ...health.describeStartup()]) {
      (line.level === 'warn' ? console.warn : console.log)(line.level === 'warn' ? `WARNING: ${line.text}` : line.text);
    }
    if (!isLoopbackHost(host)) {
      console.warn(`Bound to ${host}, not loopback — this server is reachable from other machines (#277).`);
    }
  });
  return server;
}

if (isEntrypoint()) start();
