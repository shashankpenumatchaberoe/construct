import { useState } from 'react';
import type { LivePreviewView } from '../types';

/** The exact line the target app adds to its Vite config so clicks can be traced back to source. */
export const PLUGIN_LINE = 'plugins: [constructPreview(), react()]';

/** Two cards about the framed app itself (not the server): the preview plugin is not loaded, and the app threw.
 * Neither hides the frame: the app is still there, tree, impact and source keep working. */
export function LivePreviewNotes(props: Pick<LivePreviewView, 'plugin' | 'appError' | 'appErrorSrc' | 'onDismissAppError' | 'onShowInSource'>) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(PLUGIN_LINE).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <>
      {props.plugin === 'off' && (
        <div className="live-preview-note live-preview-note--warn" data-testid="preview-plugin-off" role="status">
          <b>Click-to-source is off</b>
          <p>Your app does not load the Cockpit preview plugin. Tree, impact and source still work.</p>
          <code>{PLUGIN_LINE}</code>
          <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy line'}</button>
        </div>
      )}
      {props.appError && (
        <div className="live-preview-note live-preview-note--danger" data-testid="preview-app-error" role="alert">
          <b>App error in the preview</b>
          <p>The app threw: {props.appError}</p>
          {/* #558: only when the error's stack has a project frame -- a library-only stack has nowhere to show. */}
          {props.appErrorSrc && (
            <button type="button" onClick={() => props.onShowInSource(props.appErrorSrc as string)}>Show in source</button>
          )}
          <button type="button" onClick={props.onDismissAppError}>Dismiss</button>
        </div>
      )}
    </>
  );
}
