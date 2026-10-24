# Changelog

## 0.1.0 (pre-release, not yet published)

First version, for TIA Portal V21 exports.

- **Files**: SIMATIC SD documents (`.s7dcl`, `.s7res`), external sources (`.scl`, `.udt`, `.db`) and SimaticML tag tables, read and written back byte for byte.
- **Checker**: errors only for code TIA V21 rejects, each proven by a test case compiled in TIA; warnings for rules not yet proven; two PLC Studio rules that are errors although TIA accepts the code (recursion, names that differ only by case).
- **Analyzer**: single-block and cross-block rules (timers called conditionally, instances called twice or from two OBs, Temp read before written, outputs not always written, global access in FBs and FCs, dead blocks, data shared across priorities and more), naming presets, custom rules, inline suppression with a reason, and `plcstudio.rules.json` at workspace or PLC-folder level.
- **Editor**: completion, hover in the display language, signature help, definition, references, rename across files and units, inlay hints, quick fixes, outline, workspace symbols, semantic highlighting, folding, call hierarchy, reference counts and called-from summaries.
- **Formatter**: TIA's layout; on save only the changed lines.
- **Opening by content**: a PLC file opens in the view that fits it (LAD/FBD view, data block editor, type table, or the text editor for SCL).
- **Views**: call tree and Trace value in the PLC Studio sidebar; LAD/FBD view and editor, with the block interface in a collapsible panel above the networks; block interface, data block, translation and tag table editors; program graph.
- **Fail-safe blocks**: detected, marked in every editor and in the explorer, with a reminder on every save; checked like TIA does: interface types, box data types, calls and data access between the safety program and the standard program (main safety blocks from `plc.json`).
- **Project setup**: `PLC Studio: Create manifest` writes `plc.json`; JSON Schemas for `plc.json` and `plcstudio.rules.json` ship with the extension.
- No telemetry and no network calls.
