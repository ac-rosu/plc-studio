# PLC Studio

Editing, checking and analysis for SCL, LAD and FBD programs of S7-1200 and S7-1500 PLCs, working on the files TIA Portal V21 exports.

> **Pre-release.** PLC Studio is new. It reports an error only where TIA would reject the code; anything it cannot decide is a warning or info. Please report anything that looks wrong.

## What it does

- **Checker.** Errors only for code TIA rejects, at the line TIA reports: syntax, undeclared variables, unknown parameters and members, missing call parameters, type mismatches with and without the IEC check, constants, FOR counters, start values out of range, S7-1500-only types on S7-1200, LAD/FBD operands and unconnected box inputs, software-unit access, fail-safe interface types. Every error rule is proven by a test case compiled in TIA.
- **Analyzer.** Warnings and hints TIA does not give: timers or edge detectors not called every cycle, an instance called twice or from two OBs, `Temp` read before written, outputs not written on every path or written twice, writes to inputs, global access inside FBs and FCs, `CASE` without `ELSE`, `REAL` compared with `=`, unused variables, status outputs not evaluated, loops without a clear exit, dead blocks, data shared across priorities without protection, and more. Configurable per workspace or PLC folder.
- **Editor features.** Completion (locals, globals, struct members, unit objects, instructions with parameters, typed literals), hover with type, start value, comments in every language and where a block is called from, signature help, go to definition, find references, rename across files and units, inlay hints for parameter names, quick fixes (declare a variable, add missing parameters, convert explicitly, publish an object, add a unit relation), outline, workspace symbols, semantic highlighting, `REGION` folding, call hierarchy, reference counts.
- **Formatter.** Formats SCL the way TIA lays it out. On save it touches only the lines you changed; *Format Document* formats the whole file.
- **Call tree and Trace value.** The PLC Studio sidebar shows which OB calls which block, every cycle or under a condition. *Trace value* lists every read and write of a variable, tag or DB member across blocks, following parameters.
- **LAD/FBD view and editor.** LAD and FBD networks drawn graphically, with a palette, drag and drop, branches, networks and inline operands. Every edit changes only the lines of that network.
- **Table editors.** Block interface, data block start values, translations of comments and titles, and tag tables (with CSV import and export), all editable as tables next to the text.
- **Program graph.** All blocks and calls of a PLC on one canvas, filtered by OB, unit or name.
- **Fail-safe blocks.** F-blocks are marked in every editor and in the explorer, and saving one shows a reminder to compile and accept the change in TIA.
- **Round trips.** Files stay byte-for-byte as TIA wrote them; edits change only the lines they touch, and comment ids in `.s7res` are never renumbered.

## Getting started

1. Export your PLC from TIA Portal V21 as SIMATIC SD documents (`.s7dcl` + `.s7res`, for example with VCI) or external sources (`.scl`, `.udt`, `.db`), with tag tables as SimaticML (`.xml`, under a `PLC tags` folder).
2. Open the folder in VS Code.
3. Run **PLC Studio: Create manifest**. It writes a `plc.json` describing the CPU family, the TIA version, the IEC check, the display language and the software units. Without it, only syntax is checked.

```json
{
  "name": "Line3_PLC",
  "cpu": { "family": "S7-1500", "failsafe": false },
  "tiaVersion": "V21",
  "compiler": { "iecCheck": false },
  "displayLanguage": "en-US",
  "units": [{ "name": "Filling", "folder": "Units/Filling", "namespace": "Filling", "relations": [] }]
}
```

Comments and titles missing in a language are listed as info. Add `"languages": ["en-US", "de-DE"]` to `plc.json` to check every text against the project languages; without it, a text counts as missing a language only when another text of the same file has it.

The exported files do not say which type an OB is or how often it runs. Add them to `plc.json` when you need them (`"obs": { "OB_Cyclic100ms": { "type": "CyclicInterrupt", "cycleTimeMs": 100, "priority": 13 } }`), or keep the OB's SimaticML export next to its `.s7dcl`. The call tree, the called-from summaries and the cross-priority rules use them.

## Analyzer settings

Put a `plcstudio.rules.json` in the workspace or in a PLC folder (the PLC folder's file wins). Completion and validation come with the extension.

```json
{
  "extends": ["recommended"],
  "rules": {
    "case-without-else": "info",
    "unused-temp": "off",
    "complexity": ["warning", { "maxCyclomatic": 20, "maxNesting": 5 }]
  },
  "naming": { "preset": "default" },
  "custom": [
    { "id": "no-test-names", "kind": "bannedIdentifier", "severity": "warning", "identifiers": ["Tmp", "Test"] }
  ],
  "format": { "keywordCase": "upper", "indentSize": 4 }
}
```

Analyzer rules can be info, warning or off. Errors (code TIA rejects, and the two PLC Studio rules below) cannot be lowered or suppressed.

To silence one finding, say why:

```text
// plcstudio-disable-next-line real-compared-with-equal -- value comes from a constant table
IF #Ratio = 1.0 THEN
```

`plcstudio-disable-line` works on its own line, `plcstudio-disable` until the end of the block. A directive without a reason is ignored and reported.

## Views and commands

Open the graphical and table views with **Open With…** on a file, from the editor title or explorer context menu, or through these commands:

| Command | What it does |
| --- | --- |
| PLC Studio: Create manifest | Scans a folder and writes a `plc.json`. |
| PLC Studio: Open LAD/FBD View | Opens the graphical view of a `.s7dcl` LAD/FBD block. |
| PLC Studio: Open Interface Editor | The block interface as a table. |
| PLC Studio: Open Data Block Editor | Start values and declarations of a data block. |
| PLC Studio: Open Translation Table | Comments and titles of a block, one column per language. |
| PLC Studio: Open Tag Table Editor | A tag table, with CSV import and export. |
| PLC Studio: Show Program Graph | All blocks and calls of a PLC. |
| PLC Studio: Trace value | Every read and write of the symbol at the cursor (also in the editor context menu). |
| PLC Studio: Show profile coverage | Lists which instructions and types are verified against TIA. |
| PLC Studio: Use PLC Studio for PLC files | Associates `.scl`, `.udt`, `.db`, `.s7dcl` and `.s7res` with PLC Studio when another extension claims them. |
| PLC Studio: Restart language server | Restarts the checker. |

The call tree and the trace results are in the **PLC Studio** view in the activity bar.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `plcstudio.displayLanguage` | (from `plc.json`) | Language of comments and titles, for example `de-DE`. |
| `plcstudio.ladder.editing` | `true` | Allow editing in the LAD/FBD view. |

Format on save is set to change only modified lines for PLC Studio's languages; turn on `editor.formatOnSave` to use it.

## Errors, warnings and info

- **Error**: TIA would reject the code, proven by a corpus case. Two PLC Studio rules are errors although TIA accepts the code: recursion, and names in one scope that differ only by case.
- **Warning**: probably a mistake, or a rule not yet verified against TIA.
- **Info**: style, and text kept as it is but not analyzed.

## Privacy

No telemetry and no network calls. Nothing leaves your machine. PLC Studio never connects to TIA Portal, PLCSIM or a PLC.

## Safety

PLC Studio is not a safety-certified tool. After changing a fail-safe block, compile the safety program in TIA Portal; the collective F-signature changes, and the change must be accepted by a qualified person.

## Trademarks

SIMATIC, STEP 7, TIA Portal and Siemens are trademarks of Siemens AG. This project is not affiliated with or endorsed by Siemens.

## License

[MIT](https://github.com/ac-rosu/plc-studio/blob/main/LICENSE)
