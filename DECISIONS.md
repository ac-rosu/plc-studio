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
