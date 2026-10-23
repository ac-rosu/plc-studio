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
