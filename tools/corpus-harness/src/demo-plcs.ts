// The PLCs of the demo workspace (npm run demo), laid out like the owner's projects: external
// sources for SCL blocks, data blocks and PLC data types, SIMATIC SD documents for LAD/FBD blocks
// (the corpus's "source" variant). Clean and analyzer cases only, plus a few broken cases so the
// checker has something to show.
import { assemblePlcs, loadCases, type CorpusPlc } from './corpus.ts';

/** Broken cases worth seeing: an undeclared variable, a wrong parameter, recursion, an open box input. */
export const SHOWCASE_ERRORS = ['B01', 'B04', 'B13', 'B19'];

export function demoPlcs(corpusRoot: string): CorpusPlc[] {
  const cases = loadCases(corpusRoot, 'V21').filter(
    (c) => c.expected.kind !== 'broken' || SHOWCASE_ERRORS.includes(c.expected.caseId),
  );
  return assemblePlcs(cases, 'source');
}
