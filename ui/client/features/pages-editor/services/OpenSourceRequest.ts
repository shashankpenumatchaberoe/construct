import { OPEN_SOURCE_EVENT, type OpenSourceTarget } from '../domain/OpenSource.ts';

/** Asks the already-mounted Navigator panel to open a bare project file at a known position (#558):
 * the live preview's "Show in source" button after an app error. Same shape as `OpenPageRequest.ts`. */
export function requestOpenSource(target: OpenSourceTarget): void {
  window.dispatchEvent(new CustomEvent<OpenSourceTarget>(OPEN_SOURCE_EVENT, { detail: target }));
}

/** Calls `onOpen` for every request. Returns an unsubscribe. */
export function subscribeOpenSource(onOpen: (target: OpenSourceTarget) => void): () => void {
  const handler = (e: Event) => onOpen((e as CustomEvent<OpenSourceTarget>).detail);
  window.addEventListener(OPEN_SOURCE_EVENT, handler);
  return () => window.removeEventListener(OPEN_SOURCE_EVENT, handler);
}
