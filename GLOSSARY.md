# PLC Studio

A VS Code extension for editing, checking and analyzing SIMATIC S7-1200/1500 programs in SCL, LAD and FBD, working only on files exported from TIA Portal.

## Program structure

**PLC folder**:
A workspace folder holding the exported program of one PLC, described by its manifest.
_Avoid_: project, station, device

**Manifest**:
The `plc.json` file of a PLC folder, stating the CPU family, TIA version, compiler settings, display language and software units.
_Avoid_: config, project file

**Block**:
An OB, FB or FC: a unit of program code with an interface.
_Avoid_: routine, POU, program

**Data block (DB)**:
A block that holds data: global, array or instance DB.
_Avoid_: data file

**Instance**:
The memory of one FB call: a single-instance DB, a multi-instance in another FB's `Static`, or a parameter instance.
_Avoid_: object

**UDT**:
A PLC data type: a user-defined structured type.
_Avoid_: struct type, custom type

**Interface**:
The declaration sections of a block: Input, Output, InOut, Static, Temp, Constant, Return.
_Avoid_: header, signature

**Tag table**:
A set of global PLC tags and user constants with addresses.
_Avoid_: symbol table, variable list

**Software unit**:
A part of a PLC program with its own namespace, its own blocks, types and tag tables, explicit relations to other units, and published objects.
_Avoid_: module, package, library

**Namespace**:
The name prefix of a software unit's objects, as in `Filling.FB_Filler`.

**Relation**:
A declared one-way permission for one software unit to use another.
_Avoid_: dependency, reference

**Published object**:
An object of a software unit that other units may use.
_Avoid_: public, exported

**Network**:
One numbered section of an LAD or FBD block, with its own title and comment.
_Avoid_: rung (a rung is LAD-specific drawing inside a network)

**F-block**:
A fail-safe block, written in F-LAD or F-FBD, belonging to the safety program.
_Avoid_: safety block, SIL block

## Files

**SIMATIC SD document**:
The `.s7dcl` file of a block, UDT or DB, holding declarations and code in text form for SCL, LAD and FBD.
_Avoid_: SD file, source

**Resource file**:
The `.s7res` file holding the multilingual comments and titles that a SIMATIC SD document references by id.
_Avoid_: translation file

**External source**:
A `.scl`, `.udt` or `.db` file as TIA's "generate source from blocks" writes it.
_Avoid_: SCL export

**Display language**:
The language whose comments and titles are shown inline.

## Checking and analysis

**Version profile**:
The data describing one TIA Portal version: instructions, data types, conversion rules, syntax features and fail-safe rules.
_Avoid_: target, SDK

**Diagnostic**:
A message the extension reports on code, with a severity of error, warning or info.
_Avoid_: lint, problem

**Error**:
A diagnostic for code TIA would reject.

**False error**:
An error reported for code TIA accepts; the product must have none.

**Analyzer rule**:
A check for code TIA accepts but that is likely a bug, a style deviation or too complex.
_Avoid_: lint rule

**Custom rule**:
An analyzer rule defined by the user in the rules file.

**Naming preset**:
A ready-made set of naming rules: default, siemens-prefix or match-workspace.

**Not analyzed**:
The marking of a construct the extension does not understand and keeps unchanged.
_Avoid_: unsupported, unknown error

**Call graph**:
The calls from every OB down to every block and system instruction, with how and where each call happens.
_Avoid_: call tree (the sidebar view of it), dependency graph

**Execution context**:
The OBs that reach a block, their priority and cycle time, and whether the block runs every cycle.

**Unresolved call**:
A call whose target the exported files cannot settle.

**Trace value**:
Listing every write and read of a variable, tag or DB member across the call graph.

## Quality

**Round trip**:
Saving a file and importing it back into TIA without unintended changes; unchanged lines stay byte-identical.

**Corpus case**:
A set of exported files together with TIA's recorded compile result for them.

**Public corpus**:
Corpus cases written for this project and published with it.

**Private corpus**:
Corpus cases from the owner's real projects, kept only on the owner's machine.
