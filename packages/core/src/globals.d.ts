// The few Web APIs core uses. Core is typed without DOM or Node typings (ADR 0006), so only
// what is declared here is available; both browsers and Node provide these.

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

declare class TextDecoder {
  constructor(label?: string, options?: TextDecoderOptions);
  decode(input?: Uint8Array): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
