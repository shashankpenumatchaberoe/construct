import type { PlanPickerProps } from '../types';

/** Choose a saved plan as the expected scope. Choosing none is normal: scope is then simply not measured. */
export function PlanPicker({ plans, selected, selectedTitle, onPick }: PlanPickerProps) {
  const known = selected !== null && plans.some((p) => p.id === selected);
  return (
    <div className="rv-plan" data-testid="review-plan-picker">
      <label className="rv-plan-label" htmlFor="rv-plan-select">Compare with a plan</label>
      <select id="rv-plan-select" value={selected ?? ''} onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)} data-testid="review-plan-select">
        <option value="">No plan (scope not measured)</option>
        {selected !== null && !known && <option value={selected}>{selectedTitle ?? selected}</option>}
        {plans.map((p) => <option key={p.id} value={p.id}>{p.title} ({p.features.length === 0 ? 'no features' : p.features.join(', ')})</option>)}
      </select>
      {plans.length === 0 && <span className="rv-hint" data-testid="review-plan-none">No saved plans in this project yet. Plans come from running a plan on the Features screen.</span>}
    </div>
  );
}
