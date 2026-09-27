/** What the live preview panel is handed to draw, and what it knows about the
 * preview address (#456). Declared in domain/, re-exported here so the panel and
 * its parts take it as props without reaching into another layer. */
export type * from './domain/LivePreviewView';

export type PagesEditorId = string;

export type PropKind = 'string' | 'number' | 'boolean' | 'identifier' | 'expression' | 'spread';

// #77 follow-up to #53 — `name` is null for a spread prop (`{...rest}` has
// no attribute name); `index` is its 0-based position in the opening tag's
// attribute list, needed to identify *which* spread to edit server-side
// since name-based lookup doesn't work for it (see PropsApi.tsx).
export type PropData = { name: string | null; kind: PropKind; value: unknown; index: number };

export type PagesEditorNode = {
  id: string;
  tag: string;
  isFragment: boolean;
  isCustomComponent: boolean;
  props: PropData[];
  /** 1-based source position of the element's `<` (same values the core annotator writes into data-cx-src). */
  line?: number;
  column?: number;
  children: PagesEditorNode[];
};

export type PageTree = { roots: PagesEditorNode[]; contentHash: string };

// Source view (Monaco adapter contract + diagnostics), editor-neutral.
export type DiagnosticSource = 'typescript' | 'architecture' | 'separation-of-concerns';
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** One diagnostic as returned by GET /api/pages/source (1-based positions). */
export type SourceDiagnostic = {
  source: DiagnosticSource;
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
};

/** Editor-neutral marker (1-based, end exclusive), message pre-labelled. */
export type SourceMarker = {
  severity: DiagnosticSeverity;
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  code: string;
  source: DiagnosticSource;
};

export type DiagnosticSummary = { errors: number; warnings: number; infos: number; total: number };

/** The whole contract an editor adapter implements (Monaco, textarea, ...).
 * `onChange` is optional: omit it (with readOnly) for a viewer. */
export type SourceEditorProps = {
  value: string;
  markers: SourceMarker[];
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** Accessible label / stable test hook. */
  label?: string;
};

export type Violation = { rule: string; severity: string; message: string };

export type SaveOutcome = { ok: boolean; error?: string; violations?: Violation[] };

export type StatusMessage = { ok: boolean; message: string; violations?: Violation[] };

// #223 scope/binding links: the server graph (core buildScopeLinks) and the view model derived from it.
// #528 widens this with two more real scope sources buildScopeLinks() now also walks (additive —
// 'prop'/'state'/'setter' keep their exact existing meaning): 'provider' is a field a reachable
// ProviderUnit exposes via useProvider() (packages/core/typed-contracts/provider.ts, PAGE-006/
// HOOK-002's import convention), 'unit-output' is a local binding already destructured from an
// already-called tracked-state hook (packages/core/typed-contracts/trackedState.ts, HOOK-001).
export type ScopeDeclKind = 'prop' | 'state' | 'setter' | 'provider' | 'unit-output';

export type ScopeLinkGraph = {
  nodeId: string;
  tag: string;
  isCustomComponent: boolean;
  scope: { name: string; kind: ScopeDeclKind }[];
  links: { prop: string; valueKind: 'literal' | 'identifier' | 'expression'; text: string; from: { name: string; kind: ScopeDeclKind }[] }[];
  spreads: { text: string; from: { name: string; kind: ScopeDeclKind }[] }[];
  childProps: { name: string; status: 'bound' | 'spread' | 'unbound' }[] | null;
  undeclared: string[];
  suggestions: string[];
  unusedScope: string[];
  childPropsResolved: boolean;
  // #534 -- sibling type maps (name -> type text), deliberately NOT folded into `scope`/`childProps`'
  // own item shape above so that shape stays exactly what it always was. A name absent from the map
  // means its type isn't known (never a guess); see packages/engine/scopeLinks.mjs's own jsdoc.
  scopeTypes: Record<string, string>;
  childPropTypes: Record<string, string>;
};

export type ScopeSourceItem = {
  name: string;
  kind: ScopeDeclKind;
  color: string;
  linked: boolean;
  unusedInPage: boolean;
  /** #534 -- best-effort real type text (e.g. `'string'`), or `null` when not known. */
  type: string | null;
};

export type ScopeTargetStatus = 'bound' | 'literal' | 'unbound' | 'spread' | 'undeclared';

export type ScopeTargetItem = {
  prop: string;
  status: ScopeTargetStatus;
  /** How the value is written, e.g. `count + 1`, `"hi"`; empty for props nobody passes. */
  text: string;
  /** Colour of the first linked source, or null when the prop is not fed by a scope name. */
  color: string | null;
  /** True when the (closed) child declares this prop. */
  declared: boolean;
  /** #534 -- this prop's own declared type text (from the child's Props), or `null` when not known. */
  type: string | null;
};

export type ScopeEdge = { from: string; to: string; color: string };

export type ScopeFlag = { level: 'warn' | 'info'; text: string };

export type ScopeView = {
  tag: string;
  sources: ScopeSourceItem[];
  targets: ScopeTargetItem[];
  edges: ScopeEdge[];
  flags: ScopeFlag[];
  childPropsResolved: boolean;
};

