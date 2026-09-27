/** Shapes ui/server's `/api/dev-server` returns (see ui/server/src/devServer.mjs), plus the finished view the
 * domain layer builds from them. The Cockpit only reads these: which states exist and why a start is refused
 * is the server's answer, never decided here. */

export type DevServerState = 'not-running' | 'starting' | 'running' | 'failed';

/** Why nothing can be started for this project (the server checks; the client only words it). */
export type DevServerRefusal = { code: 'NO_PROJECT' | 'PROJECT_ROOT_OUTSIDE_WORKSPACE' | 'NO_DEV_SCRIPT'; message: string };

export type DevServerFailure = {
  kind: 'port-busy' | 'exited' | 'timeout';
  message: string;
  port?: number | null;
  /** The next free port, offered as "Use port N" when the chosen one was taken. */
  suggestedPort?: number | null;
  code?: number | null;
};

/** The project's own script, exactly as written in its package.json. */
export type DevServerCommand = { script: string; text: string; display: string };

/** `session`: Cockpit made the checked-out branch. `other`: pre-existing or hand-made. */
export type BranchKind = 'session' | 'other';

export type DevServerStatus = {
  ok: boolean;
  version: number;
  state: DevServerState;
  refusal: DevServerRefusal | null;
  command: DevServerCommand | null;
  /** The project root; only used to remember "you have seen this command" per project. */
  root: string | null;
  port: number | null;
  url: string | null;
  pid: number | null;
  startedAt: string | null;
  failure: DevServerFailure | null;
  /** Set once a running server also answers on one of this machine's own non-loopback addresses (#557): the
   * Cockpit only hands the project's script PORT/HOST/HOSTNAME and frames a loopback address, so a framework
   * that ignores those (Next.js binds 0.0.0.0 by default) is still reachable from the LAN while this says "Running". */
  networkWarning: string | null;
  branch: string | null;
  branchKind: BranchKind | null;
  error?: string;
};

/** Which of the spec's cards (`ia-preview-states`) is showing. */
export type DevServerCard =
  | 'no-project'
  | 'outside-workspace'
  | 'no-script'
  | 'not-running'
  | 'starting'
  | 'running'
  | 'port-busy'
  | 'stopped';

export type BranchIndicator = { kind: BranchKind; label: 'Session branch' | 'Other branch'; name: string; hint: string };

export type DevServerView = {
  card: DevServerCard;
  title: string;
  message: string;
  /** The project's script, shown so nobody is surprised by what "Start" runs. Null when there is none. */
  command: { display: string; text: string } | null;
  /** First start for this command in this project: ask once, showing exactly what will run. */
  confirming: boolean;
  running: { url: string; port: number } | null;
  /** "This server is also reachable from your network: <address>:<port>", only while running. */
  networkWarning: string | null;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  /** "Use port N" after a busy port. */
  usePort: number | null;
  showLog: boolean;
  branch: BranchIndicator | null;
  busy: boolean;
};

export type DevServerViewOptions = { acknowledged: boolean; confirming: boolean; busy: boolean };

/** What a person can do from the card; every one is a click, none happens on its own. */
export type DevServerHandlers = {
  onStart: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onStop: () => void;
  onRestart: () => void;
  onUsePort: (port: number) => void;
  onShowLog: () => void;
};
