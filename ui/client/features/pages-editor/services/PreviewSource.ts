// The preview transport behind a small interface, so the iframe + postMessage
// implementation can be swapped (e.g. a devtools-protocol or websocket source)
// without touching the hook/component layers.
/** What the previewed app tells the Cockpit besides a selection (#378): the preview plugin is loaded (`ready`),
 * or the app threw an uncaught error (`error`). `src` (#558) is the stack's top project frame as a
 * `data-cx-src`-shaped "file:line:col" string, or null when the stack has no project frame (a library-only
 * stack shows no "Show in source" button). Nothing else crosses. */
export type PreviewSignal = { type: 'ready' } | { type: 'error'; message: string; src: string | null };

export interface PreviewSource {
  /** Page being previewed. */
  readonly url: string;
  /** Subscribe to element selections (a raw `data-cx-src` value). Returns an unsubscribe. */
  onSelect(handler: (src: string) => void): () => void;
  /** Subscribe to the plugin's `ready` and the app's `error` messages. Returns an unsubscribe. */
  onSignal(handler: (signal: PreviewSignal) => void): () => void;
}

/** iframe transport: accepts `construct:*` messages only from the given
 * iframe's window AND only from the previewed URL's origin. */
export function createIframePreviewSource(url: string, getFrameWindow: () => Window | null | undefined): PreviewSource {
  const origin = new URL(url).origin;
  /** Subscribe to the frame's messages; `pick` turns one into a value, or `null` to ignore it. */
  const subscribe = <T,>(pick: (d: { type?: unknown; src?: unknown; message?: unknown }) => T | null, handler: (v: T) => void) => {
    const listener = (e: MessageEvent) => {
      if (e.origin !== origin) return;
      const frame = getFrameWindow();
      if (!frame || e.source !== frame) return;
      const d = e.data as { type?: unknown; src?: unknown; message?: unknown } | null;
      const v = d ? pick(d) : null;
      if (v !== null) handler(v);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  };
  return {
    url,
    onSelect: (handler) => subscribe((d) => (d.type === 'construct:select' && typeof d.src === 'string' ? d.src : null), handler),
    onSignal: (handler) => subscribe<PreviewSignal>((d) => {
      if (d.type === 'construct:ready') return { type: 'ready' };
      if (d.type === 'construct:error') {
        return {
          type: 'error',
          message: typeof d.message === 'string' ? d.message.slice(0, 300) : 'Unknown error',
          src: typeof d.src === 'string' ? d.src : null,
        };
      }
      return null;
    }, handler),
  };
}
