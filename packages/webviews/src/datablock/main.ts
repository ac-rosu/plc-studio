// Entry of the data block editor view.
import { onMessage, post, ready } from '../shared/messaging.ts';
import { preserveFocus, problemBar } from '../tables-common/grid.ts';
import { renderDataBlock, type DataBlockModel } from './view.ts';

const root = document.getElementById('root')!;
const problems = problemBar();
document.body.prepend(problems.element);
onMessage((m) => {
  if (m.type === 'update')
    preserveFocus(root, () => renderDataBlock(root, m['model'] as DataBlockModel, post));
  else if (m.type === 'problem' || m.type === 'error') problems.show(String(m['message']));
});
ready();
