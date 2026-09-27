'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PreviewPlugin } from '../domain/LivePreviewView';
import type { PreviewSource } from '../services/PreviewSource';

/** How long a preview that is answering may stay silent before "the plugin is not loaded" is said out loud.
 * Long enough for a cold dev-server page load; a late `ready` still turns it back to `on`. */
export const PLUGIN_WAIT_MS = 6000;

/**
 * What the framed app tells us about itself (#378): whether the Cockpit preview plugin loaded (the bridge posts
 * `ready` once), and the last uncaught error it threw. `active` is "the server is answering and the frame is on
 * screen"; the clock for `off` only runs then. Both reset when the preview address changes.
 */
export function usePreviewSignals(source: PreviewSource | null, active: boolean) {
  const [ready, setReady] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [appErrorSrc, setAppErrorSrc] = useState<string | null>(null);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    setReady(false);
    setAppError(null);
    setAppErrorSrc(null);
    setWaited(false);
    if (!source) return undefined;
    return source.onSignal((signal) => {
      if (signal.type === 'ready') { setReady(true); setAppError(null); setAppErrorSrc(null); } else { setAppError(signal.message); setAppErrorSrc(signal.src); }
    });
  }, [source]);

  useEffect(() => {
    if (!source || !active || ready) return undefined;
    const t = setTimeout(() => setWaited(true), PLUGIN_WAIT_MS);
    return () => clearTimeout(t);
  }, [source, active, ready]);

  const plugin: PreviewPlugin = !source ? 'unknown' : ready ? 'on' : waited ? 'off' : 'waiting';
  const dismissAppError = useCallback(() => { setAppError(null); setAppErrorSrc(null); }, []);
  return { plugin, appError, appErrorSrc, dismissAppError };
}
