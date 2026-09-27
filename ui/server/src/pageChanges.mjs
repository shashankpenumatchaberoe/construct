// #224 — thin glue between the core change tracker (src/file-change-tracker.mjs),
// the core diff view model (src/text-diff.mjs) and the Pages Editor routes.
// Path scoping stays in pagesEditor.mjs's resolvePageFile (callers pass the
// already-validated absPath/relPath); this module never resolves paths itself.
import fs from 'node:fs';
import { createChangeTracker } from '../../../packages/core/file-change-tracker.mjs';
import { buildDiffView } from '../../../packages/core/text-diff.mjs';

export const pageChangeTracker = createChangeTracker();

// #538: keyed by absPath, not the project-relative path. Two different projects can
// legitimately have the same feature/file (say, both scaffolded "auth"/LoginPage.tsx"), and
// this tracker is a single process-lifetime singleton shared across every project a session
// opens. Keying by relPath alone made opening project B's file collide with a baseline left
// behind by project A's identical relPath, reporting a phantom "external change" the moment
// the tree loaded. absPath already bakes the project root in, so same-name files in different
// projects get their own snapshot.

/** Observe the file's current disk content and describe its last external
 * change (or null). The change is per-file (by absolute path) and persists
 * until dismissed or until the editor itself saves the file. */
export function describePageChange(absPath, tracker = pageChangeTracker) {
  tracker.observe(absPath, fs.readFileSync(absPath, 'utf8'));
  const change = tracker.getLastChange(absPath);
  if (!change) return { change: null };
  const { rows, stats } = buildDiffView(change.before, change.after);
  return {
    change: { at: change.at, beforeHash: change.beforeHash, afterHash: change.afterHash, stats, rows },
  };
}

/** Called by the editor's own save path so its writes are never reported as external. */
export function adoptOwnWrite(absPath, content, tracker = pageChangeTracker) {
  tracker.adopt(absPath, content);
}
