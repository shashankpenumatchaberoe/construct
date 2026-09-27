import type { ReactNode } from 'react';

export type ShellId = string;

/** The two supported colour themes. Dark is the default (owner decision). */
export type Theme = 'dark' | 'light';

/** What the person chose in the profile menu: a fixed theme, or follow the operating system (#368). */
export type ThemePreference = Theme | 'system';

// ---- Panes and layout (Design #245, docs/design/cockpit-layout.md) --------

/** The resizable regions of the frame: Browser (left), Tools (right), Drawer (bottom). */
export type PaneId = 'left' | 'right' | 'drawer';

/** `size` is px width (left/right) or px height (drawer); `open` is not-collapsed. */
export type PaneState = { size: number; open: boolean };

export type ShellLayoutState = Record<PaneId, PaneState>;

export type PaneLimit = { min: number; max: number; default: number };

export type ShellLayoutAction =
  | { type: 'LOAD'; layout: ShellLayoutState }
  | { type: 'RESIZE'; pane: PaneId; size: number }
  | { type: 'TOGGLE'; pane: PaneId; open?: boolean };

// ---- Slots / tab registry ------------------------------------------------

/** Where a tab lives: the Browser (left), the Tools panel (right) or the bottom drawer. */
export type ShellRegion = 'browser' | 'tools' | 'drawer';

/** The small interface every pane/tab implements (principles.md #10): a
 * feature registers one of these and never reaches into another feature's panel. */
export type ShellTab = {
  id: string;
  title: string;
  /**
   * The little count next to the title. Three states, deliberately:
   * `undefined` -- this tab never has one; `null` -- it has one whose value is
   * not known yet; a value -- show it.
   *
   * `null` exists because of #252. A tab fed by background work (Diagnostics by
   * `construct validate`, Diff by a file changing on disk) has no badge until
   * that work lands, and a badge appearing widens the tab and shoves every tab
   * after it sideways -- out from under a pointer already reaching for one.
   * Declaring the badge up front reserves its room, so the value can arrive
   * whenever it likes without moving anything.
   */
  badge?: number | string | null;
  disabled?: boolean;
  /** Shown by default (before the user picks a tab) instead of the first enabled one. */
  preferred?: boolean;
  render: () => ReactNode;
};

export type TabHostProps = {
  /** Accessible name of the tab list (also used for the panel group). */
  label: string;
  tabs: ShellTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Shown when the region has no enabled tab. */
  empty?: ReactNode;
  /** #683: the tablist renders elsewhere (RailSubTabs, stacked under the primary rail) instead
   * of as this host's own header. The panel keeps rendering here, still labelled by a tab
   * button that exists elsewhere in the DOM (same id scheme, `aria-labelledby` does not care
   * where the referenced element lives). */
  hideList?: boolean;
};

export type RailSubTabsProps = {
  /** Accessible name of the tab list; also derives the id prefix shared with the TabHost panel
   * this list is switching (must match that TabHost's own `label`). */
  label: string;
  tabs: ShellTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
};

// ---- Navigation ----------------------------------------------------------

/** One of the five top-bar screens (Features, Pages, Components, Git, Tests); `activeOn` lists the existing routes it owns. */
export type PrimaryScreen = { id: string; label: string; href: string; activeOn: string[] };

export type ShellScreen = { href: string; label: string; activeOn: string[] };

export type ModelStatus = 'checking' | 'ready' | 'offline';

export type ProfileMenuItemsProps = {
  pathname: string;
  modelStatus: ModelStatus;
  preference: ThemePreference;
  onPreference: (preference: ThemePreference) => void;
};

export type ShortcutAction = 'toggle-left' | 'toggle-right' | 'toggle-drawer' | 'cycle-pane';

export type ShortcutInfo = { keys: string; action: ShortcutAction; label: string };

// ---- Component props -----------------------------------------------------

/** The single pane showing in the narrow layout: Browser (left), stage (mid) or Tools (right). */
export type NarrowPane = 'left' | 'mid' | 'right';

export type NarrowTabBarProps = {
  pane: NarrowPane;
  onSelect: (pane: NarrowPane) => void;
};

/** Narrow-layout controls shared by the layout and the page that feeds it. */
export type NarrowProps = {
  /** Viewport below 900px: one pane at a time with a bottom tab bar. */
  narrow?: boolean;
  narrowPane?: NarrowPane;
  onNarrowPane?: (pane: NarrowPane) => void;
};

