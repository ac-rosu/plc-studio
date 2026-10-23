import { describe, expect, it } from 'vitest';
import { Project } from '../model/project.ts';
import { analyzeProject } from './analysis.ts';

const crlf = (...lines: string[]) => lines.join('\r\n') + '\r\n';

// like corpus C02: one text of a bilingual file lacks its de-DE translation (MLC_4DE)
const BILINGUAL = crlf(
  'MultiLingualTexts:',
  '  - id: MLC_3yS',
  '    de-DE: Maschine eingeschaltet',
  '    en-US: Machine switched on',
  '  - id: MLC_4DE',
  '    en-US: Last recipe, retentive',
);
const ENGLISH = crlf(
  'MultiLingualTexts:',
  '  - id: MLC_1',
  '    en-US: Start',
  '  - id: MLC_2',
  '    en-US: Stop',
);

function project(languages?: string[]): Project {
  const p = new Project('/plc');
  p.setManifest(
    '/plc/plc.json',
    JSON.stringify({
      name: 'P',
      cpu: { family: 'S7-1500' },
      tiaVersion: 'V21',
      ...(languages ? { languages } : {}),
    }),
  );
  p.setFileText('/plc/DB_Machine.s7res', BILINGUAL);
  p.setFileText('/plc/FB_Other.s7res', ENGLISH);
  return p;
}

const missing = (p: Project) =>
  [...analyzeProject(p).diagnostics.entries()].flatMap(([file, list]) =>
    list
      .filter((d) => d.code === 'missing-translation')
      .map((d) => `${file.slice(file.lastIndexOf('/') + 1)}: ${d.message}`),
  );

describe('missing translations', () => {
  it('without project languages, only texts whose own file has the language (C02: one info)', () => {
    expect(missing(project())).toEqual([
      'DB_Machine.s7res: Text MLC_4DE has no de-DE translation.',
    ]);
  });

  it('with project languages in plc.json, every text missing one of them', () => {
    expect(missing(project(['de-DE', 'en-US']))).toEqual([
      'DB_Machine.s7res: Text MLC_4DE has no de-DE translation.',
      'FB_Other.s7res: Text MLC_1 has no de-DE translation.',
      'FB_Other.s7res: Text MLC_2 has no de-DE translation.',
    ]);
  });
});
