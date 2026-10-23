# PLC Studio

Editing, checking and analysis for SCL, LAD and FBD programs of S7-1200 and S7-1500 PLCs, working on the files TIA Portal V21 exports.

> **Pre-release.** PLC Studio is new. It reports an error only where TIA would reject the code; anything it cannot decide is a warning or info. Please report anything that looks wrong.

## What it does

- **Checker.** Errors only for code TIA rejects, at the line TIA reports: syntax, undeclared variables, unknown parameters and members, missing call parameters, type mismatches with and without the IEC check, constants, FOR counters, start values out of range, S7-1500-only types on S7-1200, LAD/FBD operands and unconnected box inputs, software-unit access, fail-safe interface types. Every error rule is proven by a test case compiled in TIA.
- **Editor features.** Completion (locals, globals, struct members, unit objects, instructions with parameters, typed literals), hover with type, start value and comments in every language, signature help, go to definition, find references, rename across files and units, inlay hints for parameter names, quick fixes (declare a variable, add missing parameters, convert explicitly, publish an object, add a unit relation), outline, workspace symbols, semantic highlighting, `REGION` folding, call hierarchy, reference counts.
- **LAD/FBD view.** A graphical view of LAD and FBD networks (Open With → *LAD/FBD View*), with editing: palette, drag and drop, branches, networks, inline operands. Every edit changes only the lines of that network.
- **Round trips.** Files stay byte-for-byte as TIA wrote them; edits change only the lines they touch, and comment ids in `.s7res` are never renumbered.

## Getting started

1. Export your PLC from TIA Portal V21 as SIMATIC SD documents (`.s7dcl` + `.s7res`, for example with VCI) or external sources (`.scl`, `.udt`, `.db`), with tag tables as SimaticML (`.xml`).
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

The exported files do not say which type an OB is or how often it runs. Add them to `plc.json` when you need them (`"obs": { "OB_Cyclic100ms": { "type": "CyclicInterrupt", "cycleTimeMs": 100, "priority": 13 } }`), or keep the OB's SimaticML export next to its `.s7dcl`.

## Commands

| Command | What it does |
| --- | --- |
| PLC Studio: Create manifest | Scans a folder and writes a `plc.json`. |
| PLC Studio: Open LAD/FBD View | Opens the graphical view of a `.s7dcl` LAD/FBD block. |
| PLC Studio: Show profile coverage | Lists which instructions and types are verified against TIA. |
| PLC Studio: Use PLC Studio for PLC files | Associates `.scl`, `.udt`, `.db`, `.s7dcl` and `.s7res` with PLC Studio when another extension claims them. |
| PLC Studio: Restart language server | Restarts the checker. |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `plcstudio.displayLanguage` | (from `plc.json`) | Language of comments and titles, for example `de-DE`. |
| `plcstudio.ladder.editing` | `true` | Allow editing in the LAD/FBD view. |

## Errors, warnings and info

- **Error**: TIA would reject the code, proven by a corpus case. Two PLC Studio rules are errors although TIA accepts the code: recursion, and names in one scope that differ only by case.
- **Warning**: probably a mistake, or a rule not yet verified against TIA.
- **Info**: style, and text kept as it is but not analyzed.

## Privacy

No telemetry and no network calls. Nothing leaves your machine.

## Safety

PLC Studio is not a safety-certified tool. After changing a fail-safe block, compile the safety program in TIA Portal; the collective F-signature changes, and the change must be accepted by a qualified person.

## Trademarks

SIMATIC, STEP 7, TIA Portal and Siemens are trademarks of Siemens AG. This project is not affiliated with or endorsed by Siemens.

## License

[MIT](https://github.com/ac-rosu/plc-studio/blob/main/LICENSE)
