// Starts the language server's Node entry point as its own process, the way the extension does,
// and completes the LSP handshake over stdio.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const NODE_ENTRY = fileURLToPath(new URL('../../language-server/src/node.ts', import.meta.url));

function frame(message: object): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

describe('language server process', () => {
  it('answers initialize over stdio', async () => {
    const server = spawn(process.execPath, [NODE_ENTRY, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const response = await new Promise<{ result: { serverInfo: { name: string } } }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no answer within 15 s')), 15_000);
          let buffer = Buffer.alloc(0);
          server.stdout.on('data', (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            const text = buffer.toString('utf8');
            const header = /Content-Length: (\d+)\r\n\r\n/.exec(text);
            if (!header) return;
            const start = header.index + header[0].length;
            const body = buffer.subarray(Buffer.byteLength(text.slice(0, start)));
            if (body.length < Number(header[1])) return;
            clearTimeout(timer);
            resolve(JSON.parse(body.subarray(0, Number(header[1])).toString('utf8')));
          });
          server.on('error', reject);
          server.stdin.write(
            frame({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: { processId: process.pid, rootUri: null, capabilities: {} },
            }),
          );
        },
      );
      expect(response.result.serverInfo.name).toBe('PLC Studio');
    } finally {
      server.kill();
    }
  });
});
