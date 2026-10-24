# Decisions

Design decisions made during the work, one dated entry each, oldest first. Decisions that are hard to reverse, surprising and a real trade-off also get an ADR in [docs/adr/](docs/adr/).

## 2026-10-23 – Recursion is an error, although TIA compiles it

- Context: the spec's cross-block rules call recursion an error because "S7 does not allow it". Corpus case B13 (an FC that calls itself) compiles in TIA V21 with no message at all.
- Decision (owner): not allowed, whatever TIA does. Recursion, direct or indirect, is reported as an error.
- Consequences: a policy error under [ADR 0013](docs/adr/0013-policy-errors-stricter-than-tia.md). The zero-false-errors gate expects this error on B13. The spec's reason "S7 does not allow it" does not hold for V21.

## 2026-10-23 – Identifiers that differ only by case are errors in every format

- Context: B12 and B16. TIA refuses a `.s7dcl` import that has the duplicate. When it imports an external source, it silently renames the second identifier (`state` → `state_1`, `Enable` → `Enable_1`) and compiles.
- Decision (owner): not allowed in the extension, whatever TIA does: an error in `.s7dcl`, `.scl`, `.udt` and `.db` alike.
- Consequences: a policy error under ADR 0013. The corpus exports of B12/B16 hold TIA's renamed variant, so the failing cases for this rule are files written for the project (mutations of C05 and C01).

## 2026-10-23 – Where OB type, number, cycle time and priority come from: deferred

- Context: neither `.s7dcl` nor `.scl` carries the OB type, number, cycle time, phase offset or priority, and importing either always creates a program-cycle OB. SimaticML has type, number, cycle time and phase offset in the default export. The priority appears only with the read-only export option, which in turn leaves out attributes at their default value. OB40 has no priority in either export. ([format notes](docs/format-notes.md), corpus finding 1.)
- Decision (owner): noted for later.
- Where it comes back: M2 (manifest schema) and M6 (execution context of the call graph). Listed as an open question in both milestones in `PLAN.md`.

## 2026-10-24 – TIA V20 moves to a later version; v1 is V21 only

- Context: the spec planned V20 and V21 for v1, but only a V21 corpus exists. The owner expects V20 to differ little from V21 in syntax and declarations.
- Decision (owner): V20 is not in v1. When it is taken up, a small V20 export is compared with the V21 findings first, to decide whether V20 needs a profile of its own or can share V21's.
- Consequences: the spec's scope, profile, milestone (M0, M2) and "Later" sections now say V21; M0 has no V20 corpus task. ADR 0005 is unchanged.

## 2026-10-24 – Publisher, repository and harness location

- The owner chose the publisher id `acro` and the repository https://github.com/ac-rosu/plc-studio.
- The corpus harness is Node-only test tooling and lives in `tools/corpus-harness/`, a private workspace package outside `packages/`, approved by the owner.
- The spec and glossary edits for ADR 0013 were made by Claude at the owner's request.

## 2026-10-24 – Toolchain choices for M0

- TypeScript 6.0, not 7.0: typescript-eslint supports TypeScript below 6.1 only, and 7.0 (the native compiler) does not offer the API it needs. Revisit when typescript-eslint supports 7.
- Relative imports with `.ts` extensions and only erasable syntax, so Node 24 runs scripts and the harness CLI directly; esbuild and Vitest handle the same imports. Workspace packages export their TypeScript sources; there is no compile step besides the esbuild bundles.
- Exact versions for every dev tool; current majors as of 2026-10-24 (esbuild 0.28, ESLint 10, Prettier 3.9, Vitest 5 with Vite 8 and Playwright 1.64, vscode-languageserver/-client 11, @vscode/vsce 4).
- `engines.vscode` `^1.100.0` with `@types/vscode` 1.100: recent enough for the language client, old enough for machines that update slowly. Easy to raise.

## 2026-10-24 – How web safety is checked

The spec asks that core and language-server pass their tests in a browser worker. Vitest's browser mode runs tests in a browser page, not a worker. Web safety is therefore checked four ways: ESLint forbids Node modules, Node globals, `vscode` and network APIs in both packages; core is typed without Node or DOM typings; esbuild bundles core for a neutral platform and the language server for the browser; and the tests run in Chromium, including one that starts the language server's browser entry in a real Web Worker and completes the LSP handshake. The Node entry gets the same handshake test over stdio.

