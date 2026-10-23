import { describe, expect, it } from 'vitest';

interface InitializeResponse {
  id: number;
  result?: { capabilities: { textDocumentSync?: number }; serverInfo?: { name: string } };
  error?: { message: string };
}

// Starts the browser entry point in a real Web Worker and completes the LSP handshake.
describe('language server in a browser worker', () => {
  it('answers initialize', async () => {
    const worker = new Worker(new URL('./browser.ts', import.meta.url), { type: 'module' });
    try {
      const response = await new Promise<InitializeResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer within 15 s')), 15_000);
        worker.onmessage = (event: MessageEvent<InitializeResponse>) => {
          if (event.data.id === 1) {
            clearTimeout(timer);
            resolve(event.data);
          }
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { processId: null, rootUri: null, capabilities: {} },
        });
      });
      expect(response.error).toBeUndefined();
      expect(response.result?.serverInfo?.name).toBe('PLC Studio');
      expect(response.result?.capabilities.textDocumentSync).toBe(2);
    } finally {
      worker.terminate();
    }
  });
});
