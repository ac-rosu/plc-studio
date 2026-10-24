# PLC Studio

PLC Studio (working name) is a VS Code extension for SIMATIC S7-1200/1500 programs in SCL, LAD and FBD. It works only on files exported from TIA Portal. Extension id `plcstudio`, command prefix `PLC Studio:`, settings prefix `plcstudio.`.

Read at the start of every session:

- [docs/SPEC.md](docs/SPEC.md): the source of truth
- [GLOSSARY.md](GLOSSARY.md): the terms to use in code, messages and docs
- [docs/adr/](docs/adr/): decisions that are not undone without the owner
- [PLAN.md](PLAN.md): milestones, tasks, verification and status
- [DECISIONS.md](DECISIONS.md): design decisions made during the work
- [docs/format-notes.md](docs/format-notes.md): format facts and surprises, with evidence
- `corpus/<version>/_project/format-findings.md` and `run-log.md`: how the corpus was built, and what TIA did

## Hard rules

1. Work only on the current milestone. When its acceptance criteria are met, stop and report what works, what doesn't, what you learned, and the proposed plan for the next milestone. Wait for the owner's acceptance.
2. No TIA connection in the product: the extension works only on files. Never add code that talks to TIA Portal, PLCSIM, a PLC or an MCP server.
3. Zero false errors: never report an error for code TIA accepts. The only exceptions are the policy errors listed in [ADR 0013](docs/adr/0013-policy-errors-stricter-than-tia.md) (recursion; identifiers that differ only by case), and only the owner adds to that list. If a rule cannot decide, it reports a warning or info. Every error rule needs corpus cases proving it.
4. Faithful round trips: lossless syntax trees; unchanged files print byte-identical; edits change only the affected lines; `.s7res` comment ids are never renumbered. Unknown constructs are kept and marked "not analyzed", never errors.
5. `packages/core` and `packages/language-server` must not import Node or VS Code APIs (web-safe).
6. Everything that differs per TIA version or CPU family is version-profile data, not code.
7. Facts about SCL, LAD, FBD, data types, instructions and TIA formats come from the `tia-portal-s7-programming` and `tia-openness-v21` skills or from corpus evidence. Never guess; record new findings in `docs/format-notes.md`.
8. Intellectual property: never copy Siemens text, tables, images or icons, and never copy skill text, into code, data, docs or tests. Write every message, description and doc in your own words. No Siemens trademarks in names, icons or the publisher.
9. `corpus-private/` is gitignored and never committed, uploaded or quoted. The public corpus contains only blocks written for this project.
10. No telemetry and no network calls.
11. Follow the Marketplace rules in the spec from the first commit (icon, images, keywords, versioning, `package.json` fields).
12. New design questions not covered by the spec: stop and ask the owner, using the grill-with-docs approach. That skill was not installed on 2026-10-23; until it is, ask focused questions, one topic at a time, each with a recommended answer checked against the spec, glossary and ADRs. Record decisions as ADRs only when they are hard to reverse, surprising and a real trade-off; everything else goes into `DECISIONS.md`.

## Build and test commands

Node.js 24 LTS is installed in `%LOCALAPPDATA%\Programs\nodejs` and on the user PATH. A shell started before the install may not see it; then prefix `PATH="/c/Users/User/AppData/Local/Programs/nodejs:$PATH"` (Git Bash).

```text
npm ci                          install (npm 11 holds back install scripts; esbuild and vsce work without them)
npx playwright install chromium once, for test:web
npm run build                   esbuild bundles: core (platform neutral), language server (Node + browser), extension
npm run lint                    ESLint (web-safety and no-network rules) + Prettier check
npm run format                  Prettier --write
npm run typecheck               tsc --noEmit for the root and every workspace
npm test                        Vitest project "unit" (Node)
npm run test:corpus             Vitest project "corpus": corpus well-formed, gates pass
npm run test:web                Vitest project "web": core and language-server tests in Chromium, plus the
                                language server's handshake in a real Web Worker
npm run corpus:report           Markdown gate report (round trip, false errors, error coverage, policy errors)
npm run package                 production build, allowlist check, dist/plcstudio-<version>.vsix
```

`npm run test:integration` runs the extension in a real VS Code (@vscode/test-electron, downloaded once into `packages/extension/.vscode-test`): every feature, and every webview must report that it rendered. Webview tests (`*.web.test.ts`) run in the `web` project, with an axe-core accessibility audit.

Before every commit: `build`, `lint`, `typecheck`, `test`, `test:corpus` and `test:web` pass.

## Repository layout

