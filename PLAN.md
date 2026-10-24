# Plan

Milestones from [docs/SPEC.md](docs/SPEC.md), each broken into tasks with how each task is verified. The acceptance criteria are copied from the spec. Work happens only on the current milestone (see CLAUDE.md).

Status: `[ ]` open · `[~]` partly done · `[x]` done · **(owner)** needs the owner

State on 2026-10-24 (end of the autonomous run): M0–M12 done; only the owner's items are open (M9.4 final name, M9.5 publishing). Gates: round trip 472/472 files; zero false errors in every PLC and variant; error coverage PLC_Main 73/80 (SIMATIC SD; the 7 misses are B06, where a missing block is a warning by design), 71/80 (sources), PLC_1200 2/2; the recursion policy error found; 19/19 analyzer expectations found. Corpus: 100 V21 cases (verification sessions added 35). Tests: 224 unit, 622 corpus, 190 browser, 13 VS Code integration.

## Owner actions

- [x] Node.js LTS on the development machine: v24.22.1 with npm 11.19.1, installed 2026-10-24 in `%LOCALAPPDATA%\Programs\nodejs` (user PATH).
- [x] **(owner)** Repository https://github.com/ac-rosu/plc-studio, publisher `acro`.
- [x] **(owner)** First push to GitHub: done in the autonomous run (2026-10-24).
- [~] **(owner)** New V21 corpus cases, needed before M1 can claim every construct (format-notes, 2026-10-24). Most were built by Claude with the TIA MCP server in the two verification batches:
  1. Done: `FOR … BY`, `RETURN` and `GOTO` with a jump label (C28).
  2. Done: the negative edge coil `N_Coil` (batch 1). Open (owner): an empty box in LAD and in FBD. Sessions 5 and 6 showed that neither import format can create one (SimaticML: no instruction `???`, `EmptyBox` or `Box`; SD: syntax error), so only TIA's editor can make the sample.
  3. Done: C04's tag tables exported through Openness (`Export`, `WithDefaults`) next to the VCI files (C04 `simaticml/`), plus a new table in that style (C41). Both styles read the same; the comparison found that a missing ExternalVisible/ExternalWritable follows ExternalAccessible.
  4. Done: an AT overlay in `.s7dcl` is refused at import (batch 1, format-notes "SIMATIC SD export drops AT overlays").
  5. Done: an identifier with a space compiles in TIA (C32; spec conflict recorded for the owner). Done: MAX, MIN and LIMIT are not available in F-blocks (B46, session 5).
- [ ] **(owner, optional)** Open corpus manual steps from `corpus/V21/_project/manual-steps.md`: OB40 priority (C15); B12/B16 case-only duplicates in TIA's editor.

## Rough size

Claude's working time per milestone, in working days of sessions, excluding the owner's reviews and TIA runs. Estimates, easily off by a factor of two; corrected as milestones finish.

| M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 | M9 | M10 | M11 | M12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2–3 | 1–2 | 4–6 | 2–3 | 2 | 2 | 2–3 | 3 | 1 | 4–5 | 1–2 | 1–2 |

M3 is the largest because of the instruction catalog (every entry written in our own words and verified through corpus cases); M10 because every graphical edit must write back only the lines it touches.

---

## M0 – Setup and format spike

**Delivers (spec):** monorepo, CI on Windows/Linux/macOS, schema skeletons, corpus harness, `docs/format-notes.md` with samples of every construct from every exporter for V21.

**Acceptance (spec):** CI green; open facts answered: OB priority/cyclic time in `.s7dcl`, F-block detection in files, `.s7res` layout, line numbering; at least 50 corpus cases with TIA results.

- [x] **M0.1 Step 1 working files**: `CLAUDE.md`, `PLAN.md`, `DECISIONS.md`, `docs/format-notes.md`, git repository.
  Verify: the owner reviews them.
- [x] **M0.2 Monorepo skeleton**: root `package.json` with npm workspaces; packages `core`, `profiles`, `language-server`, `extension`, `webviews`; a shared strict `tsconfig`; esbuild configs (Node and browser builds of the language server); ESLint + Prettier; Vitest; one smoke test per package.
  Verify: `npm ci`, `build`, `lint`, `typecheck` and `test` pass locally on Windows. Done 2026-10-24.
