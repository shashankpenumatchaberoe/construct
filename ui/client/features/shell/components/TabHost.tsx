'use client';

import { badgeText } from '../domain/TabRegistry';
import { useTabHost } from '../hooks/useTabHost';
import type { TabHostProps } from '../types';

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
/** The id prefix a region's tab buttons and panel share, e.g. `sh-browser`. RailSubTabs (#683)
 * uses the same function so a tablist rendered up in the rail column still lines up with the
 * panel TabHost renders in the pane below. */
export const tabHostPrefix = (label: string) => `sh-${slug(label)}`;

/** Renders a region's registered tabs (id, title, badge, render): an ARIA
 * tablist plus the active tab's panel. Knows nothing about what the tabs
 * contain, so any feature can register into it. */
export function TabHost({ label, tabs, activeId, onSelect, empty, hideList }: TabHostProps) {
  const { active, listRef, onKeyDown } = useTabHost(tabs, activeId, onSelect);
  const prefix = tabHostPrefix(label);
  // No tab at all (a screen with nothing to browse): just the designed empty state, not an empty tablist.
  const hasTabs = tabs.length > 0;
  return (
    <div className="sh-tabhost" data-testid={`tabhost-${slug(label)}`}>
      {hasTabs && !hideList && (
      <div role="tablist" aria-label={label} className="sh-tablist" ref={listRef}>
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
              disabled={tab.disabled}
              className="sh-tab"
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => onKeyDown(e, tab.id)}
            >
              {tab.title}
              {/* A declared badge keeps its room whether or not it has a value
                  yet, so background work landing cannot shove the tabs after
                  this one sideways (#252). */}
              {tab.badge !== undefined &&
                (tab.badge === null ? (
                  <span className="sh-badge sh-badge--reserved" aria-hidden="true" />
                ) : (
                  <span className="sh-badge" aria-label={`${badgeText(tab.badge)} ${tab.title}`}>
                    {badgeText(tab.badge)}
                  </span>
                ))}
            </button>
          );
        })}
      </div>
      )}
      <div
        role={hasTabs ? 'tabpanel' : 'region'}
        id={`${prefix}-panel`}
        aria-label={hasTabs ? undefined : label}
        aria-labelledby={active ? `${prefix}-tab-${active.id}` : undefined}
        tabIndex={0}
        className="sh-tabpanel"
      >
        {active ? active.render() : (empty ?? <p className="sh-empty">Nothing here yet.</p>)}
      </div>
    </div>
  );
}