```text
packages/
  core/             parsers (SD, external sources, SimaticML tag tables), lossless trees,
                    project model, units, type checker, call graph, analyzer, formatter, writer
  profiles/         version profile data (V21; later versions added as profiles) + JSON Schemas
  language-server/  LSP over core; Node and browser entry points
  extension/        VS Code client: commands, views, custom editors host, coexistence check
  webviews/         LAD/FBD viewer and editor, interface, DB, tag table and translation tables,
                    program graph
schemas/            plc.schema.json, rules.schema.json (published with each release)
corpus/             public test corpus (only blocks written for this project)
corpus-private/     gitignored; the owner's real project blocks for local runs
docs/adr/           architecture decision records
docs/format-notes.md
tools/
  corpus-harness/   Node-only: loads the corpus, assembles PLCs, computes the release gates
GLOSSARY.md  CLAUDE.md  PLAN.md  DECISIONS.md
```

The corpus as the owner's corpus build delivers it:

```text
corpus/<TIA version>/
  _project/          setup.json, raw compile records (compile-*.json), draft manifests,
                     format-findings.md, run-log.md, manual-steps.md
  <case>/            C* clean, C26* analyzer, B* broken (each B mutates a C case)
    expected.json    TIA's result: objects, exports and refusals, compile messages,
                     intendedError, analyzerExpect
    documents/       .s7dcl/.s7res as the export tool returns them (no BOM)
    vci/SimaticSD/   the same files as VCI writes them (with BOM)
    vci/SimaticML/   SimaticML as VCI writes it
    simaticml/       SimaticML from Openness Export (OBs also as *.readonly.xml)
    source/          .scl/.udt/.db from GenerateSource
    tagtables/       tag tables (SimaticML + the tool's JSON)
```

All cases of one TIA version come from one TIA project with two PLCs (PLC_Main: S7-1500F, PLC_1200: S7-1200), and cases reference each other (for example C12's OB_Main calls blocks of other cases). The harness therefore loads each PLC as a whole and reports results per case.

## Code conventions

- TypeScript 6, strict, everywhere (not 7: typescript-eslint does not support it yet). ESLint + Prettier decide formatting; do not argue with them by hand.
- Relative imports carry the `.ts` extension, and only erasable TypeScript syntax is used (no enums, no parameter properties), so Node 24 can run tools and scripts directly (`node file.ts`). Workspace packages export their `src/index.ts`; there is no separate compile step.
- Files in `corpus/` are test data: never reformat, re-save or convert them. `.gitattributes` keeps git from touching their CRLF and BOM.
- `core` and `language-server`: no `node:*` modules, no `vscode`, no globals that exist only in Node. File access only through the abstract file system the extension provides. ESLint enforces this.
- Version facts (instructions, types, conversion rules, syntax features, SD spellings, F-catalog, CPU differences) live in `packages/profiles` as JSON. Never put them in code as literals.
- Use the glossary's terms in identifiers, messages and docs, and avoid the synonyms it lists (`Network`, not `Rung`, for a numbered section; `TagTable`, not `SymbolTable`).
- Lossless trees: never re-print a whole file. An edit is a text change on the nodes it affects. Keep each file's BOM, encoding, line endings and final newline.
- Diagnostics have stable kebab-case rule ids (as in the spec's `plcstudio.rules.json` example), a severity per the spec's table, and a short, specific message in our own words. TIA's message for the same fault is recorded in the corpus for comparison, never copied.
- Tests: Vitest, `*.test.ts` next to the code. Every editor operation has golden-diff tests. Every error rule has corpus cases.
- Commits: `feat(scope): …`, `fix(scope): …`, `test(scope): …`, `docs(scope): …`, `chore(scope): …`; scope is the package (`core`, `profiles`, `language-server`, `extension`, `webviews`) or `schemas`, `corpus`, `docs`, `repo`. One commit per finished task.

## Working style

- Start each milestone by listing its tasks and how each will be verified (in `PLAN.md`).
- Write tests with the code; run build, lint and all tests before every commit; commit per finished task.
- Keep `PLAN.md`, `DECISIONS.md` and `docs/format-notes.md` current, so a new session can resume from them.
- Corpus cases that need TIA results: prepare the case files and a list of what the owner must export or compile on the TIA machine. The owner runs it with their own tools and hands back the results. Since 2026-10-24 the owner also allows Claude to use the TIA MCP server and the TIA skills directly to double-check facts and build corpus cases, only in the corpus project under `C:\TiaProjects\Corpus`, never with online functions or a real PLC. The product itself still never talks to TIA (rule 2).
- A TIA result that contradicts the spec (code the spec calls an error that TIA accepts, or the reverse): stop and ask the owner. Do not resolve it yourself.

## Autonomous mode (owner, 2026-10-24)

The owner asked Claude to finish all milestones without stopping for acceptance in between, taking the recommended option when a decision is open and recording it in `DECISIONS.md`. Rule 1's stop-and-report applies at the end of the run instead of after each milestone. Publishing to the Marketplace and choosing the final name stay with the owner.

## Current milestone

Autonomous run finished on 2026-10-24: M0–M12 are done except the items marked `[~]` or **(owner)** in `PLAN.md`. Waiting for the owner's review of the whole run, the final name, and the publishing decision (M9.4, M9.5).