## 2026-10-24 – Corpus harness details

- A PLC is assembled from all its cases in three variants: `documents` (SIMATIC SD from the export tool), `vci` (VCI SimaticSD) and `source` (external sources where TIA could write them, SIMATIC SD for LAD/FBD). The gates run on each variant.
- B12 and B16 count as TIA-clean for the zero-false-errors gate: TIA refused the intended duplicate, and the exported files are the renamed variant it then compiled cleanly.
- The expected policy errors (ADR 0013) are listed in the harness, not in `expected.json`, which records only TIA's results. So far: B13, `recursion`, on `FC_SclTypes_B13`.
- The round trip covers the files the extension reads (`.s7dcl`, `.s7res`, `.scl`, `.udt`, `.db`, tag-table XML), not block SimaticML.

## 2026-10-24 – Extension packaging details

- The JSON Schemas ship inside the extension and are attached through `contributes.jsonValidation`, so completion in `plc.json` and `plcstudio.rules.json` works offline. The schemas' `$id` points to the repository's raw files for now; where schemas are published per release is decided before the first publish (M9).
- Tag tables get the language id only under a `PLC tags` folder (`**/PLC tags/**/*.xml`), so the extension does not claim every XML file. `.db` is claimed for external sources, as the spec says, although other tools use the extension for databases.
- Analyzer severities in `plcstudio.rules.json` are off, info and warning; error is not offered (open question for M5 in PLAN.md).
- LICENSE names "Andrei Rosu" as copyright holder (from the spec's author line), to be confirmed by the owner.

## 2026-10-24 – Autonomous run

- Decision (owner): Claude finishes all milestones in one run, takes the recommended option on open questions and records each choice here. Claude may use the TIA MCP server and the TIA skills to double-check facts in the corpus project; extra skills only from trusted sources.
- Pushed `main` to https://github.com/ac-rosu/plc-studio so CI runs (M0.5).

## 2026-10-24 – Rules verified in TIA; names with spaces

- A verification batch in TIA V21 (corpus C27–C34, B27–B38) proved nine more error rules: FC calls must supply every parameter (B27, B28), `=>` on an input (B29), unknown member (B30), Int on a Time parameter (B31), different UDTs (B32), undefined jump label (B33), Real→Int with the IEC check (B34), Word→Real (B35), Bool↔bit strings (B36, B38) and string literals into numbers (B37). These are errors now; error coverage of PLC_Main (SIMATIC SD) rose to 34/41 (83%).
- `:=` on an output is accepted by TIA (C30); the direction rule now only flags `=>` on inputs.
- **Spec conflict, decision taken (recommended option):** the spec says identifiers with spaces are errors because "TIA rejects them". TIA V21 compiles a quoted local `"Two words"` (C32). Per ADR 0003 this cannot be an error, so `invalid-identifier` is an info. If the owner wants it as an error anyway, it becomes a policy error under ADR 0013 (owner's call).

## 2026-10-24 – LAD/FBD view and editor (M8, M10)

- Rungs are read as a graph: `wire#name` inside a rung names the point reached, `RUNG wire#x` starts there, `END_RUNG wire#x` joins it; every end point is joined to a virtual right end. Series and parallel reduction gives the drawing structure; a parallel whose branches end at the virtual end is an open branch (no closing line). Networks that do not reduce, or that have syntax errors or not-analyzed text, are shown as their .s7dcl text, marked as such.
- The extension host builds the layout with core (absolute coordinates) and sends it to the view; the view bundle carries no parser and only draws, so it stays small and fast.
- Editing is on by default (setting `plcstudio.ladder.editing`), although the spec plans the editor for v1.x: every edit changes only the lines of the affected network, and undo is VS Code's.
- New elements get the placeholder operand `#NewOperand` (the checker reports it until it is replaced); the view opens the operand editor right away. A new network contains one empty rung, which TIA cannot import until it has elements; the view marks it as empty.
- A new parallel branch starts with a copy of the first element of the chosen range (TIA cannot import an empty rung); when nothing follows the range, the branch stays open. Deleting the last element of a branch deletes the branch; the last element of the only rung cannot be deleted (delete the network instead).
- Duplicated and pasted networks get new comment ids in TIA's form with copies of their texts, appended to the .s7res; a network that gets its first title gets a multi-line attribute block with the attributes in alphabetical order, as TIA writes it. Locals a pasted network uses that the target block does not declare are reported to the user.
- Edits arrive with the document version of the view; when the text changed meanwhile, the edit is refused and the view refreshed.
- Inputs a box needs but does not have are shown as `???` (corpus B19) and can be connected from the view; inputs are inserted before the first output, as TIA writes parameters.

## 2026-10-24 – Analyzer (M5): rules, configuration, suppression

- Rule ids: where the corpus build already named a rule (`analyzerExpect` in C26a–n), that id is used. All analyzer and cross-block rules are listed in `packages/core/src/check/rules.ts` with their default severity and proving cases.
- `plcstudio.rules.json` severities are off, info and warning. Rules whose default is error (checker errors, the recursion and case-only policy errors) cannot be lowered or switched off by configuration.
- Workspace level: the nearest `plcstudio.rules.json` outside every PLC folder applies to the PLC folders below it; a PLC folder's own file wins setting by setting; its `custom` list replaces the workspace's instead of adding to it.
- Inline suppression: `// plcstudio-disable-next-line <rule>[, <rule>] -- <reason>`, `// plcstudio-disable-line … -- …` (same line) and `// plcstudio-disable … -- …` (to the end of the block); `(* … *)` works too. Without a reason the directive is not applied and an info says so. Errors can never be suppressed.
- Unused Static: TIA's default "accessible from HMI/OPC UA" leaves no trace in the files, so a Static is exempt only when the file marks it explicitly (setpoint, explicit external access). Otherwise it is reported as a warning whose message names the HMI case.
- Timers, counters and edge detectors: in LAD/FBD a timer box behind contacts still runs every cycle (the power flow is its IN), so only real conditions (IF/CASE/loops) count for `timer-not-called-every-cycle`. An FB box behind contacts does not run when EN is false, so it counts as conditional for the cross-block rule.
- Fail-safe blocks are exempt from the global-access rules (F-programs work on F-DBs by design). F-blocks without callers count as roots for `dead-block`: they run from an F-runtime group whose F-OB is usually not exportable.
- `temp-read-before-write` treats AT overlays as one variable (external sources), and skips non-optimized blocks read from `.s7dcl`, where TIA's export drops the AT (format-notes 2026-10-24).
- Instructions whose return value is a status (RD_LOC_T, RDREC, Serialize …) are listed in the analyzer code for now; candidate for a profile flag.
- Complexity defaults: cyclomatic 15, nesting 4 (the spec's example); configurable as `"complexity": ["info", { "maxCyclomatic": …, "maxNesting": … }]`.
- Custom rules: `requiredInstruction` applies to every block of the kinds in its `in` list (default OB, FB, FC; `in` added to the schema); `requiredComment` checks block comments only in external sources, because SIMATIC SD documents carry no block title or comment.
- Formatter: reproduces TIA's layout (base + 4 spaces per level; CASE labels one level in, their statements two; `.s7dcl` base = NETWORK indentation + 4, external sources one TAB), so formatting TIA's files changes nothing (test over all 281 corpus block files). It never touches continuation lines of a statement, comments, attribute blocks, REGION titles, LAD/FBD networks, or networks with syntax errors. Alignment of declarations is off by default. Style options go into a new `format` object of `plcstudio.rules.json`.

## 2026-10-24 – Call graph (M6)

- Roots are all OBs. Program-cycle and startup OBs get priority 1 when neither the manifest nor SimaticML gives one. A call is "every cycle" when no IF/CASE/EN condition lies on the way; a loop is marked separately.
- Shared instances: an instance DB called from OBs of different (or unknown) priority is `instance-shared-by-two-obs` at every call; called from several blocks of the same priority, `instance-called-twice` at the later calls.
- `unprotected-cross-priority-data`: global data (tags, global DB members) written in one OB and read in an OB of higher priority; a block that calls DIS_AIRT/EN_AIRT or UMOVE_BLK/UFILL_BLK counts as protected. `multiple-writers`: more than one block writes the same tag or global DB member (DB start values do not count).
- Recursion is found with strongly connected components over block-to-block calls and reported at each call in the cycle (policy error, ADR 0013).
- Unresolved instance calls are an info (`unresolved-call`); missing blocks stay the checker's `unknown-global` warning. Nothing in the call graph is ever an error except recursion.
- `callGraph(project, analysis?)` is cached per project revision; inside an analysis pass the analysis in progress must be passed in (the project's analysis is not cached yet).

## 2026-10-24 – Table editors, tag tables, program graph and F-blocks (M7, M11, M12)

- Edit operations live in `packages/core/src/edit/` and return minimal text edits plus, where texts change, edits on the `.s7res` next to the file (or the text of a new one). The extension applies everything of one user action as one WorkspaceEdit, so one undo step reverts it.
- HMI flags in SIMATIC SD: `S7_Access := "ReadOnly := External"` means not writable and `S7_Visibility := "Hidden := External"` means not visible. No separate attribute for "accessible" was seen, so "accessible" is shown as visible-or-writable; switching it off writes both attributes, as TIA does for a member that is not accessible (C02 `InternalState`). In external sources the three `External…` attributes are written as TIA does (only those that are false).
- Retain: moving a member into or out of `VAR RETAIN` moves its lines between sections; a missing section is created after the plain `VAR` section in each format's layout.
- New `.s7res` ids come from `newResourceId` (prefix `MLC_P…`), never renumbering existing ids; new entries are appended at the end of the file (TIA orders by first reference; the order has no meaning on import). A new `.s7res` takes the document's line ending.
- Start values of array DBs are shown but not edited: no exported sample shows how TIA writes them.
- Instance DBs: the FB interface is read-only; start values are editable; flags stay as the FB declares them.
- Tag tables: flags left out when true (VCI style), inserted in alphabetical order when false; new tags and constants get IDs counting up from the highest in the file. Address checks are warnings (type/size mismatch, area beyond the family's limit: S7-1200 I/Q 1 KB, M 8 KB; S7-1500 I/Q 32 KB, M 16 KB, which are family upper bounds, not per-CPU values); overlaps are info (TIA allows overlapping tags).
- CSV format of the tag table editor: our own columns `Kind, Name, DataType, Address, Value, Accessible, Visible, Writable, Comment <culture>…`; an import edits changed fields and adds new names, never deletes; each change is applied as its own minimal edit.
- External `.db` sources in a fail-safe PLC cannot say whether they are F-DBs: treated as standard and flagged as info (`failsafe-unknown`); the manifest's `failsafeBlocks` list overrides.
- Fail-safe marking in the text editor: a decoration after the first line (VS Code has no banner API for text editors); explorer badge "F"; a non-modal warning on every save.
- The table editors build their project data from the workspace files in the extension host (`features/tables-workspace.ts`), separately from the language server, so they work without it; that module is the one place to switch to language-server data later.
- The program graph lays out in the webview (`packages/webviews/src/graph/layout.ts`): longest-path layers from blocks nobody calls, back edges of cycles ignored, two barycenter sweeps; canvas drawing of only the visible part, plus an accessible list of the shown blocks (first 500).
- The models and edit computation of the interface, data block and translation editors live in `features/tables-model.ts` without the VS Code API, so corpus tests run them (edit, apply, parse again); `features/tables.ts` only wires them to VS Code. Webview browser tests are named `*.web.test.ts`, like the language-server worker tests.

## 2026-10-24 – Wiring the analyzer and call graph into the editor; release checks

- Formatting: the server offers document, range and multi-range formatting (LSP 3.18 `rangesSupport`), so VS Code's format-on-save mode "modifications" formats only changed lines. Style options come from the `format` object of the rules file. A sign after a keyword (`BY -2`, `RETURN -1`) stays unary (found by corpus C28).
- Rules-file problems are published on `plcstudio.rules.json`; changing a workspace-level rules file re-checks every PLC folder. Unknown rule ids get a warning with the closest known id; the spec's `timer-called-conditionally` is accepted as an alias of `timer-not-called-every-cycle`.
- Call tree and Trace value are tree views in a "PLC Studio" activity-bar container (own icon). The call tree hides instructions by default (toggle in the view title) and refreshes one second after edits while it is visible. Trace value leaves out declarations.
- Called-from summaries ("OB_Main (OB1) every cycle") are added to hover and CodeLens for FBs and FCs, only when the PLC folder has a manifest.
- The custom requests between client and server are typed in `packages/language-server/src/protocol.ts`, which imports nothing, so the extension can use the types without pulling in the server.
- Webviews answer `rendered` after drawing an update and report script errors as `viewError`; the host logs errors to the output channel "PLC Studio Views". A command that is not contributed (so not in the palette), `plcstudio.internal.viewHealth`, returns both for the integration tests, which open every view in VS Code and wait for it.
- Accessibility (M9.2): axe-core 4.14 (Deque, MPL-2.0, dev dependency only, not shipped) audits every view for WCAG 2.1 A/AA in Chromium. Color contrast is not audited because colors come from the VS Code theme. Buttons with a word on them are named by that word (label in name); LAD/FBD diagram elements are exempt from that one heuristic, because pin names are visible SVG text while the element's name starts with its kind and lists every operand.
- The README's JSON examples are validated against the schemas and the rules reader in the unit tests.
- Missing translations: the languages are the new optional `languages` list of `plc.json`; without it, those of the same `.s7res` file. Before, one translated block made every untranslated text of the PLC an info (344 on the corpus PLC); now corpus C02 gives exactly its one info (MLC_4DE), as PLAN M2.7 asks.
- `npm run demo` writes a workspace from the corpus (clean and analyzer cases plus B01, B04, B13, B19) to `.scratch/demo`; `.vscode/launch.json` runs the extension from source on it, and the task "plcstudio: open demo without debugger" opens the same window without the debugger (on the owner's VS Code 1.139.1 the debugger could not attach to the extension host). Over LSP the demo shows exactly the four showcase errors.
- Packaging: the allowlist pattern rejected the capital L of `.tmLanguage.json`, so CI's package step failed since the grammars were added; fixed. The package has 22 files, 330 KB.

## 2026-10-24 – Table editors, second pass (M7, M11)

- Members inside a Struct: `addMember` takes the path of the struct (`parent`); names must be unique within that struct only, while top-level names stay unique across the whole interface. The new line takes the indent of the struct's members, or one step more than its `END_STRUCT` when it is empty. A new member of type Struct is written as `STRUCT` (SIMATIC SD) or `Struct` (external sources) with an empty body and `END_STRUCT;` at the member's indent, as the corpus shows (C02).
- The FC return type is edited in place in the header (`FUNCTION "X" : Int`), Void included; Struct is refused.
- CSV import: the changes are still computed one at a time on the text (each a minimal edit), and the result is applied as one set of line edits from a line diff (Myers), so one undo reverts the import and unchanged lines are never part of an edit.
- Table views (interface, data block, translations, tag table) refresh when another file of the same PLC folder changes, debounced with the workspace model (150 ms); the view's own document keeps refreshing on its own changes. Views report a render count to the hidden health command, which the integration test uses.

## 2026-10-24 – Incremental analysis (M2.9, M6.8)

- Symbols are extracted per file and kept while the file object and the settings revision (manifest, rules) stay the same; the index is assembled from them on every change (a few ms at 5,000 blocks).
- A block's binding is reused unless one of these holds, checked in this order: no earlier analysis, the manifest or the rules changed, or the set of block, tag and constant names changed (names may resolve differently): every block is bound. Otherwise a changed file whose signature (the text without the code part of each block, plus the flags other blocks read: kind, DB kind, incomplete, fail-safe, published, IEC check, optimized) is unchanged binds only its own blocks. A changed signature, or a file that came or went, also binds every block whose declarations use one of its blocks as a type (repeated through types of types and tags typed with them), every block that references a symbol owned by one of those blocks or tags, and, for a tag table, every block file that mentions a changed tag or constant. `.s7res`, OB SimaticML and other files bind nothing.
- Ownership: a member id belongs to the block (or tag) at its start (`member:ns.fb/a/b` → `block:ns.fb`). Instance and multi-instance members resolve to the FB's member ids, so they belong to the FB.
- Single-block analyzer findings are cached per block. They run again when the block was bound again, the settings changed, or a block bound in this revision references (now or before) an owner whose references the rules looked up; the lookups are recorded while the rules run, and a rule that reads all references makes the result non-reusable.
- References by symbol are updated in place of being rebuilt: only the lists of symbols the rebound blocks referenced before or reference now are rebuilt, in the order a fresh build gives (tag declaration first, then block order). A tag table change rebuilds them completely.
- Suppression comments are scanned once per file version. The analyzer context builds its lookups per file and per owner when first asked, not for the whole PLC.
- Proof: the tests compare every result after scripted edits (body, error, interface, type, tag table, rename, delete, add, manifest, rules) with a fresh analysis of the same texts, and fail when the declaration rule or the analyzer's lookup rule is switched off.

## 2026-10-24 – Fail-safe rules from verification batch 2 (M7.6)

- The fail-safe interface types moved from code into the profile's new `failsafe.interfaceTypes` (hard rule 6), proven by B23, B39 and C35. Before, twelve types were errors without a corpus case; now every refused type is proven, and a Struct (refused at import, message unclear) is a warning.
- New error rules, each with corpus cases: `box-type-missing` (B40, B41), `failsafe-call` (B43, B44), `failsafe-standard-write` (B42), `failsafe-read-write` (B45). New warning: `failsafe-unused`.
- The safety program is the set of F-blocks reachable from the main safety blocks, which only the new `mainSafetyBlocks` of `plc.json` can name. With them, `failsafe-read-write` is an error and F-blocks outside get `failsafe-unused`; without them the read/write rule is a warning on every F call tree and nothing is listed as unused (recommended option: no error that depends on a guess).
- `failsafe-read-write` covers bit memory and members of standard DBs. Input and output tags are left out, because the files do not say which of them are fail-safe I/O. A struct whose members are read and written separately is not one operand.
- MAX, MIN and Limit stay "not permitted in F" without proof (warnings): TIA refused MAX with an unclear message and crashed on Limit.
- The `plc.json` schema now also lists `obs` and `failsafeBlocks`, which the code read but the schema rejected (VS Code flagged them), and the new `mainSafetyBlocks`.

## 2026-10-24 – Array DB start values are editable (supersedes "shown but not edited")

- Corpus C40 shows the format: `THIS[i] := value;` per element in both formats. The data block editor now edits element start values of array DBs with elementary element types; new values go in index order, as TIA writes them. Arrays of PLC data types stay read-only until a sample shows their start values.

## 2026-10-24 – Verification session 5: F-instructions, tag table flags

- MAX, MIN and LIMIT in fail-safe blocks are now errors (`failsafe-instruction`, corpus B46): TIA does not know these instructions in F_LAD, proven with controls (Max found in standard LAD, Move found in F_LAD). B46 has no TIA export, since every import was refused; its files are the SIMATIC SD text that was tried, and a corpus test checks the errors on them.
- Tag tables: a missing ExternalVisible/ExternalWritable follows ExternalAccessible (C04 in both SimaticML styles). The reader assumed true before, so a hidden tag from a VCI export read as visible and writable. The tag table editor now writes the two flags only where the file states them, as each exporter does.
- The empty LAD/FBD box stays an owner item: neither import format can create one.
- Skills: Anthropic's official plugin marketplace was searched. `typescript-lsp` (code intelligence for this TypeScript codebase) was installed with local scope, for this project only, together with the `typescript-language-server` npm package it needs; it is active from the next session. The security review used the built-in `security-review` skill (no vulnerability above its bar; the CSV formula guard was added anyway).

## 2026-10-24 – Release workflow, prepared for the owner (M9.4, M9.5)

- `.github/workflows/release.yml` runs on version tags: all tests, the `.vsix` on a GitHub release, and Marketplace publishing with Microsoft Entra ID through GitHub's OpenID Connect (no stored token), only when the repository variable `MARKETPLACE_PUBLISH` is `true` and after approval in the `marketplace` environment. The pre-release flag follows the spec (odd minor). The owner's setup steps and the two open decisions (name, icon) are in `docs/RELEASE.md`.
- Committed log files of an earlier parallel session (`.claude-fork-*.log`) were removed from the repository and are ignored.

## 2026-10-24 – Final icon; empty box (session 6)

- The extension icon is final (M9.4 reserves only the name for the owner): an own design with two power rails, a rung with a contact and a coil, and a rung through a box holding lines of code, so it shows LAD, FBD and SCL without any name or trademark. Its source is `packages/extension/images/icon-source.svg`; `scripts/icon.mts` renders it to `images/icon.png` in Chromium. The source is kept so the icon can be changed without redrawing it.
- Empty LAD/FBD box: the part names `EmptyBox` and `Box` are unknown to TIA as well, and an empty name is a schema error. It stays an owner item (TIA's editor only).
