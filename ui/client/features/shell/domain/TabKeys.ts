// Pure (DOMAIN-001): WAI-ARIA tablist keyboard navigation (roving focus).
import type { ShellTab } from '../types.ts';

/** The id to move to for a key press on the tab `currentId`, skipping disabled
 * tabs and wrapping; null when the key is not a tablist key. */
export function nextTabId(tabs: ShellTab[], currentId: string, key: string): string | null {
  const enabled = tabs.filter((t) => !t.disabled);
  if (enabled.length === 0) return null;
  const at = enabled.findIndex((t) => t.id === currentId);
  if (key === 'Home') return enabled[0].id;
  if (key === 'End') return enabled[enabled.length - 1].id;
  // ArrowDown/Up are aliases of Right/Left (#683): a vertical tab list (the Browser pane's
  // sub-tabs, now stacked in the rail column) needs Up/Down; a horizontal one (Tools, Drawer)
  // keeps Left/Right. Accepting both everywhere matches how RailKeys.ts already treats
  // Down/Right and Up/Left as the same move, and costs a horizontal list nothing.
  if (key === 'ArrowRight' || key === 'ArrowDown') return enabled[(at + 1) % enabled.length].id;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return enabled[(at - 1 + enabled.length) % enabled.length].id;
  return null;
}
