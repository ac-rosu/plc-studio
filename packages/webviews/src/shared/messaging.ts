// Messaging between a webview and the extension. Webviews never touch files or core state; they
// show what the extension sends and send back intents (spec, "Architecture").

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

function vscode(): VsCodeApi {
  api ??= acquireVsCodeApi();
  return api;
}

/** Messages every view understands. Feature messages add their own `type` values. */
export type HostMessage =
  { type: 'update'; [key: string]: unknown } | { type: string; [key: string]: unknown };

export function post(message: { type: string; [key: string]: unknown }): void {
  vscode().postMessage(message);
}

export function onMessage(handler: (message: HostMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<HostMessage>) => handler(event.data));
}

/** Tells the extension the view is ready to receive its first update. */
export function ready(): void {
  post({ type: 'ready' });
}

export function saveState(state: unknown): void {
  vscode().setState(state);
}

export function loadState<T>(): T | undefined {
  return vscode().getState() as T | undefined;
}
