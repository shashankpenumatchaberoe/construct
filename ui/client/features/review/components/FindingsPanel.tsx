import type { KeyboardEvent } from 'react';
import type { FindingRow, FindingsPanelProps } from '../types';

/** Arrow keys move between findings; Enter (the button's own behaviour) opens one. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const all = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button.rv-finding'));
  const at = all.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  e.preventDefault();
  all[Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

function Row({ row, mark, kind, onSelect }: { row: FindingRow; mark: string; kind: 'mechanical' | 'conversation'; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className="rv-finding" aria-current={row.selected ? 'true' : undefined} data-testid="review-finding" data-kind={kind} data-finding={row.id} onClick={() => onSelect(row.id)}>
        <span className="rv-finding-mark" aria-hidden="true">{mark}</span>
        <span className="rv-finding-body">
          <span className="rv-finding-meta">{row.indicatorTitle} · {row.severityLabel}{row.location ? ` · ${row.location}` : ''}</span>
          <span className="rv-finding-title">{row.title}</span>
          {row.fix && (
            <span className="rv-fix" data-testid="review-finding-fix" data-available={row.fix.available ? 'yes' : 'no'}>
              {row.fix.available && row.fix.command ? (
                <><strong>Fix:</strong> <code>{row.fix.command}</code></>
              ) : (
                <span className="rv-fix-none">No automated fix yet</span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * Tools pane, Findings tab (#315): two groups that are never blurred. "Can be fixed mechanically" carries
 * the exact Construct command; "Needs a decision" carries no fix affordance of any kind.
 */
export function FindingsPanel({ view, onSelect }: FindingsPanelProps) {
  if (view.total === 0) {
    return (
      <div className="rv-side" data-testid="review-findings" data-empty="true">
        <div className="dg-empty">
          <p className="dg-empty-title">No findings on this change</p>
          <p className="hint">Every check ran and found nothing to fix or to talk about. Nothing here needs a decision.</p>
        </div>
        <p className="rv-hint">Read-only: nothing on this page changes your branch.</p>
      </div>
    );
  }
  return (
    <div className="rv-side" data-testid="review-findings" onKeyDown={moveFocus}>
      <p className="rv-lede" data-testid="review-findings-summary">{view.summary}</p>
      <section aria-labelledby="rv-g-mech" data-testid="review-group-mechanical">
        <h3 id="rv-g-mech" className="rv-group rv-group--mechanical"><span aria-hidden="true">✓ </span>Can be fixed mechanically <span className="rv-count">{view.mechanical.length}</span></h3>
        <p className="rv-hint">Construct has a command that makes each of these changes with no model involved.</p>
        {view.mechanical.length === 0 ? <p className="rv-hint" data-testid="review-group-empty">None here.</p> : (
          <ul className="rv-findings-list" aria-label="Findings that can be fixed mechanically">
            {view.mechanical.map((r) => <Row key={r.id} row={r} mark="✓" kind="mechanical" onSelect={onSelect} />)}
          </ul>
        )}
      </section>
      <section aria-labelledby="rv-g-conv" data-testid="review-group-conversation">
        <h3 id="rv-g-conv" className="rv-group rv-group--conversation"><span aria-hidden="true">◆ </span>Needs a decision <span className="rv-count">{view.conversation.length}</span></h3>
        <p className="rv-hint">No mechanical fix exists. These change what the code means, so they are a conversation with the author.</p>
        {view.conversation.length === 0 ? <p className="rv-hint" data-testid="review-group-empty">None here.</p> : (
          <ul className="rv-findings-list" aria-label="Findings that need a decision">
            {view.conversation.map((r) => <Row key={r.id} row={r} mark="◆" kind="conversation" onSelect={onSelect} />)}
          </ul>
        )}
      </section>
      <p className="rv-hint" data-testid="review-readonly">Read-only: nothing here applies a fix, posts or edits a branch. Run a command yourself when you are ready.</p>
    </div>
  );
}
