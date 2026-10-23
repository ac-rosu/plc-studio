// Entry of the LAD/FBD view bundle (dist/webviews/ladder.js).
import { onMessage, post, ready } from '../shared/messaging.ts';
import css from './ladder.css';
import type { HostToView, ViewMessage } from './protocol.ts';
import { LadderView } from './view.ts';

const style = document.createElement('style');
style.textContent = css;
document.head.append(style);

const root = document.getElementById('root')!;
const view = new LadderView(root, (m: ViewMessage) =>
  post(m as unknown as { type: string; [key: string]: unknown }),
);
onMessage((m) => view.receive(m as unknown as HostToView));
ready();
