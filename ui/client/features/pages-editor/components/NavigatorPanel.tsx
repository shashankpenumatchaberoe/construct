'use client';

import { GlassPanel } from '@/components/ui';
import { useReferenceTrail } from '../hooks/useReferenceTrail';
import { LinkedCode } from './LinkedCode';
import { ReferenceTrail } from './ReferenceTrail';

type NavigatorPanelProps = { feature: string; file: string; contentHash: string };

// Click-to-navigate (#321): the open page's code, with references that lead to another file in the
// project as links, and the trail of files followed. Everything opens here, in the Cockpit.
export function NavigatorPanel({ feature, file, contentHash }: NavigatorPanelProps) {
  const nav = useReferenceTrail(feature, file, contentHash);
  const { current } = nav;
  const { unlinked } = nav;

  return (
    <GlassPanel className="navigator-panel" data-testid="navigator-panel">
      <div className="navigator-header">
        <h3>Navigate</h3>
        <span className="hint">Click a link to open it here. Alt+Left goes back, Alt+Right forward.</span>
      </div>
      {nav.loading && <p className="hint">Reading references...</p>}
      {nav.error && <p className="status-error">{nav.error}</p>}
      {current && (
        <>
          <ReferenceTrail steps={nav.steps} index={nav.index} items={nav.items} onSelect={nav.select} onBack={nav.back} onForward={nav.forward} />
          <div className="navigator-file" data-testid="navigator-file">
            {current.view.path}
          </div>
          {/* #558: set only when this step was opened at a known position (the live preview's "Show in
              source"), not by following a reference -- confirms which exact line the error landed on. */}
          {typeof current.view.line === 'number' && (
            <p className="hint navigator-open-line" data-testid="navigator-open-line">Opened at line {current.view.line}</p>
          )}
          {nav.hopError && <p className="status-error">{nav.hopError}</p>}
          <LinkedCode source={current.view.source} references={current.view.references} onFollow={nav.follow} label={`Source of ${current.view.path}`} />
          {unlinked.length > 0 && (
            <div className="navigator-unlinked" data-testid="navigator-unlinked">
              <h4>Not linked here ({unlinked.length})</h4>
              <ul>
                {unlinked.map((u) => (
                  <li key={`${u.name}|${u.reason}`}>
                    <code>{u.name}</code> <span className="hint">{u.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </GlassPanel>
  );
}
