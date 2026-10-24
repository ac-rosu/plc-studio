// Writes a workspace to try the extension on: the corpus PLCs as demo-plcs.ts chooses them
// (external sources, SIMATIC SD for LAD/FBD), with plc.json, software-unit folders, tag tables
// under "PLC tags" and the OB SimaticML exports.
// Usage: npm run demo [-- <folder>]   (default: .scratch/demo)
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusFile, CorpusPlc } from './corpus.ts';
import { corpusManifest, plcFilePath } from './core-adapters.ts';
import { demoPlcs } from './demo-plcs.ts';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const corpusRoot = path.join(repository, 'corpus');
const target = path.resolve(process.argv[2] ?? path.join(repository, '.scratch', 'demo'));

rmSync(target, { recursive: true, force: true });
let count = 0;
const write = (plc: CorpusPlc, virtual: string, file: CorpusFile) => {
  // plcFilePath gives /plc/<PLC>/...; tag tables go under "PLC tags" as TIA's VCI does
  const relative = virtual.slice(`/plc/${plc.name}/`.length);
  const placed =
    file.variant === 'tagtables' ? path.join('PLC tags', path.basename(relative)) : relative;
  const destination = path.join(target, plc.name, ...placed.split('/'));
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(file.absolutePath, destination);
  count++;
};

for (const plc of demoPlcs(corpusRoot)) {
  mkdirSync(path.join(target, plc.name), { recursive: true });
  const manifest = JSON.parse(corpusManifest(plc, corpusRoot)) as Record<string, unknown>;
  manifest['displayLanguage'] = 'en-US';
  // only main safety blocks the demo contains (some belong to broken cases it leaves out)
  const present = new Set(plc.files.map((f) => f.objectName.toLowerCase()));
  if (Array.isArray(manifest['mainSafetyBlocks']))
    manifest['mainSafetyBlocks'] = (manifest['mainSafetyBlocks'] as string[]).filter((n) =>
      present.has(n.toLowerCase()),
    );
  writeFileSync(path.join(target, plc.name, 'plc.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const file of plc.files) write(plc, plcFilePath(plc, file), file);
  // OB type, number and cycle time come from the SimaticML export next to the OB
  for (const c of plc.cases)
    for (const f of c.files) {
      const ob = c.expected.objects.find(
        (o) => o.type === 'OB' && f.variant === 'simaticml' && f.objectName.startsWith(o.name),
      );
      if (!ob) continue;
      const folder = ob.unit ? `Units/${ob.unit}/` : '';
      write(plc, `/plc/${plc.name}/${folder}${f.objectName}${f.extension}`, f);
    }
}

// a few SimaticML exports to open: shown read-only, in the view their content needs (M14)
const xmlExports = [
  'C02-global-db/simaticml/DB_Machine.xml',
  'C01-udts/simaticml/UDT_Recipe.xml',
  'C16-lad-contacts/simaticml/FC_LadContacts.xml',
  'C19-fbd-logic/simaticml/FC_FbdLogic.xml',
  'C05-scl-sections/simaticml/FB_SclSections.xml',
];
mkdirSync(path.join(target, 'SimaticML'), { recursive: true });
for (const file of xmlExports) {
  copyFileSync(
    path.join(corpusRoot, 'V21', ...file.split('/')),
    path.join(target, 'SimaticML', path.basename(file)),
  );
  count++;
}

console.log(`Wrote ${count} files to ${target}`);
console.log(
  'Open that folder in VS Code with PLC Studio installed (or run the extension from source).',
);
