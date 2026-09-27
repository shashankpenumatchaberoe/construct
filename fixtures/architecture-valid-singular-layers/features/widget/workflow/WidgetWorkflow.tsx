import { setup } from 'xstate';
import { fetchWidget } from '../service/WidgetService';

export const WidgetWorkflow = setup({}).createMachine({
  id: 'widget',
  initial: 'idle',
  states: { idle: {} },
});

export { fetchWidget };
