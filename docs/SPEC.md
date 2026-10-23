# SCL, LAD & FBD Language Extension – Spec

Oct 20, 2026 · Andrei Rosu

## Overview

A free, open-source VS Code extension that gives SIMATIC S7-1200/1500 programs written in SCL, LAD and FBD the editing experience of a modern programming language: a compiler-grade checker, full editor features, a bug-finding analyzer, and graphical LAD/FBD editors. It works only on files exported from TIA Portal and never connects to TIA.

**User.** Controls engineers who export blocks from TIA Portal (with VCI, Openness tools or an MCP server), edit and review them in VS Code and git, and import them back with the same tools.

**Working name.** PLC Studio (working name; the final name is chosen before the first Marketplace publish) · working extension id `plcstudio` · command prefix `PLC Studio:` · settings prefix `plcstudio.`

**Principles**

1. **Files only.** No TIA connection of any kind. Everything works offline on Windows, macOS and Linux.
2. **No false errors.** An error is reported only for code TIA would reject, apart from a short list of policy errors the owner chose (ADR 0013). Anything uncertain is a warning or info.
3. **Faithful round trips.** A saved file imports back into TIA cleanly. Lines the user did not change stay byte-identical, including attributes, formatting and `.s7res` comment ids.
4. **Unknown is not wrong.** Constructs the parser does not understand are kept exactly as they are and marked "not analyzed", never reported as errors.
5. **Data, not code, per TIA version.** Each TIA version is a version profile. A new TIA version means a new profile plus tests.
6. **Own words and own marks.** No Siemens text, icons or trademarks in the product; facts are re-expressed in our own wording.

**Goals**

- The best SCL/LAD/FBD editing available in VS Code: everything TIA's editor does, plus what TIA lacks (rename across files, find references, analyzer, git-friendly round trips)
- Catch problems before import: TIA compiles only after the files go back in, so the extension's checker carries that load
- Full support for software units, fail-safe blocks and multilingual comments
- A public Marketplace extension that follows the Marketplace's rules from the first release

**Non-goals**

- Any connection to TIA Portal, PLCSIM or a PLC (export, import, compile, download, online)
- STL, CEM, S7-300/400
- Converting blocks between languages (no LAD↔FBD, no SCL↔LAD/FBD)
- Telemetry
- Translating the extension's own UI (English only)

## Scope

v1 covers SCL, LAD and FBD blocks for S7-1200 and S7-1500, including fail-safe blocks, for TIA Portal V20 and V21, read from SIMATIC SD documents, external sources and SimaticML tag tables.

| Area | In scope | Later | Out |
| --- | --- | --- | --- |
| Languages | SCL, LAD, FBD | GRAPH | STL, CEM |
| CPU families | S7-1200, S7-1500, incl. F-CPUs and F-blocks | | S7-300/400 |
| TIA versions | V20, V21 (one version profile each) | each new version as a new profile | V19 and older |
| Platforms | VS Code desktop on Windows, macOS, Linux | browser VS Code (vscode.dev, github.dev) | |

### File formats

| Format | Files | Used for | Support |
| --- | --- | --- | --- |
| SIMATIC SD | `.s7dcl` + `.s7res` | blocks (OB, FB, FC), DBs, UDTs in SCL, LAD and FBD; `.s7res` holds multilingual comments and titles referenced by id | primary; read, edit, write |
| External sources | `.scl`, `.udt`, `.db` | SCL blocks, UDTs and DBs as TIA's "generate source from blocks" writes them | full; read, edit, write |
| SimaticML XML | `.xml` | PLC tag tables (no SD format exists for them) | v1 read; v1.x full editor |

The parser must accept files as written by TIA's VCI export, Openness `ExportAsDocuments`/`GenerateSource`, and the user's MCP server, which all produce the same formats.

### PLC folder and manifest

Each PLC is a folder with a `plc.json` manifest. The folder follows TIA's project tree; the manifest gives the checker what it cannot infer from the files.

```text
Line3_PLC/
  plc.json
  Program blocks/
    OB_MainCycle.s7dcl
    FB_Conveyor.s7dcl
    FB_Conveyor.s7res
    Dosing/FC_DoseVolume.scl
  PLC data types/
    UDT_Motor.s7dcl
  PLC tags/
    MotorTags.xml
  Units/
    Filling/
      Program blocks/…
      PLC data types/…
      PLC tags/…
```

