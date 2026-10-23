# PLC Studio

Editing, checking and analysis for SCL, LAD and FBD programs of S7-1200 and S7-1500 PLCs, working on the files TIA Portal V21 exports.

> **Early pre-release.** This version registers PLC Studio's file types and starts its language server. The checker, the editor features, the analyzer and the LAD/FBD views arrive in the next pre-releases.

## What it works on

- SIMATIC SD documents (`.s7dcl` with their `.s7res` texts), external sources (`.scl`, `.udt`, `.db`) and tag tables in SimaticML, as exported from TIA Portal V21.
- One folder per PLC, described by a `plc.json` manifest. VS Code offers completion and validation in `plc.json` and `plcstudio.rules.json`.

PLC Studio works only on files. It never connects to TIA Portal, PLCSIM or a PLC: export and import stay with the tools you already use.

## Privacy

No telemetry and no network calls. Nothing leaves your machine.

## Safety

PLC Studio is not a safety-certified tool. After changing a fail-safe block, compile the safety program in TIA Portal; the collective F-signature changes, and the change must be accepted by a qualified person.

## Trademarks

SIMATIC, STEP 7, TIA Portal and Siemens are trademarks of Siemens AG. This project is not affiliated with or endorsed by Siemens.

## License

[MIT](https://github.com/ac-rosu/plc-studio/blob/main/LICENSE)
