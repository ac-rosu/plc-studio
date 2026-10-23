// Entry of the program graph panel.
import { onMessage, post, ready } from '../shared/messaging.ts';
import type { GraphModel } from './layout.ts';
import { createGraphView } from './view.ts';

const view = createGraphView(document.getElementById('root')!, post);
onMessage((m) => {
  if (m.type === 'update') view.update(m['model'] as GraphModel);
});
ready();
