// Pure (DOMAIN-001): a request to open a bare project file at a known position in the Navigator
// (#558), e.g. the live preview's "Show in source" button after an app error. Same in-page-event shape
// as OpenPage.ts -- the Navigator is already mounted, so a route push would not remount it.
import { parseCxSrc } from './CxSrc.ts';

export type OpenSourceTarget = { file: string; line: number | null; column: number | null };

/** Event name used when the Navigator is already on screen. */
export const OPEN_SOURCE_EVENT = 'construct:open-source';

/** A `data-cx-src`-shaped "file:line:col" string (the preview bridge's `construct:error` src) as an
 * `OpenSourceTarget`, or null when it doesn't parse. */
export function openSourceTargetFromCxSrc(src: string): OpenSourceTarget | null {
  const parsed = parseCxSrc(src);
  return parsed ? { file: parsed.file, line: parsed.line, column: parsed.column } : null;
}
