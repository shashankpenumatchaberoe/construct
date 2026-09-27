// Pure (DOMAIN-001): one status in, one finished view out. Every word the dev-server card shows, and every
// button it offers, is decided here so the components stay presentation. The states are the spec's
// (`ia-preview-states`): not running, starting, outside the workspace, port busy, running, plus the reasons a
// start is refused (no project, no dev script) and a server that stopped for another reason.
import type { BranchIndicator, DevServerStatus, DevServerView, DevServerViewOptions } from '../types';

const SESSION_HINT = 'Cockpit made this branch. The dev server runs on the same files Cockpit saves to, so what you see is what will be committed.';
const OTHER_HINT = 'Not made by Cockpit (it was there before, or made by hand). You can work on it, but Cockpit cannot promise nothing else is changing these files.';

/** Which kind of branch is checked out, in words. Null when the project is not a git repository (nothing to say). */
export function describeBranch(status: Pick<DevServerStatus, 'branch' | 'branchKind'> | null): BranchIndicator | null {
  if (!status || !status.branch || !status.branchKind) return null;
  return status.branchKind === 'session'
    ? { kind: 'session', label: 'Session branch', name: status.branch, hint: SESSION_HINT }
    : { kind: 'other', label: 'Other branch', name: status.branch, hint: OTHER_HINT };
}

/** The last path segment of a project root, for words like "in storefront". */
export function projectName(root: string | null): string {
  if (!root) return 'this project';
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'this project';
}

const EMPTY: Omit<DevServerView, 'card' | 'title' | 'message'> = {
  command: null,
  confirming: false,
  running: null,
  networkWarning: null,
  canStart: false,
  canStop: false,
  canRestart: false,
  usePort: null,
  showLog: false,
  branch: null,
  busy: false,
};

/** What the card says and offers for this status. `null` (not loaded yet) reads as "not running" with nothing offered. */
export function buildDevServerView(status: DevServerStatus | null, opts: DevServerViewOptions): DevServerView {
  const branch = describeBranch(status);
  const base = { ...EMPTY, branch, busy: opts.busy };
  if (!status) return { ...base, card: 'not-running', title: 'Dev server not running', message: 'Checking the project.' };

  const refusal = status.refusal;
  if (refusal?.code === 'NO_PROJECT') {
    return { ...base, card: 'no-project', title: 'No project open', message: refusal.message };
  }
  if (refusal?.code === 'PROJECT_ROOT_OUTSIDE_WORKSPACE') {
    return { ...base, card: 'outside-workspace', title: 'Outside the workspace', message: `${refusal.message} Open a project that is inside the workspace.` };
  }
  if (refusal?.code === 'NO_DEV_SCRIPT') {
    return { ...base, card: 'no-script', title: 'No dev script', message: `${refusal.message} Add one, or use a URL instead.` };
  }

  const command = status.command ? { display: status.command.display, text: status.command.text } : null;
  const name = projectName(status.root);
  switch (status.state) {
    case 'starting':
      return {
        ...base,
        card: 'starting',
        title: 'Starting',
        message: `${command?.display ?? 'The dev server'} is starting${status.port ? ` on port ${status.port}` : ''}. Usually 3 to 5 seconds. Its output is in the Logs tab of the bottom panel.`,
        command,
        canStop: true,
        showLog: true,
      };
    case 'running':
      return {
        ...base,
        card: 'running',
        title: 'Running',
        message: `${status.url ?? `:${status.port}`} is running for ${name}.`,
        command,
        running: status.url && status.port ? { url: status.url, port: status.port } : null,
        networkWarning: status.networkWarning ?? null,
        canStop: true,
        canRestart: true,
        showLog: true,
      };
    case 'failed': {
      const f = status.failure;
      const busy = f?.kind === 'port-busy';
      return {
        ...base,
        card: busy ? 'port-busy' : 'stopped',
        title: 'Server stopped',
        message: f?.message ?? 'The dev server stopped.',
        command,
        canStart: true,
        usePort: busy && f?.suggestedPort ? f.suggestedPort : null,
        showLog: true,
      };
    }
    default:
      return {
        ...base,
        card: 'not-running',
        title: 'Dev server not running',
        message: `Start it to see the live app. It runs inside your workspace, for ${name} only.`,
        command,
        confirming: opts.confirming && !opts.acknowledged,
        canStart: !opts.confirming || opts.acknowledged,
      };
  }
}
