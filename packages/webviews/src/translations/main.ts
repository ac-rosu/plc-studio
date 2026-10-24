// Entry of the translation table view.
import { onMessage, post, ready } from '../shared/messaging.ts';
import { renderBlocks, type FileModel } from '../tables-common/blocks.ts';
import { problemBar } from '../tables-common/grid.ts';
import { renderTranslations, type TranslationModel } from './view.ts';

const root = document.getElementById('root')!;
const problems = problemBar();
document.body.prepend(problems.element);
onMessage((m) => {
  if (m.type === 'update')
    renderBlocks(
      root,
      m['model'] as FileModel<TranslationModel>,
      renderTranslations,
      post,
      (b) => b.blockName,
    );
  else if (m.type === 'problem' || m.type === 'error') problems.show(String(m['message']));
});
ready();
