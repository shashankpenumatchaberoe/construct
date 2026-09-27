import { getJson, postJson } from '@/lib/http';
import type { NavView } from '../types';

// Server-side confinement lives in ui/server/src/projectNav.mjs: the first view is a page (pages/ guard),
// every later hop names a reference in a file and the server derives the target. Never a path to read.
export const getNavPage = (feature: string, file: string) =>
  getJson<NavView>(`/api/nav/page?feature=${encodeURIComponent(feature)}&file=${encodeURIComponent(file)}`);

// #328: a row of the Flow view. The server only opens a path that is one of the files that feature's flow draws.
export const getNavFile = (feature: string, file: string) =>
  getJson<NavView>(`/api/nav/file?feature=${encodeURIComponent(feature)}&path=${encodeURIComponent(file)}`);

export const openNavReference =(from: string, ref: string, start: number) => postJson<NavView>('/api/nav/open', { from, ref, start });

// #558: the live preview's "Show in source" -- a bare file + position already known client-side
// (the framed app's own error stack), no `from` file or reference name to derive a target from.
export const openNavSource = (file: string, line: number | null, column: number | null) =>
  postJson<NavView>('/api/nav/open', { file, line, column });
