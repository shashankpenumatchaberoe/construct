'use client';

import { badgeText } from '../domain/TabRegistry';
import { tabHostPrefix } from './TabHost';
import { useTabHost } from '../hooks/useTabHost';
import type { RailSubTabsProps } from '../types';

/** The active screen's registered browser-region tabs (e.g. Features/Notes), stacked as more
 * vertical entries directly beneath the primary rail instead of a horizontal strip inside the
 * Browser pane's own header (#683). Same column, same look as the rail links above them (reuses
 * `.sh-rail-link`) so the merged column reads as one continuous menu, not two stitched together.
 *
 * Renders nothing when the active screen registers no browser tabs, so no empty divider shows
 * for a screen with nothing to switch between. The buttons keep the exact ids TabHost used to
 * render for its own tablist (`tabHostPrefix`), so the Browser pane's panel -- which now renders
 * with `hideList` and no tablist of its own -- still has a `aria-labelledby` target that exists,
 * just elsewhere in the DOM; ARIA does not require the two to be adjacent. */
export function RailSubTabs({ label, tabs, activeId, onSelect }: RailSubTabsProps) {
  const { active, listRef, onKeyDown } = useTabHost(tabs, activeId, onSelect);
  if (tabs.length === 0) return null;
  const prefix = tabHostPrefix(label);
  return (
    <div role="tablist" aria-label={label} className="sh-rail-subtabs" ref={listRef} data-testid="rail-subtabs">
      {tabs.map((tab) => {
        const selected = active?.id === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${prefix}-tab-${tab.id}`}
            data-tab-id={tab.id}
            aria-selected={selected}
            aria-controls={`${prefix}-panel`}
            tabIndex={selected ? 0 : -1}
            title={tab.title}
            disabled={tab.disabled}
            className={selected ? 'sh-rail-link sh-rail-link--sub sh-rail-link--active' : 'sh-rail-link sh-rail-link--sub'}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => onKeyDown(e, tab.id)}
          >
            <span className="sh-rail-label">{tab.title}</span>
            {/* Same reserved-badge trick as the rail links above (#252): declared but unknown
                keeps its room so a background result landing cannot shove things sideways. */}
            {tab.badge !== undefined &&
              (tab.badge === null ? (
                <span className="sh-badge sh-badge--reserved sh-rail-badge" aria-hidden="true" />
              ) : (
                <span className="sh-badge sh-rail-badge" aria-label={`${badgeText(tab.badge)} ${tab.title}`}>
                  {badgeText(tab.badge)}
                </span>
              ))}
          </button>
        );
      })}
    </div>
  );
}