```json
{
  "$schema": "https://<published-schema-url>/plc.schema.json",
  "name": "Line3_PLC",
  "cpu": { "family": "S7-1500", "failsafe": true },
  "tiaVersion": "V21",
  "compiler": { "iecCheck": true },
  "displayLanguage": "en-US",
  "units": [
    {
      "name": "Filling",
      "folder": "Units/Filling",
      "namespace": "Filling",
      "relations": ["Dosing"],
      "published": ["FB_Filler", "UDT_FillRecipe"]
    }
  ]
}
```

- The manifest is JSON with a published JSON Schema, so VS Code gives completion and validation in it with no extra code.
- `tiaVersion` selects the version profile; `compiler.iecCheck` switches the type checker's implicit-conversion rules.
- `PLC Studio: Create manifest` scans a folder and proposes a manifest; without one, the extension asks the user to create it and limits diagnostics to syntax.
- Several PLC folders can live in one workspace; each is checked on its own.

### Software units

Units are modeled the way TIA enforces them:

- Each unit has a namespace; its blocks are referenced as `Namespace.Block` (for example `Filling.FB_Filler`), with completion, hover and go-to-definition.
- A unit may use another unit only through a declared one-way relation; relation rings are an error.
- Only published objects are visible to other units.
- Tag names are unique across the whole PLC; block names are unique per scope (the main program or one unit).

## Language features

The language server treats SCL code, the textual LAD/FBD networks in `.s7dcl`, and the declarations of every block, UDT and DB as one project model, so every feature works across files, formats and units.

### Diagnostics

| Severity | Meaning | Examples |
| --- | --- | --- |
| Error | TIA would reject the code, or it breaks a policy rule (ADR 0013) | syntax error, undeclared identifier, type mismatch under the active IEC-check setting, missing required call parameter, unpublished object used from another unit, F-instruction not allowed in an F-block; policy errors: recursion, identifiers differing only by case |
| Warning | likely bug; TIA accepts it | analyzer correctness rules (below) |
| Info | style, complexity, "not analyzed" | naming rules, complexity limits, unknown construct kept as is |

- **Zero false errors** is a release gate: on every corpus case that TIA compiles cleanly, the extension reports no errors other than the policy errors expected for that case (see Quality).
- When the checker cannot decide (incomplete reference data, unknown construct), it downgrades to a warning or info rather than guessing.
- Messages are short, specific and in our own words; where a TIA compiler message exists for the same fault, the corpus records it for comparison, not for copying.
- Diagnostics update within 200 ms of typing.

### Editor features (v1)

- Completion: locals (`#`), globals (`"..."`), struct members, namespaced unit objects, instructions with parameter snippets, enum-like constants, typed literals (`T#`, `16#`, `INT#`)
- Hover: type, initial value, comment in the display language (other languages listed), declaration site; for system instructions our own short description plus an https link to Siemens' online help page for that instruction
- Signature help for FB/FC calls and every system instruction in the version profile
- Go to definition, find references, rename across files and units (blocks, tags, DB members, UDT fields, interface members, constants)
- Inlay hints for parameter names in calls
- Quick fixes: declare a variable (in the right section), add missing call parameters, insert an explicit conversion, publish an object / add a unit relation
- Outline, workspace symbols, namespaces in symbols and completion
- Semantic highlighting, `REGION` folding, call hierarchy, CodeLens with reference counts

### Analyzer

