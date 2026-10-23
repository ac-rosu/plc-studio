# PLC Studio

A VS Code extension for SCL, LAD and FBD programs of S7-1200 and S7-1500 PLCs: a checker that reports only what TIA Portal would reject, editor features, an analyzer, and graphical LAD/FBD views. It works only on files exported from TIA Portal V21 and never connects to TIA, PLCSIM or a PLC.

Status: pre-release 0.1.0, not yet published. All milestones of the plan are done except publishing and the final name; see [PLAN.md](PLAN.md). What the extension does for its users: [packages/extension/README.md](packages/extension/README.md).

## Documents

- [docs/SPEC.md](docs/SPEC.md): what the extension does
- [GLOSSARY.md](GLOSSARY.md): the terms used throughout
- [docs/adr/](docs/adr/): architecture decisions
- [docs/format-notes.md](docs/format-notes.md): facts about TIA's export formats
- [DECISIONS.md](DECISIONS.md): smaller design decisions

## Development

Requires Node.js 24 or later.

```text
npm ci
npx playwright install chromium   # once, for the browser tests
npm run build
npm run lint
npm run typecheck
npm test                 # unit tests
npm run test:corpus      # corpus gates
npm run test:web         # core, language server and webviews in a browser
npm run test:integration # the extension in a real VS Code
npm run corpus:report    # gate report for the corpus
npm run package          # .vsix in dist/
```

Packages: `packages/core` (parsers, model, checker; web-safe), `packages/profiles` (version data), `packages/language-server`, `packages/extension`, `packages/webviews`, and `tools/corpus-harness` (corpus gates).

## Privacy

No telemetry and no network calls. Nothing leaves your machine.

## Safety

PLC Studio is not a safety-certified tool. Changes to fail-safe blocks must be compiled in TIA Portal and accepted by a qualified person.

## Trademarks

SIMATIC, STEP 7, TIA Portal and Siemens are trademarks of Siemens AG. This project is not affiliated with or endorsed by Siemens.

## License

[MIT](LICENSE)
