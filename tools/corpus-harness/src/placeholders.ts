// Stand-ins until M1 brings the real parsers and M3 the checker.
import type { Checker, HarnessDiagnostic, Printer } from './gates.ts';

/**
 * Decodes the file as strict UTF-8 (keeping a BOM) and encodes it again. Proves the corpus is
 * valid UTF-8 and that text decoding loses nothing; the M1 parsers replace it.
 */
export const textPrinter: Printer = {
  name: 'placeholder: UTF-8 decode/encode',
  roundTrip(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return new TextEncoder().encode(text);
  },
};

/** Reports nothing: the gates run, error coverage is zero. */
export const silentChecker: Checker = {
  name: 'placeholder: no checks',
  check: async (): Promise<HarnessDiagnostic[]> => [],
};
