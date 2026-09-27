// Public API for feature: widget
export type * from './types';
// #724 -- a direct re-export of the internal component, kept here so SLICE-004 (checked against
// this project's singular `component/` folder, per architecture.yml's `layers:` override) has
// something to fire on.
export { WidgetComponent } from './component/WidgetComponent';
