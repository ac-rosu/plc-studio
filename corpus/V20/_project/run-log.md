# Run log – TIA V20 corpus (M14.5)

A small V20 set for the read-only SimaticML views (ADR 0014): one object of each kind the views show, built from blocks of the V21 corpus, so that V20's SimaticML can be compared with V20's own SIMATIC SD and external source exports. Built by Claude through the tia-mcp V20 server (owner's permission of 2026-10-24: TIA only in the corpus project under `C:\TiaProjects\Corpus`, no online functions). The project was never saved.

## Session 1 – 2026-10-24

Environment: TIA Portal V20 Update 6, STEP 7 Professional V20 Update 6, STEP 7 Safety V20 Update 2; tia-mcp 1.0.0 for V20, projects root `C:\TiaProjects\Corpus` (changed from `C:\TiaProjects\V20` with the owner's permission), export root `C:\TiaProjects\CorpusExport`. Headless instance started by the server (pid 16964).

1. `project_create` → `C:\TiaProjects\Corpus\PlcStudioCorpus_V20\PlcStudioCorpus_V20.ap20`.
2. `hw_catalog_search` "6ES7 516-3AN0": the newest CPU 1516-3 PN/DP is `OrderNumber:6ES7 516-3AN02-0AB0/V2.9`. `device_create` PLC_Main with it (TIA adds OB1 `Main`, LAD, one empty network).
3. `plc_import_type` format source: V21's `C01-udts/source/UDT_Motor.udt` (without BOM).
4. `plc_generate_from_scl` (compile false): V21's `C02-global-db/source/DB_Machine.db`; then V21's C05 FB_SclSections with the body indented by four spaces instead of TIA's tab.
5. `plc_import_documents` of V21's `C16-lad-contacts/documents/FC_LadContacts.*` → refused: "ResourceID 'MultiLingualTextWithInvalidDocumentOption' not found …" (the `.s7res` has de-DE texts, the new project had only en-US). Added de-DE as project language (`om_invoke LanguageSettings/ActiveLanguages.Add(LanguageSettings/Languages[10])`), then the import succeeded.
6. `plc_import_documents`: V21's C19 FC_FbdLogic, C17 FB_LadBoxes (+ `.s7res`) and IDB_LadBoxes, unchanged.
7. `compile` PLC_Main: Success, 0 errors, 0 warnings (`compile-clean-PLC_Main.json`).
8. SimaticML: `om_invoke Export` (`ExportOptions.WithDefaults`) of the eight objects into `CorpusExport/V20/simaticml/`.
9. Sources: `om_invoke PlcExternalSourceSystemGroup.GenerateSource` (option `None`) into `CorpusExport/V20/source/` for UDT_Motor, DB_Machine, FB_SclSections, IDB_LadBoxes. Refused for FC_LadContacts, FB_LadBoxes, FC_FbdLogic and Main with TIA's "Select a block that only includes SCL or STL …" (same text as V21). Each file is the `plc_export_block`/`plc_export_type` format source text plus TIA's BOM (sizes checked: 3620/3251/133/488 characters, 3623/3254/136/491 bytes).
10. SIMATIC SD: `plc_export_block` format documents. Refused for **FB_SclSections** and **UDT_Motor** (the two objects made from external sources by `plc_generate_from_scl` / `plc_import_type`): "SIMATIC SD export failed due to project modifications made with a TIA Portal version earlier than V20 Update 4. To proceed with the export, please install and run the TIA Portal Add-In "SimaticSdEnabler" …". DB_Machine, also generated from a source, exported. The project was created in V20 Update 6, so the message's reason does not fit; recorded as TIA says it.
    - `PlcBlock.ExportAsDocuments` cannot be used through the server (it passes the file name as a path), as in V21. `documents/` holds the export tool's text with each file's final CRLF restored (V21 finding, format-findings 7). For the four blocks that came in as V21 documents, the files are V21's text with V20's two differences (finding 1 in `format-findings.md`); each matches the tool's character count (6903, 6358, 150, 1745 for the joined results), and FC_FbdLogic was compared character for character with the tool text. DB_Machine and Main are split from the tool text (5779 and 254 characters).
11. Cases (`<case>/expected.json`): C00 Main, C01 UDT_Motor, C02 DB_Machine, C05 FB_SclSections, C16 FC_LadContacts, C17 FB_LadBoxes + IDB_LadBoxes, C19 FC_FbdLogic. Case ids follow the V21 case each object comes from; C00 is TIA's default OB1. Everything in the root block and type groups.
12. The project stays unsaved (`.ap20` time stamp = creation). The headless instance closes when the server stops.