export type ShellLayoutProps = NarrowProps & {
  /** Focus mode (#456): the chrome stands down so the stage owns the viewport. See useShellFocus. */
  focus?: boolean;
  layout: ShellLayoutState;
  limits: Record<PaneId, PaneLimit>;
  onResize: (pane: PaneId, size: number) => void;
  onTogglePane: (pane: PaneId) => void;
  top: ReactNode;
  /** The screens rail (vertical left in the wide layout, a bar above the pane tabs when narrow). */
  rail: ReactNode;
  left: ReactNode;
  mid: ReactNode;
  right: ReactNode;
  drawer: ReactNode;
  status: ReactNode;
};

export type PaneResizerProps = {
  /** 'vertical' separates side-by-side panes (drag left/right); 'horizontal' separates the drawer. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  /** True when growing the pane means moving the pointer toward the start (right pane, drawer). */
  invert?: boolean;
  onResize: (size: number) => void;
  onToggle: () => void;
  controls?: string;
};

export type ProjectSwitcherProps = {
  label: string;
  dir: string | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Folder picker supplied by the controller (another feature). */
  picker: ReactNode;
  error?: string | null;
  /** #365: closes the open project (the Cockpit then shows "Open a project"). */
  onCloseProject?: () => void;
};

export type ActivityBarProps = {
  screens: PrimaryScreen[];
  activeScreenId: string | null;
  /** Little counts beside a screen's name, by screen id (Git: the branches under review). Absent or 0 shows none. */
  screenBadges?: Record<string, number>;
  /** Icons only (vertical rail). Remembered per person by the controller. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Vertical on the left of the frame; horizontal above the pane tabs in the narrow layout. */
  orientation: 'vertical' | 'horizontal';
};

/** Minimal top bar shown while no project is open: brand and the profile menu only. */
export type GateTopBarProps = { userMenu?: ReactNode };

export type TopBarProps = {
  projectSwitcher: ReactNode;
  /** The signed-in account slot (#278). A slot, not a dependency: the shell
   * knows a node goes here, not that the auth feature exists. Renders
   * nothing on a server with no login gate. */
  userMenu?: ReactNode;
  modelStatus: ModelStatus;
  runningProcesses: number;
  /** The framework is working (a command, the Import Wizard or a Process): the brand mark animates only then. */
  working: boolean;
  layout: ShellLayoutState;
  onTogglePane: (pane: PaneId) => void;
  onOpenProcesses: () => void;
  /** Opens the command palette (the search-style trigger in the middle of the bar). */
  onOpenPalette: () => void;
};

export type StatusBarProps = {
  layout: ShellLayoutState;
  onTogglePane: (pane: PaneId) => void;
  shortcuts: ShortcutInfo[];
  /** Short validate result, e.g. `validate: 3 problems`. */
  validateStatus: string;
  /** How many characters the longest text that readout can show takes. The
   * button reserves that much from the start, so a background result landing
   * cannot resize its own hit area (#252). */
  validateStatusChars?: number;
  onOpenDiagnostics: () => void;
};


export type ProjectInfoPanelProps = {
  dir: string | null;
  screenLabel: string | null;
  modelStatus: ModelStatus;
  shortcuts: ShortcutInfo[];
};

export type ShellPageProps = NarrowProps & {
  /** Focus mode (#456) — see ShellLayoutProps. */
  focus?: boolean;
  children: ReactNode;
  layout: ShellLayoutState;
  limits: Record<PaneId, PaneLimit>;
  onResize: (pane: PaneId, size: number) => void;
  onTogglePane: (pane: PaneId) => void;
  screens: PrimaryScreen[];
  activeScreenId: string | null;
  /** Little counts beside a screen's name, by screen id (Git: the branches under review). Absent or 0 shows none. */
  screenBadges?: Record<string, number>;
  railCollapsed: boolean;
  onToggleRail: () => void;
  projectSwitcher: ReactNode;
  /** The signed-in account slot (#278) — see TopBarProps. */
  userMenu?: ReactNode;
  modelStatus: ModelStatus;
  runningProcesses: number;
  /** The framework is working (a command, the Import Wizard or a Process): the brand mark animates only then. */
  working: boolean;
  onOpenProcesses: () => void;
  onOpenPalette: () => void;
  validateStatus: string;
  /** See StatusBarProps. */
  validateStatusChars?: number;
  onOpenDiagnostics: () => void;
  shortcuts: ShortcutInfo[];
  tabs: Record<ShellRegion, ShellTab[]>;
  activeTabs: Record<ShellRegion, string | null>;
  onSelectTab: (region: ShellRegion, id: string) => void;
};

export type ShellMode =
  /** Project state not known yet: neutral frame, no flash of the wrong one. */
  | 'loading'
  /** No project open, route needs one: the full-screen gate. */
  | 'gate'
  /** No project open, route is a profile-menu page: it renders alone under the minimal top bar. */
  | 'page'
  /** A project is open: the full shell. */
  | 'full';