- [x] **M0.3 Web-safety guard**: an ESLint rule that forbids Node built-ins, `node:*` and `vscode` in `core` and `language-server`; `test:web` runs both packages' tests in a browser worker.
  Verify: a test import of `node:fs` in `core` fails lint; `npm run test:web` passes. Done: lint probes for `node:fs`, `vscode`, the Node LSP transport, `fetch` and `process` all fail; the language server answers `initialize` in a real Web Worker (browser entry) and over stdio (Node entry).
- [x] **M0.4 Extension manifest, Marketplace-compliant from the first commit**: id `plcstudio`; MIT `LICENSE`; `publisher`, `repository`, `bugs` and `homepage` set; `engines.vscode` as a caret range; version `0.1.0` (pre-release line); at most 30 keywords; `.vscodeignore` (no corpus, tests or source maps); placeholder icon of our own design as a PNG of at least 128×128 px; the language ids `plcstudio-scl`, `plcstudio-s7dcl`, `plcstudio-s7res` and `plcstudio-tagtable` with their file associations.
  Verify: a test checks `package.json` against the spec's Marketplace list; `vsce ls` shows no corpus, test or map files. Done: `npm run package` checks the file list against an allowlist (9 files, 152 KB).
- [x] **M0.5 CI**: GitHub Actions on Windows, Linux and macOS running `npm ci`, `build`, `lint`, `typecheck`, `test`, `test:corpus` and `test:web`.
  Verify: CI is green on all three. Done: tests pass on all three since the first push; the package step failed from the grammars commit on (allowlist pattern) until 2026-10-24, fixed.