Rules are built from the knowledge in the `tia-portal-s7-programming` skill (itself based on Siemens' Programming Guideline for S7-1200/1500) and re-expressed in our own wording. Correctness rules are on by default as warnings; style and complexity rules default to info.

- Timer, counter or edge-detection instance called conditionally (not every cycle)
- Same FB instance called more than once
- `Temp` read before it is written
- FC output not written on every path
- Output assigned more than once per cycle
- Write to an input parameter
- Structured types on `Input`/`Output` instead of `InOut`
- Global access inside an FC/FB (global DB, PLC tag, global constant, another block's instance DB)
- `FOR` counter modified inside the loop or used after it
- Returned error/status codes not evaluated
- `CASE` without `ELSE`, `REAL` compared with `=`, implicit narrowing, `WHILE`/`REPEAT` without a clear exit
- SIMATIC timers/counters (`%T`, `%C`) on S7-1200/1500
- Unused variables, unreachable code, empty `REGION`s
- Complexity: cyclomatic complexity and nesting depth per block, configurable limits

### Configuration and custom rules

All analyzer settings live in `plcstudio.rules.json` (JSON Schema published), at workspace or PLC-folder level; the PLC folder wins.

```json
{
  "$schema": "https://<published-schema-url>/rules.schema.json",
  "extends": ["recommended"],
  "naming": { "preset": "match-workspace" },
  "rules": {
    "timer-called-conditionally": "warning",
    "complexity": ["info", { "maxCyclomatic": 15, "maxNesting": 4 }]
  },
  "custom": [
    { "id": "no-move-blk-variant", "kind": "forbiddenInstruction", "instruction": "MOVE_BLK_VARIANT", "severity": "warning", "message": "Use MOVE_BLK in this project." },
    { "id": "motor-fb-name", "kind": "namePattern", "target": "FB", "pattern": "^FB_[A-Z][A-Za-z0-9]+$", "severity": "info" }
  ]
}
```

- **Declarative custom rules (v1)**: name patterns per object kind, forbidden or required instructions, complexity limits, forbidden global access, required comments, banned identifiers.
- **TypeScript rule plugins (later)**: run only in trusted workspaces (VS Code Workspace Trust).
- Inline suppression with a comment on the line or block, with a required reason.

### Naming presets

Naming rules are off by default. Three presets can be switched on:

| Preset | Rules |
| --- | --- |
| `default` | `OB_`, `FC_`, `FB_`, `DB_`, `UDT_` prefixes plus PascalCase; constants in `SCREAMING_SNAKE_CASE`; everything else PascalCase without a prefix; words spelled out, with an allowlist of domain abbreviations (PID, HMI, PLC, CPU, RPM, …) |
| `siemens-prefix` | role prefixes on locals (`statSpeed`, `tempIndex`, `inStart`, `outDone`, …) |
| `match-workspace` | detects the scheme the PLC already uses and flags only deviations from it |

Regardless of preset, these are errors: identifiers with spaces or language-specific characters (TIA rejects them), and two identifiers differing only by case (a policy error, ADR 0013: TIA refuses them in `.s7dcl` but silently renames one when it imports an external source).

### Formatter

- On save: formats **only the lines the user changed** (VS Code's `formatOnSaveMode: modifications`), on by default.
- Whole file only through "Format Document".
- Style: indentation, keyword casing, spaces around operators, aligned `:=` in declarations and call parameters, `REGION` layout; configurable in `plcstudio.rules.json`.

### Multilingual comments

- `displayLanguage` (manifest, overridable per user) selects which `.s7res` language is shown inline, in hovers and in the LAD/FBD editor.
- Hover lists the other languages.
- A translation table edits every language of a block's comments and titles; missing translations are flagged as info.
- Comment ids linking `.s7dcl` to `.s7res` are never renumbered; new comments get new ids in TIA's format.

## Call graph and cross-block analysis

The extension builds a call graph from every OB down to every FB, FC and system instruction, so the analyzer can find bugs whose cause lies in a different block than the symptom, such as a timer that freezes because its caller is conditional.

### Call graph (v1)

- **Roots**: every OB (program cycle, cyclic interrupt, time-of-day, hardware interrupt, startup, error OBs).
- **Edges** record how each call happens: unconditional, conditional (with the condition expression), inside a loop, or behind `EN` in LAD/FBD; how many times per cycle.
- **Instances**: single-instance DB, multi-instance, parameter instance, and which instance each call uses.
- **Parameter wiring** per call: constant, local, global, InOut reference, and which caller variable feeds which parameter.
- **Unresolved edges** for calls the files cannot settle (`VARIANT`, `DB_ANY`, `REF_TO`, instances passed as parameters, blocks missing from the export) are shown as info; every analysis that needs them downgrades to a warning or skips, never an error.
- **Partial exports**: blocks referenced but missing from the export are listed, and analyses that could not run completely are marked as such.

### Execution context

Each block knows which OBs reach it, their priority and cycle time, and whether it runs every cycle. OB priority, cyclic time and type come from the OB's attributes in the export (present in SimaticML; presence in `.s7dcl` to be confirmed in the first spike), with the manifest able to fill or override missing values. The context of an FB or FC is derived from every path that calls it.

### Cross-block rules (warnings unless noted)

| Rule | What it catches |
| --- | --- |
| Instance not updated every cycle | a timer, counter or edge detector whose block is reached through a conditional call; reported at the causing call and linked to the affected instance |
| Instance shared across priorities | the same instance reached from OBs with different priorities (interrupt can preempt mid-block) |
| Unprotected cross-priority data | global data written in one OB and read in a higher-priority OB without a consistency measure |
| Multiple writers | several writers of the same output, tag or DB member in one cycle, across all blocks |
| InOut aliasing | the same variable passed to two InOut parameters of one call |
| Unreliable FC output | an FC output the caller uses, but the FC does not write on every path |
| Recursion | a block that calls itself directly or indirectly (**error**, a policy error under ADR 0013: TIA V21 compiles it, PLC Studio does not allow it) |
| Dead block | a block no OB reaches |
| State in `Temp` | edge detection or timer instance kept in `Temp`, losing its state every cycle |

### Unused variables

| What | Severity |
| --- | --- |
| `Temp`, `Static` and local constants never used | warning (a `Static` marked accessible from HMI/OPC UA is not flagged: HMI access is invisible in the files) |
| `Input` never read, `Output` never written, `InOut` never used | info (often intentional for standard interfaces) |
| Instance DB members read from outside the block (e.g. `"DB_Valve".Status`) | counted as used, through the call graph |

### Value tracing and views

- **Trace value** (v1): on any variable, tag or DB member, lists every write and read across the call tree, following parameters into and out of other blocks.
- **Call tree** in the sidebar (v1): OB → blocks, with markers for every cycle, conditional and loop.
- **Called from** summary (v1) in hover and CodeLens, e.g. "OB1 every cycle; OB35 (100 ms) conditional".
- **Program graph** (v1.x): a whole-program graph view in a webview, with filtering by OB, unit and instance.

## Graphical and table editors

Every graphical or table editor is a VS Code custom editor over the same text file: the text stays the single source of truth, edits go through VS Code's undo/redo, and the text and the view can be open side by side and stay in sync.

### LAD/FBD viewer (v1)

- Renders every LAD and FBD construct in the version profile: contacts (normal, negated, edge), coils (normal, set, reset, edge), boxes and calls with all parameter kinds (`Input`, `Output`, `InOut`, `EN`/`ENO`), comparators, math and move boxes, empty boxes, multi-instance calls, jumps and labels, parallel branches, open branches, network titles and comments.
- A network that cannot be drawn falls back to its `.s7dcl` text inside the view, marked as such.
- Layout follows TIA's conventions: power rail on the left, numbered networks, inputs on the left of boxes and outputs on the right.
- Own visual design: VS Code light, dark and high-contrast themes, no Siemens icons.
- Full keyboard navigation (network to network, element to element), screen-reader labels for elements, zoom.
- Diagnostics from the language server shown on the element they belong to; hover and go-to-definition on operands.
- Draws a 100-network block in under 1 s.

### LAD/FBD editor (v1.x)

- Instruction palette from the version profile (filtered to F-instructions in F-blocks), drag and drop onto a network
- Open and close parallel branches; insert, delete and move elements
- Add, delete, move and copy/paste networks, also between blocks (operands re-resolved, missing declarations offered as quick fixes)
- Inline operand editing with completion; network titles and comments in the display language
- Every edit rewrites only the lines of the affected network in `.s7dcl`; the text view updates live

### Block interface editor (v1)

- A table for `Input`, `Output`, `InOut`, `Static`, `Temp`, `Constant` (and `Return` for FCs), like TIA's interface editor, for every block in every language, SCL included
- Columns: name, data type (with completion), default/start value, retain, accessible/writable/visible from HMI/OPC UA, setpoint, comment (display language)
- Add, rename (with the full rename refactor), reorder and delete members; nested structs and arrays
- Edits the declaration section of the underlying file only

### Data block editor (v1)

- Global, array and instance DBs in a table: member, data type, start value, retain, HMI/OPC UA flags, setpoint, comment
- Instance DBs show the FB interface read-only except start values and flags TIA lets the user change
- Start values validated against their types

### Tag table editor (v1 read-only, v1.x full)

- v1: SimaticML tag tables are read to resolve global symbols; a read-only table view is available
- v1.x full editor: tags and user constants (add, rename, retype, readdress), all attributes (retain, accessible/writable/visible from HMI/OPC UA), multilingual comments, address-overlap and address-validity checks per CPU family, system constants read-only, CSV import and export, and renames that update every reference in code

### Translation table (v1)

Every comment and title of a block (and later of tag tables) in all languages of its `.s7res`, one row per text, one column per language, with missing translations highlighted.

## Fail-safe blocks

F-blocks are fully viewable and editable, validated against the fail-safe rules of the version profile, and every view of them warns that changes require recompiling and re-accepting the safety program in TIA.

- **Languages**: fail-safe code exists only as F-LAD and F-FBD (there is no fail-safe SCL); F-DBs and F-compliant UDTs are supported as declarations.
- **Detection**: how an F-block is recognizable in exported files is an open fact for the first spike. Openness notes show that an F-FBD block's `.s7dcl` declares `S7_Language := "FBD"`, the same as a standard block, so detection may need other markers in the file, the folder (TIA's safety administration groups), or a manifest list of fail-safe blocks as fallback. The extension never guesses: an unclassifiable block is treated as standard and flagged as info.
- **Validation** (errors, since TIA rejects them): instructions and data types not permitted in fail-safe code, access rules between the safety program and the standard program, constructs the F-environment does not allow; all rules come from the profile's F-catalog and are checked against corpus cases.
- **Marking**: a persistent "Fail-safe" banner in the text, graphical and table editors; F-blocks highlighted in the explorer and the call tree.
- **Save warning**: every save of an F-block shows a non-modal warning that the safety program must be recompiled in TIA, the collective F-signature will change, and the change needs acceptance by a qualified person.
- **Palette**: in F-blocks the LAD/FBD palette shows only permitted F-instructions.
- The extension makes no claim of safety certification; the README and the banner say so.

## Version profiles and reference data

Everything that differs between TIA versions or CPU families is data in a version profile, so supporting V22 means adding a profile and its corpus cases, not changing code.

**A profile contains**

- **Instruction catalog**: every system instruction with its parameters (name, direction, type, optional/required), return type, the CPU families and firmware it exists on, whether it is allowed in F-code, and our own one-line description plus the https link to its Siemens online-help page
- **System data types** (`TON_TIME`, `IEC_COUNTER`, `DTL`, …) and system constants
- **Type rules**: implicit conversion matrix with IEC check on and off, literal forms, limits per data type
- **Syntax features**: language constructs, pragmas and attributes the version accepts in SCL, external sources and `.s7dcl`
- **SD format details**: keywords, attribute spellings and resource-file layout per version
- **F-catalog**: permitted F-instructions, data types and access rules
- **CPU family differences**: what exists only on S7-1500 or only on S7-1200, memory and addressing limits for address checks

**Rules for profile data**

- Stored as versioned JSON with a JSON Schema, one folder per profile (`profiles/V20`, `profiles/V21`), shared parts deduplicated through inheritance (`V21` extends `V20` and lists only differences).
- Every catalog entry is verified against TIA through the corpus (a compile case that uses it) before it is marked verified; unverified entries are allowed but downgrade related diagnostics to warnings.
- Content is our own: signatures and facts are re-entered and checked, descriptions written fresh; no Siemens help text, tables or images are copied.
- `PLC Studio: Show profile coverage` reports which instructions are verified, unverified or missing.

## Architecture

A web-safe TypeScript core does all parsing, checking, analysis and writing; a language server and the VS Code extension sit on top, and every graphical or table view is a webview that talks only to the extension.

```text
 Webviews (LAD/FBD, table editors,   <--messages-->   VS Code extension (commands, views,
 call graph view)                                     custom editors, coexistence check)
                                                                 |  LSP
 Version profiles (V20, V21 data:                     Language server (Node or browser worker)
 instructions, types, F-catalog)                                 |  calls
            | version data                                       |
            v                                                    v
 +------------------------------------------------------------------------------------+
 | Core: TypeScript, no Node or VS Code imports                                       |
 |  [Lossless parsers,     ] [Project model:   ] [Type checker:   ] [Call graph,     ] |
 |  [writer, formatter     ] [manifest, units, ] [TIA-equivalent  ] [analyzer, value ] |
 |  [                      ] [symbols          ] [errors          ] [tracing         ] |
 +------------------------------------------------------------------------------------+
                         ^  reads files; writes minimal edits
                         v
 Workspace files, the source of truth:
 .s7dcl + .s7res · .scl, .udt, .db · tag tables (XML) · plc.json · plcstudio.rules.json
```

Webviews never touch files or the core directly, so every edit, from text, a table or the LAD editor, goes through the same lossless writer.

**Stack**: TypeScript (strict) throughout · npm workspaces monorepo · esbuild bundles (Node and browser builds of the language server) · `vscode-languageserver` / `vscode-languageclient` · webviews in TypeScript with SVG rendering for LAD/FBD and a VS Code-themed table component · Vitest for unit and corpus tests · `@vscode/test-electron` for integration tests · Playwright for webview tests · ESLint + Prettier · `@vscode/vsce` for packaging.

**Lossless syntax trees and the round-trip writer**

- Every parser produces a lossless concrete syntax tree: every character of the input, including whitespace, comments, attributes and unknown constructs, belongs to a node, so printing an unchanged tree gives the original bytes.
- Edits are applied as minimal text changes to the affected nodes (one operand, one network, one declaration line); nothing is re-printed wholesale.
- Line endings and encoding are detected per file and preserved (TIA writes CRLF in external sources).
- `.s7res` comment ids are preserved; new ids follow TIA's format and never collide.

**Core rules**

- `core` has no Node or VS Code imports, so the same code runs in the desktop language server, a browser worker, and a future CLI.
- The project model updates incrementally per file; the call graph and cross-block rules re-run only for affected blocks.
- All file access goes through an abstract file system the extension provides.
- No network access, ever (links are only opened by the user).

**Repository layout**

```text
packages/
  core/            parsers (SD, external sources, SimaticML tag tables), lossless trees,
                   project model, units, type checker, call graph, analyzer, formatter, writer
  profiles/        version profile data (V20, V21) + JSON Schemas
  language-server/ LSP over core; Node and browser entry points
  extension/       VS Code client: commands, views, custom editors host, coexistence check
  webviews/        LAD/FBD viewer and editor, interface, DB, tag table and translation tables,
                   program graph
schemas/           plc.schema.json, rules.schema.json (published with each release)
corpus/            public test corpus (only blocks we wrote)
corpus-private/    gitignored; the owner's real project blocks for local runs
docs/adr/          architecture decision records
GLOSSARY.md
```

## Quality

Three automated gates decide every release: zero false errors on the corpus, byte-identical round trips, and the performance targets.

### Test corpus

- **Public corpus** (`corpus/`): only blocks written for this project, in test projects under `C:\TiaTest\`. Each case is a folder with the source files, the version profile, and `expected.json` holding TIA's compile result for that case (clean, or each message with its block and line).
- **How it is built**: on the owner's TIA machine, using the owner's MCP server as a separate tool: create or import the case, compile it, export it with every exporter (VCI, `ExportAsDocuments`, `GenerateSource`), and record TIA's messages. Broken variants are made by mutating clean cases. Nothing of the server ships with the extension.
- **Private corpus** (`corpus-private/`, gitignored, never uploaded): the owner drops blocks from real projects there; the same gates run locally.
- TIA's compile message paths give line numbers counted from `BEGIN` (external sources) or `NETWORK` (`.s7dcl`), so expected messages map to exact lines.

### Release gates

| Gate | Rule |
| --- | --- |
| Zero false errors | on every corpus case TIA compiles cleanly, the extension reports **no** errors except the policy errors (ADR 0013) expected for that case |
| Error coverage | share of TIA-rejected cases where the extension also reports an error at the right line; tracked per release, never allowed to drop |
| Round trip | parse → print gives byte-identical files for every corpus file; every editor operation changes only the lines it should (golden diffs) |
| Performance | 5,000-block PLC indexed in under 10 s; diagnostics within 200 ms of typing; 100-network LAD block drawn in under 1 s (on CI hardware, with a margin) |
| Web-safety | `core` and `language-server` build and pass their tests in a browser worker |

### Coexistence with other extensions

- Own language ids (`plcstudio-scl`, `plcstudio-s7dcl`, `plcstudio-s7res`, `plcstudio-tagtable`) and file associations.
- On activation, detects other installed extensions that claim the same file types and offers a one-click switch of the file association in settings; it never disables or changes other extensions.

### Marketplace compliance (from the first release)

Per [VS Code's publishing rules](https://code.visualstudio.com/api/working-with-extensions/publishing-extension):

- Icon is a PNG of at least 128×128 px; no SVG images in README or CHANGELOG except badges from trusted providers; every image URL is https
- At most 30 keywords; unique extension name and display name (a removed name can never be reused, so the final name is chosen once, before the first publish)
- `engines.vscode` as a caret range; plain `major.minor.patch` versions; pre-releases on odd minor versions (`0.1.x`), releases on even (`0.2.x`); a pre-release and release never share a version
- `publisher`, `repository`, `license` (MIT), `bugs`, `homepage` set in `package.json`; `.vscodeignore` keeps the package small (no corpus, tests or source maps)
- Publishing with Microsoft Entra ID (Azure DevOps global PATs are retired on 1 December 2026)
- Verified-publisher badge applied for once eligible (an extension live for 6 months and a 6-month-old owned domain)

### Intellectual property and naming

- No Siemens text, tables, images or icons copied into code, data, docs or tests; facts are re-expressed in our own words; skills are a knowledge source only.
- No Siemens trademarks in the extension name, display name, icon or publisher; the description uses them only to state compatibility ("for SIMATIC S7-1200/1500, TIA Portal V20/V21").
- README carries a trademark notice (SIMATIC, STEP 7, TIA Portal and Siemens are trademarks of Siemens AG; this project is not affiliated with or endorsed by Siemens) and states that the extension is not a safety-certified tool.
- No customer code anywhere in the public repository.

### Privacy

No telemetry, no network calls, no data leaves the machine. The README states this explicitly.

## Milestones and acceptance

The work runs in milestones, tia-mcp style: Claude Code works only on the current milestone, stops at its acceptance criteria, reports what works, what doesn't and what it learned, and the owner accepts it before the next one starts.

| # | Milestone | Delivers | Accepted when |
| --- | --- | --- | --- |
| M0 | Setup and format spike | monorepo, CI on Windows/Linux/macOS, schema skeletons, corpus harness, `docs/format-notes.md` with samples of every construct from every exporter for V20 and V21 | CI green; open facts answered: OB priority/cyclic time in `.s7dcl`, F-block detection in files, `.s7res` layout, line numbering; at least 50 corpus cases with TIA results |
| M1 | Lossless parsers and writer | parsers for `.s7dcl`, `.s7res`, `.scl`, `.udt`, `.db`, SimaticML tag tables; syntax errors with recovery | round-trip gate 100% on the corpus; unknown constructs kept and marked |
| M2 | Project model | manifest + schema, units and namespaces, symbol tables, tag tables, `.s7res` linking, profile V20/V21 base data | definitions and references resolve across files and units in the test suite; unit access rules enforced |
| M3 | Type checker | TIA-equivalent errors with IEC check on and off | zero-false-errors gate passes; error-coverage baseline recorded |
| M4 | Editor features | everything in "Editor features (v1)", multilingual hover, coexistence check | integration tests for each feature; diagnostics within 200 ms |
| M5 | Analyzer | single-block rules, `plcstudio.rules.json`, declarative custom rules, naming presets, formatter on changed lines | every rule has passing and failing corpus cases; formatter never touches unchanged lines |
| M6 | Call graph | execution context, cross-block rules, unused variables, Trace value, call tree view, called-from summaries | every cross-block rule has corpus cases; unresolved and partial cases never produce errors |
| M7 | Table editors and F-blocks | interface, DB and translation table editors; F-block detection, validation, marking and save warning | edits change only the expected lines (golden diffs); F-rules checked against corpus |
| M8 | LAD/FBD viewer | rendering of every construct, text fallback, themes, keyboard navigation | every corpus LAD/FBD network renders or falls back; 100 networks in under 1 s |
| M9 | v1 release | performance gates, accessibility pass, README, icon, Marketplace checklist, final name, pre-release then stable | all release gates green; published as pre-release, then v1.0.0 after the owner's sign-off |
| M10 | LAD/FBD editor (v1.x) | palette, drag and drop, branches, networks, copy/paste, inline operands, live text sync | golden-diff tests for every edit operation |
| M11 | Tag table editor (v1.x) | full editor per "Tag table editor" | address and rename tests; CSV round trip |
| M12 | Program graph (v1.x) | whole-program graph webview with filters | renders the 5,000-block test PLC interactively |

**Later, not yet planned in detail**: GRAPH; the ISA-88/PackML rule pack; TypeScript rule plugins; the browser release; a CLI with SARIF output.

## Claude Code prompts

**Setup before the first session**

1. Create an empty folder (e.g. `plcstudio`), run `git init`.
2. Put this spec in it as `docs/SPEC.md`.
3. Add `GLOSSARY.md` at the folder root and the decision records in `docs/adr/`.
4. Make sure Claude Code has the `tia-portal-s7-programming` and `tia-openness-v21` skills, plus `grill-with-docs` for design questions.
5. Open the folder in Claude Code and paste the start prompt.

**Start prompt**

```text
You are building "PLC Studio" (working name), a VS Code extension for SIMATIC S7-1200/1500 SCL, LAD and FBD, specified in docs/SPEC.md. Read docs/SPEC.md, GLOSSARY.md and every file in docs/adr/ completely before anything else. The spec is the source of truth; the ADRs record decisions that must not be undone without the owner.

Step 1 — set up the working files, then stop for my review:
- CLAUDE.md: the project's hard rules (below), build/test commands, repository layout from the spec, code conventions, and the working style. End it with a "Current milestone" line.
- PLAN.md: every milestone from the spec's milestone table, each broken into tasks with the verification for each task, plus the acceptance criteria copied from the spec.
- DECISIONS.md: empty log for design decisions made during the work (one dated entry each).
- docs/format-notes.md: empty log for every format fact or surprise found in exported files.
Do not write product code in step 1.

Hard rules for CLAUDE.md:
1. Work only on the current milestone. When its acceptance criteria are met, stop and report: what works, what doesn't, what you learned, and the proposed plan for the next milestone. Wait for my acceptance.
2. No TIA connection in the product: the extension works only on files. Never add code that talks to TIA Portal, PLCSIM, a PLC or an MCP server.
3. Zero false errors: never report an error for code TIA accepts, except the policy errors of ADR 0013. If a rule cannot decide, it reports a warning or info. Every error rule needs corpus cases proving it.
4. Faithful round trips: lossless syntax trees; unchanged files print byte-identical; edits change only the affected lines; .s7res comment ids are never renumbered. Unknown constructs are kept and marked "not analyzed", never errors.
5. packages/core and packages/language-server must not import Node or VS Code APIs (web-safe).
6. Everything that differs per TIA version or CPU family is version-profile data, not code.
7. Facts about SCL, LAD, FBD, data types, instructions and TIA formats come from the tia-portal-s7-programming and tia-openness-v21 skills or from corpus evidence. Never guess; record new findings in docs/format-notes.md.
8. Intellectual property: never copy Siemens text, tables, images or icons, and never copy skill text, into code, data, docs or tests. Write every message, description and doc in your own words. No Siemens trademarks in names, icons or the publisher.
9. corpus-private/ is gitignored and never committed, uploaded or quoted. The public corpus contains only blocks written for this project.
10. No telemetry and no network calls.
11. Follow the Marketplace rules in the spec from the first commit (icon, images, keywords, versioning, package.json fields).
12. New design questions not covered by the spec: stop and ask me, using the grill-with-docs approach; record decisions as ADRs only when they are hard to reverse, surprising and a real trade-off.

Working style:
- Start each milestone by listing its tasks and how each will be verified.
- Write tests with the code; run build, lint and all tests before every commit; commit per finished task (feat(scope): …).
- Keep PLAN.md, DECISIONS.md and docs/format-notes.md current so a new session can resume from them.
- Corpus cases needing TIA results: prepare the case files and a list of what I must export or compile on my TIA machine; I run that with my own tools and give you the results.

Start with step 1 now.
```

**Resume prompt** (each new session)

```text
Continue PLC Studio. Read CLAUDE.md, PLAN.md, DECISIONS.md, docs/format-notes.md, GLOSSARY.md and docs/adr/, check git log and the test status, then continue with the next open task of the current milestone, following CLAUDE.md.
```