/** One contiguous run of unchanged/added/removed lines from a before/after
 * diff (#81) — `added`/`removed` both falsy means unchanged context. */
export type DiffHunk = { value: string; added?: boolean; removed?: boolean };

/** One row of a rendered before/after diff (#224), pre-computed server-side. */
export type DiffRow = {
  kind: 'context' | 'added' | 'removed' | 'gap';
  oldLine?: number;
  newLine?: number;
  text: string;
  hidden?: number;
};

/** A page file last external (on-disk, non-editor) change (#224). */
export type PageChange = {
  at: number;
  beforeHash: string;
  afterHash: string;
  stats: { added: number; removed: number };
  rows: DiffRow[];
};

/** How two files relate, labelled by layer (`page -> component`) and, across features, by feature (#321). */
export type NavRelation = {
  label: string;
  layers: string;
  fromLayer: string | null;
  toLayer: string | null;
  fromFeature: string | null;
  toFeature: string | null;
  crossFeature: boolean;
  description: string;
};

/** One reference in a file as the server resolved it when the file was drawn. `target` is a
 * project-root-relative path, or null when it does not lead to a file inside the project (#321). */
export type NavReference = {
  name: string;
  kind: 'import' | 'jsx' | 'dynamic';
  start: number;
  end: number;
  line: number;
  column: number;
  target: string | null;
  reason: string | null;
  relation?: NavRelation;
};

/** A file the navigator shows: its source and every reference in it, already resolved (#321). */
export type NavView = {
  ok?: boolean;
  error?: string;
  path: string;
  source: string;
  references: NavReference[];
  name?: string;
  relation?: NavRelation;
  /** #558 -- set when this view was opened at a known position (the live preview's "Show in source"),
   * not by following a reference; null/absent otherwise. */
  line?: number | null;
  column?: number | null;
};

/** One hop in the trail: what was clicked, how it relates to the hop before, and what it shows. */
export type TrailStep = { name: string; relation: NavRelation | null; view: NavView };

export type Trail = { steps: TrailStep[]; index: number };

/** A run of source text; `ref` is set only for a reference that RESOLVED to a project file. */
export type CodeSegment = { text: string; ref?: NavReference };

/** What the trail draws: a step, or a fold standing in for the hidden middle steps. */
export type TrailItem = { kind: 'step'; index: number; step: TrailStep } | { kind: 'fold'; hidden: number[] };

// #527 (Slice 1 of #518's design) -- the read-only Palette tab: Providers/Expressions/Components
// this feature's pages can actually reach, computed server-side from the real canImport graph
// (packages/engine/palette.mjs). `via` is null for the feature's own unit, or the owning feature's
// name for one reached through that feature's public index.ts.
/** The chip label a Palette entry gets -- "provider" for a Provider hook (a naming convention over
 * the `hook` layer, not its own branded layer, so it stays the plain grey chip, not a new colour). */
export type PaletteChipKind = 'provider' | 'expression' | 'component';

export type PaletteEntry = { name: string; path: string; feature: string; via: string | null; description: string };

export type PaletteData = { feature: string; providers: PaletteEntry[]; expressions: PaletteEntry[]; components: PaletteEntry[] };

// #533 (Slice 3 of #518's design) -- "Wrap with...": a JSX selection resolves to a flagged
// PAGE-008 conditional/loop (or nothing, meaning no Wrap affordance for this selection), every
// Expression in scope annotated with whether it structurally fits that flagged shape
// (packages/engine/palette.mjs), and -- once a name is available -- a real dry-run preview of
// exactly what `construct refactor extract-expression` (#517) would write.
export type WrapHitKind = 'loop' | 'conditional';

export type WrapHit = { kind: WrapHitKind; range: [number, number]; line: number; subject: string | null; summary: string; rule: string };

/** `'fits'` (same structural shape as the selection), `'unknown'` (can't tell -- never dimmed), or
 * `'not-a-fit'` (concretely the other shape, dimmed with `reason` shown, per block-palette.md's
 * "never show something the architecture wouldn't allow" applied at the shape level). */
export type WrapFit = 'fits' | 'unknown' | 'not-a-fit';

export type WrapSuggestionEntry = PaletteEntry & { fit: WrapFit; reason: string | null };

export type WrapFilePreview = { file: string; name: string | null; before: string; after: string };

export type WrapSuggestion = {
  ok: boolean;
  error?: string;
  hit: WrapHit | null;
  suggestions: WrapSuggestionEntry[];
  /** The Expression name that would be used: derived from the flagged shape, or the caller's own
   * override once one is typed. `null` only when it can't be derived AND none was given yet. */
  name: string | null;
  /** `true` when the name could not be derived and none was given — the "+ New Expression" field
   * must be filled in before a preview can be requested. */
  nameRequired: boolean;
  /** A rejected/invalid given name's message (e.g. EXPR-003's generic-name rule), or null. */
  nameError: string | null;
  /** The real dry-run preview (page + new Expression + any hoisted Components), or `null` until a
   * usable name is available. Nothing here has touched disk. */
  files: WrapFilePreview[] | null;
};

export type WrapConfirmOutcome = SaveOutcome & PageTree & {
  expression: { file: string; name: string } | null;
  components: { file: string; name: string }[];
};
