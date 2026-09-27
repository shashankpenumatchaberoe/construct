// Pure (DOMAIN-001): what the live preview panel is handed to draw (#456).
// Types only — the frame box and the size readout arrive already computed
// (see PreviewFrameStyle.ts), so the panel itself stays presentation.
import type { Ref } from 'react';

/** What we know about the preview address: nothing yet, being probed, answering, or refusing. */
export type PreviewReach = 'unknown' | 'checking' | 'up' | 'down';

/** Has the target app said it loads the Cockpit preview plugin? `waiting` until it does or we give up; `off` means
 * the server answers but never announced it, so click-to-source cannot work (#378). */
export type PreviewPlugin = 'unknown' | 'waiting' | 'on' | 'off';

export type LivePreviewView = {
  draft: string;
  onDraftChange: (v: string) => void;
  url: string | null;
  message: string | null;
  frameRef: Ref<HTMLIFrameElement>;
  onConnect: () => void;
  onDisconnect: () => void;
  /** Whether the dev server answered, and the two ways past a "no" (probe again / show it regardless). */
  reach: PreviewReach;
  onRetry: () => void;
  onLoadAnyway: () => void;
  /** Plugin state and the app's last uncaught error (the spec's "Click-to-source is off" and "App error" cards). */
  plugin: PreviewPlugin;
  appError: string | null;
  /** #558 -- the error's stack's top project frame, `data-cx-src`-shaped ("file:line:col"), or null when
   * the stack has no project frame (a library-only stack): the "Show in source" button shows only then. */
  appErrorSrc: string | null;
  onDismissAppError: () => void;
  onShowInSource: (src: string) => void;
  /** Device size picker: the chosen id, the options, and the change handler. */
  size: string;
  sizes: { id: string; label: string; title: string }[];
  onSize: (id: string) => void;
  /** The frame's box for the chosen size, and its real measured size (`1280 x 720 px`). */
  frameStyle: { width: string; maxWidth: string };
  sizeReadout: string;
  boxRef: (node: HTMLDivElement | null) => void;
  /** Full screen: the Cockpit chrome is hidden and the app owns the viewport. */
  fullScreen: boolean;
  onFullScreen: () => void;
  onExitFullScreen: () => void;
  fullScreenRef: Ref<HTMLButtonElement>;
};
