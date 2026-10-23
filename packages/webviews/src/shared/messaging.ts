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

/**
 * Handles messages from the extension. After an update is drawn the view answers `rendered`; a
 * failure is reported as `viewError` (the extension logs both; the integration tests read them).
 */
export function onMessage(handler: (message: HostMessage) => void): void {
  window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    try {
      handler(event.data);
      if (event.data.type === 'update') post({ type: 'rendered' });
    } catch (e) {
      post({ type: 'viewError', message: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Tells the extension the view is ready to receive its first update. */
export function ready(): void {
  window.addEventListener('error', (e) => post({ type: 'viewError', message: e.message }));
  post({ type: 'ready' });
}

export function saveState(state: unknown): void {
  vscode().setState(state);
}

export function loadState<T>(): T | undefined {
  return vscode().getState() as T | undefined;
}