- [x] **M0.6 Schema skeletons**: `schemas/plc.schema.json` (from the spec's manifest example), `schemas/rules.schema.json` (from the rules example), and a profile schema in `packages/profiles` (instruction catalog, system types, type rules, syntax features, SD format details, F-catalog, CPU-family differences, `verified` flag, `extends`), plus an empty `profiles/V21`.
  Verify: tests validate the spec's examples and the empty profiles, and reject deliberately broken files.
- [x] **M0.7 `expected.json` schema**: describes the format the corpus build writes (objects, exports and refusals, compile messages, `intendedError`, `analyzerExpect`).
  Verify: all 65 V21 `expected.json` files validate. Done (tag-table objects have no number, namespace or consistency state).
- [x] **M0.8 Corpus harness**: finds the cases per TIA version; loads each PLC as a whole (all cases of PLC_Main, all of PLC_1200), because cases reference each other; maps every file to its case and exporter variant (`documents/`, `vci/SimaticSD/`, `vci/SimaticML/`, `simaticml/`, `source/`, `tagtables/`); computes the gates: round trip, zero false errors (an error on a TIA-clean case fails the gate unless it is an expected ADR 0013 policy error) and error coverage (an error at TIA's line or network for each broken case); writes a per-case report. Until M1 the parser is a placeholder that keeps the text unchanged, and the checker reports nothing.
  Verify: the harness finds 65 V21 cases (28 clean, 14 analyzer, 23 broken), every file listed in `expected.json` exists, and `npm run test:corpus` passes and prints the report. Done: 423/423 files round-trip with the placeholder; error coverage 0/28 (PLC_Main) and 0/2 (PLC_1200) as expected without a checker; `npm run corpus:report` prints the report.
- [x] **M0.9 Construct samples for V21 in `docs/format-notes.md`**: an index from each construct (SCL statements, declaration forms, DB kinds, OB kinds, every LAD/FBD element in the spec's viewer list, units, F-blocks, tag tables, multilingual texts) to a corpus file and line for each exporter. Constructs with no sample go on a list of new cases for the owner.
  Verify: every construct in the spec's LAD/FBD viewer list and the profile's "syntax features" has a V21 sample or is on the owner's list. Done: 95 constructs indexed. Five have no sample and are on the owner's list above; the sixth gap (AT overlay in `.s7dcl`) is a format finding, not a missing case. Found on the way: `.s7dcl` drops AT overlays; VCI SimaticML leaves out default attributes.
- [x] **M0.10 Open facts for V21**: OB attributes, F-block detection, `.s7res` layout and line numbering are answered in `corpus/V21/_project/format-findings.md` 1–4 and summarized in `docs/format-notes.md`.
- [x] **M0.11 At least 50 corpus cases with TIA results**: V21 has 65.
- [x] **M0.12 Spec and glossary follow-up**: edits for ADR 0013 (policy errors) and for moving V20 to a later version, made at the owner's request (2026-10-24).

The corpus harness lives in `tools/corpus-harness/` (owner-approved, DECISIONS 2026-10-24).

## M1 – Lossless parsers and writer

**Delivers (spec):** parsers for `.s7dcl`, `.s7res`, `.scl`, `.udt`, `.db`, SimaticML tag tables; syntax errors with recovery.

**Acceptance (spec):** round-trip gate 100% on the corpus; unknown constructs kept and marked.

- [x] **M1.1 Lossless tree foundation** (`core`): text with BOM, encoding and line-ending detection; tokens with trivia; nodes that cover every character; printer; "not analyzed" node kind; offset ↔ line/column mapping; TIA line numbering (after `BEGIN` or `NETWORK`).
  Verify: unit tests; property test that print(parse(x)) equals x for random input, including garbage.
- [x] **M1.2 `.s7res` parser**: the YAML subset TIA writes, with ids, cultures and quoting rules.
  Verify: every corpus `.s7res` round trips; texts with quotes and special characters (C05, C01) read back as the right values.
- [x] **M1.3 `.s7dcl` declarations**: header attribute blocks, `NAMESPACE` wrapper, block kinds (OB, FB, FC, global/array/instance DB, UDT), sections, members with attributes, start values, arrays, structs, UDT and FB types, quoted identifiers.
  Verify: every corpus `.s7dcl` round trips; symbol snapshots for C01–C03, C11, C22–C24.
- [x] **M1.4 SCL statements**: one grammar shared by `.s7dcl` SCL networks and external sources, including the body indentation of each format.
  Verify: C05–C10, C12–C15, C26*, and the SCL B-cases round trip; a tree test for each statement kind.
- [x] **M1.5 LAD/FBD networks in `.s7dcl`**: rungs and wires, contacts, coils, boxes, calls, templates, jumps and labels, branches, open branches, SCL networks in LAD blocks, network title and comment ids.
  Verify: C16–C21, C24, B18–B20 and B25 round trip; element-level tree tests.
- [x] **M1.6 External sources**: `.scl`, `.udt`, `.db` with `TITLE`, attribute blocks, `VERSION`, sections, the `BEGIN` body with its TAB prefix, `NAMESPACE` lines, and the CRLF CRLF ending.
  Verify: every corpus `source/` file round trips.
- [x] **M1.7 SimaticML tag tables**: lossless XML for tag tables only.
  Verify: the C04, C22 and C25 tag tables round trip; tags and user constants come out with address, type, access flags and comments per language.
- [x] **M1.8 Syntax errors with recovery**: error nodes, own-wording messages, positions mapped to TIA lines.
  Verify: no syntax error on any TIA-clean corpus file; B02, B03 and B25 report an error at TIA's recorded line or network.
- [x] **M1.9 Round-trip gate**: the harness checks every corpus file in every exporter variant.
  Verify: 100% byte-identical.
- [x] **M1.10 Minimal-edit writer API**: replace a node's text, insert or delete lines; keep line endings, BOM and indentation.
  Verify: golden-diff tests show only the expected lines changing.
- [x] **M1.11 Unknown constructs**: kept unchanged, marked "not analyzed", reported as info.
  Verify: files with invented attributes and pragmas round trip and produce only info.
- [x] **M1.12 Parse performance baseline**: time for the whole corpus, and for a generated 5,000-block PLC.
  Verify: numbers recorded here. Done: the generated PLC (about 4,900 blocks) parses and checks in about 0.5 s; re-checking after one edit takes about 150 ms (Windows laptop, Node 24).

Open questions (ask at the start of M1):

- AT overlays are missing from `.s7dcl` (format-notes 2026-10-24). How should the extension treat a non-optimized block whose `.s7dcl` may have lost an overlay? Answered by the verification batch: SIMATIC SD cannot express AT at all; TIA refuses the import. Rules that depend on overlays skip non-optimized blocks read from `.s7dcl` (DECISIONS, analyzer).

## M2 – Project model

**Delivers (spec):** manifest + schema, units and namespaces, symbol tables, tag tables, `.s7res` linking, profile V21 base data.

**Acceptance (spec):** definitions and references resolve across files and units in the test suite; unit access rules enforced.

- [x] **M2.1 Manifest**: final `plc.schema.json`, loader, and the scan logic behind `PLC Studio: Create manifest` (the command itself comes in M4); syntax-only mode without a manifest.
  Verify: schema tests; scanning the corpus PLCs proposes the expected manifests.
- [x] **M2.2 Abstract file system and PLC folders**: interface, in-memory implementation, PLC folder discovery, several PLC folders per workspace.
  Verify: tests on the in-memory file system.
- [x] **M2.3 Symbol tables**: blocks, DBs, UDTs, interface members, tag tables (tags and user constants), and system types from the profile.
  Verify: symbol snapshots per corpus PLC.
- [x] **M2.4 Reference resolution**: `#local`, `"global"`, `_.Ns.Object`, unqualified names inside the same namespace, member paths, array indexes, instance members; across `.s7dcl` and external sources.
  Verify: definition and reference tests across files and units (C08, C12, C22, C23).
- [x] **M2.5 Software units**: namespaces from the files; unit membership and relations from the manifest; published state from the files; errors for relation rings, use of unpublished objects, and missing relations.
  Verify: B21 and B22 report errors at TIA's line or section; C22 and C23 report none.
- [x] **M2.6 Name uniqueness**: tags unique across the PLC, blocks unique per scope; identifiers that differ only by case are a policy error (ADR 0013).
  Verify: project-written mutations of C05 and C01 in `.s7dcl` and `.scl` report the error; no error on any clean case.
- [x] **M2.7 `.s7res` linking and display language**: comment ids resolved; missing translations as info.
  Verify: C02 (`MLC_4DE` without de-DE) gives one info; per-language text tests.
- [x] **M2.8 Profile base data V21**: system data types and constants, the catalog entries the corpus uses, `verified` flags, an F-catalog skeleton.
  Verify: profiles load and validate; every instruction used in the corpus is in the catalog; coverage report.
- [x] **M2.9 Incremental updates per file**.
  Verify: changing one file recomputes only the symbols that depend on it. Done: only the changed file is parsed and its symbols extracted again; a block is bound again only when its file or a declaration it depends on changed (DECISIONS, "Incremental analysis"). `analysis.stats` counts extracted files and bound, reused and analyzed blocks; tests in `check/incremental.test.ts` (also in the browser) and `incremental.corpus.test.ts` prove what is recomputed and that the result always equals a fresh analysis. On the generated PLC (4,866 blocks): a body edit binds 1 block and re-runs single-block rules for 3, re-checked in about 75 ms; a full re-check, what every edit cost before, takes about 400 ms.

Open questions of M2, answered with the recommended option (DECISIONS):

- OB type, number, cycle time and priority: both; the manifest's `obs` entry, else the SimaticML export next to the `.s7dcl`; program-cycle and startup OBs default to priority 1.
- Published state: the file's attribute wins; the manifest's `units[].published` is used only when the file says nothing.
- IEC check: the block's `S7_IECCheck` wins; the manifest's `compiler.iecCheck` applies where the file has none (external sources).
- The draft manifests in `corpus/V21/_project/` are not used; the harness builds manifests from each case's `setup.json`.

## M3 – Type checker

**Delivers (spec):** TIA-equivalent errors with IEC check on and off.

**Acceptance (spec):** zero-false-errors gate passes; error-coverage baseline recorded.

- [x] **M3.1 Type model from the profile**: elementary types, strings, time types, arrays (including `Array[*]`), structs, UDTs, `REF_TO`, `VARIANT`, `DB_ANY`, system types.
  Verify: unit tests.
- [x] **M3.2 Expressions and implicit conversions**: the conversion matrix from the profile, IEC check per block.
  Verify: B08 reports an error; C10 (`FC_IecOff`) and B07 report none.
- [x] **M3.3 Literals, limits, start values**.
  Verify: B15 reports an error in the interface; no error on C02, C03 or C11.
- [x] **M3.4 Assignment targets and references**: assignment to a constant, and the target type of a dereference.
  Verify: B09 and B17 report errors.
- [x] **M3.5 Calls**: formal parameter names, required InOut parameters, missing blocks, parameter types, instance forms, `EN`/`ENO`.
  Verify: B04, B05, B06 and B14 report errors at TIA's line.
- [x] **M3.6 Statements**: `FOR` counter type and direct counter changes, `CASE` labels.
  Verify: B11 and B26 report errors; B10 (a duplicate label, which TIA only warns about) reports none.
- [x] **M3.7 CPU-family availability** from the profile.
  Verify: B24 reports an error on PLC_1200; C25 reports none.
- [x] **M3.8 LAD/FBD operands and pins**: operand types on contacts and box pins, unwired required inputs.
  Verify: B18, B19 and B20 report an error in the right network.
- [x] **M3.9 Downgrades**: unverified catalog entries, unresolved references and "not analyzed" constructs produce only warnings or info.
  Verify: tests with unverified entries and partial PLCs.
- [x] **M3.10 Gates**: zero false errors on every TIA-clean case; error-coverage baseline per case recorded.
  Verify: `test:corpus` passes; the baseline is committed.

New corpus cases: identifiers with spaces were tested (C32): TIA compiles a quoted local with a space, so `invalid-identifier` is info, not error (spec conflict, owner's call; DECISIONS 2026-10-24). Still to request: an F-instruction that is not allowed in an F-block.

## M4 – Editor features

**Delivers (spec):** everything in "Editor features (v1)", multilingual hover, coexistence check.

**Acceptance (spec):** integration tests for each feature; diagnostics within 200 ms.

- [x] **M4.1 Language server and client**: Node and browser entry points, document sync, the workspace's PLC folders.
  Verify: integration test starts the server and opens corpus files.
- [x] **M4.2 Diagnostics**: publishing, debouncing, the 200 ms target.
  Verify: a timing test on a large SCL block.
- [x] **M4.3 Completion**: locals, globals, struct members, namespaced unit objects, instructions with parameter snippets, enum-like constants, typed literals.
- [x] **M4.4 Hover**: type, initial value, comment in the display language (other languages listed), declaration site; for instructions, our own description plus the link to Siemens' online help.
- [x] **M4.5 Signature help** for FB/FC calls and every instruction in the profile.
- [x] **M4.6 Go to definition, find references, rename** across files and units (blocks, tags, DB members, UDT fields, interface members, constants).
- [x] **M4.7 Inlay hints** for parameter names in calls.
- [x] **M4.8 Quick fixes**: declare a variable in the right section, add missing call parameters, insert an explicit conversion, publish an object, add a unit relation.
- [x] **M4.9 Outline and workspace symbols**, with namespaces.
- [x] **M4.10 Semantic highlighting, `REGION` folding, call hierarchy, CodeLens with reference counts.**
- [x] **M4.11 `PLC Studio: Create manifest`** and the prompt when a manifest is missing.
- [x] **M4.12 Coexistence check**: detect other extensions that claim the same file types and offer a one-click switch of the file association, without changing those extensions.
  Verify for M4.3–M4.12: one `@vscode/test-electron` integration test per feature, on corpus files.

## M5 – Analyzer

**Delivers (spec):** single-block rules, `plcstudio.rules.json`, declarative custom rules, naming presets, formatter on changed lines.

**Acceptance (spec):** every rule has passing and failing corpus cases; formatter never touches unchanged lines.

- [x] **M5.1 Rule framework and `plcstudio.rules.json`**: schema, loading at workspace and PLC-folder level (the PLC folder wins), `extends: ["recommended"]`, severity overrides, options.
  Verify: config tests, including precedence.
- [x] **M5.2 Single-block rules**, each with a failing and a passing case: timer, counter or edge called conditionally (C26a); same instance called twice (C26b); `Temp` read before written (C26c); FC output not written on every path (C26d); output assigned twice (C26e); write to an input (C26f); global access in FC/FB (C26g); `FOR` counter modified or used after the loop (C26h); `CASE` without `ELSE` and `REAL` compared with `=` (C26i); unused variables (C26j); status not evaluated (C26n); structured types on Input/Output; implicit narrowing (C10); `WHILE`/`REPEAT` without a clear exit; SIMATIC timers/counters; unreachable code; empty `REGION`s; complexity.
  Verify: the corpus `analyzerExpect` entries match; every rule has both cases.
- [x] **M5.3 Declarative custom rules**: name patterns, forbidden or required instructions, complexity limits, forbidden global access, required comments, banned identifiers.
- [x] **M5.4 Naming presets** `default`, `siemens-prefix` and `match-workspace`, off by default. Identifiers with spaces are info, not errors: TIA compiles them (C32; spec conflict for the owner).
- [x] **M5.5 Inline suppression** with a required reason.
- [x] **M5.6 Formatter**: only changed lines on save, the whole file through "Format Document", style options in the rules file.
  Verify: golden tests show unchanged lines byte-identical after format-on-save.

New corpus cases to request: one for each rule that M5.2 does not yet map to a case.

Open questions of M5, answered with the recommended option:

- Analyzer rules cannot be raised to error by users: errors stay reserved for code TIA rejects (ADR 0003) and the owner's policy errors (ADR 0013). Can be revisited by the owner.

## M6 – Call graph

**Delivers (spec):** execution context, cross-block rules, unused variables, Trace value, call tree view, called-from summaries.

**Acceptance (spec):** every cross-block rule has corpus cases; unresolved and partial cases never produce errors.

- [x] **M6.1 Call graph**: OB roots; edges with how each call happens (unconditional, conditional with condition, loop, `EN`) and how often per cycle; instances; parameter wiring; unresolved edges; partial exports.
  Verify: graph snapshots for PLC_Main and PLC_1200.
- [x] **M6.2 Execution context**: reaching OBs, priority, cycle time, every-cycle flag. OB data from the manifest or SimaticML (M2 answer).
- [x] **M6.3 Cross-block rules**: instance not updated every cycle (C26m); instance shared across priorities (C26l); unprotected cross-priority data; multiple writers; InOut aliasing; unreliable FC output; recursion as a policy error (ADR 0013, B13); dead block (C26k); state in `Temp`.
  Verify: failing and passing cases per rule; B13 reports the policy error.
- [x] **M6.4 Unused variables** with the spec's severities and the HMI exception.
- [x] **M6.5 Trace value.**
- [x] **M6.6 Call tree view** in the sidebar.
- [x] **M6.7 Called-from summaries** in hover and CodeLens.
- [x] **M6.8 Incremental re-run** only for affected blocks. Done: single-block analyzer findings are cached per block and run again only for blocks bound again or whose rules looked up references that changed; the call graph and the cross-block rules are rebuilt from the cached per-block call sites and facts (about 25 ms at 5,000 blocks).
  Verify for M6.4–M6.8: unit and integration tests; partial-export tests produce no errors.

## M7 – Table editors and F-blocks

**Delivers (spec):** interface, DB and translation table editors; F-block detection, validation, marking and save warning.

**Acceptance (spec):** edits change only the expected lines (golden diffs); F-rules checked against corpus.

- [x] **M7.1 Custom editor host and webview messaging**: text stays the single source of truth; undo and redo go through VS Code; text and view stay in sync side by side.
- [x] **M7.2 Block interface editor.** Members can be added inside structs at any depth (also in UDTs and global DBs), and the FC return type is editable (2026-10-24, second pass).
- [x] **M7.3 Data block editor**, with instance DBs read-only except for what TIA lets the user change.
- [x] **M7.4 Translation table.**
- [x] **M7.5 F-block detection** from `S7_Safety`. Blocks that cannot be classified (for example the `.db` source of an F-DB) count as standard, with an info.
- [x] **M7.6 F-validation** from the profile's F-catalog.
  Verify: B23 reports an error; C24 reports none. Done: interface types from the profile (B23, B39, C35), box data types (B40, B41, C36, C37), calls across the boundary (B43, B44), standard writes to F-DBs (B42, C38), standard data read and written in the safety program (B45, C39) and F-blocks outside it, with the main safety blocks from `plc.json`. MAX, MIN and Limit in F-blocks stay warnings (TIA refused or crashed, no clear verdict).
- [x] **M7.7 Fail-safe marking and save warning**: banner in every editor, highlighting in the explorer and call tree, non-modal warning on every save of an F-block.
  Verify for M7.2–M7.4: golden-diff tests for every edit operation. Table views also refresh when another file of their PLC changes (a UDT, the .s7res, the manifest); tested in VS Code.

## M8 – LAD/FBD viewer

**Delivers (spec):** rendering of every construct, text fallback, themes, keyboard navigation.

**Acceptance (spec):** every corpus LAD/FBD network renders or falls back; 100 networks in under 1 s.

- [x] **M8.1 Layout engine**: power rail, numbered networks, boxes with inputs on the left and outputs on the right, branches.
- [x] **M8.2 SVG rendering** of every construct in the spec's viewer list, in the light, dark and high-contrast themes.
- [x] **M8.3 Text fallback** for networks that cannot be drawn.
- [x] **M8.4 Keyboard navigation, screen-reader labels, zoom.**
- [x] **M8.5 Diagnostics on elements; hover and go-to-definition on operands.**
  Verify: Playwright tests on every corpus LAD/FBD network; a performance test with 100 networks.

## M9 – v1 release

**Delivers (spec):** performance gates, accessibility pass, README, icon, Marketplace checklist, final name, pre-release then stable.

**Acceptance (spec):** all release gates green; published as pre-release, then v1.0.0 after the owner's sign-off.

- [x] **M9.1 Performance gates**: 5,000-block PLC indexed in under 10 s; diagnostics within 200 ms; 100 networks drawn in under 1 s (on CI, with a margin).
- [x] **M9.2 Accessibility pass.** Done: every view passes an axe-core WCAG 2.1 A/AA audit in Chromium (color contrast comes from the VS Code theme and is not audited); keyboard navigation and screen-reader labels are tested; colors come from theme variables (high contrast included).
- [x] **M9.3 README**: trademark notice, "not a safety-certified tool", no telemetry and no network calls; https images only.
- [ ] **M9.4 Final name (owner) and icon**; the Marketplace checklist from the spec. Status: everything Claude can do is done (manifest fields, MIT license, the final own-design icon drawn in `packages/extension/images/icon-source.svg` and rendered by `scripts/icon.mts`, README with https-only links, no telemetry, allowlisted package of 22 files); `docs/RELEASE.md` lists the decision left (the name), where a new name goes, and how to change the icon.
- [ ] **M9.5 Publishing (owner)**: Microsoft Entra ID publishing; pre-release on an odd minor, then v1.0.0. Status: prepared; `.github/workflows/release.yml` builds, tests and attaches the `.vsix` to a GitHub release on a version tag, and publishes with Entra ID (OpenID Connect, approval through the `marketplace` environment) once the owner sets it up as `docs/RELEASE.md` describes.

## M10 – LAD/FBD editor (v1.x)

**Delivers (spec):** palette, drag and drop, branches, networks, copy/paste, inline operands, live text sync.

**Acceptance (spec):** golden-diff tests for every edit operation.

- [x] Palette from the profile (only F-instructions in F-blocks); drag and drop; opening and closing branches; inserting, deleting and moving elements; adding, deleting, moving and copying networks, also between blocks; inline operands with completion; titles and comments in the display language; every edit rewrites only the affected network.
  Verify: one golden-diff test per edit operation.
- [x] Block interface panel above the networks (owner request after the run, 2026-10-24): the block interface editor's table in a collapsible panel, closed by default, setting `plcstudio.ladder.interfaceOpen`; edits go through the interface editor's handler.
  Verify: browser tests (closed by default, request on open, edits sent as interface edits, focus and open state kept across updates, keys stay in the panel, accessibility audit); a VS Code integration test opens the panel through the setting and waits until its table is drawn.

## M11 – Tag table editor (v1.x)

**Delivers (spec):** full editor per "Tag table editor".

**Acceptance (spec):** address and rename tests; CSV round trip.

- [x] Tags and user constants (add, rename, retype, readdress); every attribute; multilingual comments; address-overlap and address-validity checks per CPU family; system constants read-only; CSV import and export; renames that update every reference in code. A CSV import is one edit (one undo step), computed step by step and applied as minimal line edits.
  Verify: address and rename tests; CSV round trip.

## M12 – Program graph (v1.x)

**Delivers (spec):** whole-program graph webview with filters.

**Acceptance (spec):** renders the 5,000-block test PLC interactively.

- [x] Graph webview with filters by OB, unit and instance.
  Verify: the generated 5,000-block PLC renders and stays interactive.

## Later (not planned in detail)

TIA V20 (compare a small V20 export with the V21 findings first; it may need no profile of its own); GRAPH; the ISA-88/PackML rule pack; TypeScript rule plugins (trusted workspaces only); the browser release; a CLI with SARIF output.
