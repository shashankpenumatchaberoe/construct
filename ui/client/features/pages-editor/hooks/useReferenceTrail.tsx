'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { Dispatch } from 'react';
import { unlinkedReferences } from '../domain/CodeLinks';
import { canBack, canForward } from '../domain/TrailAvailability';
import { foldTrail } from '../domain/TrailFold';
import { currentStep } from '../domain/TrailSteps';
import { getNavPage, openNavReference, openNavSource } from '../services/ReferenceNavApi';
import { subscribeOpenSource } from '../services/OpenSourceRequest';
import type { NavReference, NavView } from '../types';
import { initialReferenceNavigation, referenceNavigationReducer } from '../workflows/ReferenceNavigation';
import type { ReferenceNavigationAction } from '../workflows/ReferenceNavigation';
import { useTrailShortcuts } from './useTrailShortcuts';

/** Reads the first view of a trail: a page of the editor (the default), or a file the Flow view drew (#328). */
export type RootLoader = (feature: string, file: string) => Promise<NavView>;

/** Reads the open page's references from the server: a fresh trail for a new file, and only the first
 * step replaced when the same file is re-read after a save (the hops already taken stay). */
function useOpenPage(feature: string, file: string, contentHash: string, dispatch: Dispatch<ReferenceNavigationAction>, loadRoot: RootLoader): void {
  const openKey = useRef('');
  useEffect(() => {
    if (!feature || !file) {
      openKey.current = '';
      dispatch({ type: 'RESET' });
      return;
    }
    const key = `${feature}/${file}`;
    const sameFile = openKey.current === key;
    openKey.current = key;
    let cancelled = false;
    if (!sameFile) dispatch({ type: 'LOADING' });
    loadRoot(feature, file)
      .then((view) => {
        if (cancelled) return;
        if (typeof view.source !== 'string') dispatch({ type: 'LOAD_FAILED', error: view.error || 'Could not read this page.' });
        else dispatch({ type: sameFile ? 'ROOT_REFRESHED' : 'ROOT_LOADED', view });
      })
      .catch((e: Error) => {
        if (!cancelled) dispatch({ type: 'LOAD_FAILED', error: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [feature, file, contentHash, dispatch, loadRoot]);
}

/**
 * Click-to-navigate for the Pages editor (#321): the open page is the first step of a trail; following a
 * resolved reference opens its file as the next step; Alt+Left / Alt+Right walk the trail. References are
 * resolved by the server once per file render, so every reference this hands out either has a target or
 * is never offered as a link.
 */
export function useReferenceTrail(feature: string, file: string, contentHash: string, loadRoot: RootLoader = getNavPage) {
  const [state, dispatch] = useReducer(referenceNavigationReducer, initialReferenceNavigation);
  useOpenPage(feature, file, contentHash, dispatch, loadRoot);
  const { trail } = state;
  const step = currentStep(trail);

  const follow = useCallback(
    (ref: NavReference) => {
      if (!step || ref.target === null) return;
      openNavReference(step.view.path, ref.name, ref.start)
        .then((view) => {
          if (typeof view.source !== 'string') dispatch({ type: 'HOP_FAILED', error: view.error || `Could not open ${ref.name}.` });
          else dispatch({ type: 'FOLLOWED', step: { name: ref.name, relation: view.relation ?? ref.relation ?? null, view } });
        })
        .catch((e: Error) => dispatch({ type: 'HOP_FAILED', error: e.message }));
    },
    [step],
  );
  const back = useCallback(() => dispatch({ type: 'BACK' }), []);
  const forward = useCallback(() => dispatch({ type: 'FORWARD' }), []);
  const select = useCallback((index: number) => dispatch({ type: 'GOTO', index }), []);
  useTrailShortcuts(canBack(trail), canForward(trail), back, forward);

  // #558: the live preview's "Show in source" -- opens a bare file at a known position as a new trail
  // step, the same way following a reference does, but with no reference name to resolve a target from.
  const openSource = useCallback((file: string, line: number | null, column: number | null) => {
    openNavSource(file, line, column)
      .then((view) => {
        if (typeof view.source !== 'string') dispatch({ type: 'HOP_FAILED', error: view.error || `Could not open ${file}.` });
        else dispatch({ type: 'FOLLOWED', step: { name: file, relation: view.relation ?? null, view } });
      })
      .catch((e: Error) => dispatch({ type: 'HOP_FAILED', error: e.message }));
  }, []);
  useEffect(() => subscribeOpenSource(({ file, line, column }) => openSource(file, line, column)), [openSource]);

  return {
    steps: trail.steps,
    index: trail.index,
    items: foldTrail(trail),
    unlinked: step ? unlinkedReferences(step.view.references) : [],
    current: step,
    loading: state.loading,
    error: state.error,
    hopError: state.hopError,
    follow,
    openSource,
    back,
    forward,
    select,
  };
}
