// Entry of the tag table editor view.
import { onMessage, post, ready } from '../shared/messaging.ts';
import { preserveFocus, problemBar } from '../tables-common/grid.ts';
import { renderTagTable, type TagTableModel } from './view.ts';

const root = document.getElementById('root')!;
const problems = problemBar();
document.body.prepend(problems.element);
onMessage((m) => {
  if (m.type === 'update')
    preserveFocus(root, () => renderTagTable(root, m['model'] as TagTableModel, post));
  else if (m.type === 'problem' || m.type === 'error') problems.show(String(m['message']));
});
ready();
