# Manual steps for the owner – TIA V21

What the tools could not do, with exact instructions. Each item says which case it belongs to.

## Before Step 4 – server export root (not a TIA step)

The tia-mcp server runs with `--export-root C:\TiaExchange\V21`. VCI exports (`vci_workspace`, `vci_sync`) and `project_archive` only accept paths inside the export root, and the runbook requires `C:\TiaProjects\CorpusExport\`.

1. Change the tia-mcp server's start arguments in the Claude Code MCP configuration from `--export-root C:\TiaExchange\V21` to `--export-root C:\TiaProjects\CorpusExport` (keep every other argument).
2. Restart Claude Code (or reconnect the MCP server), then run `doctor` and check that `serverFlags` shows `export root C:\TiaProjects\CorpusExport`.

Status: **done** (2026-10-23). `doctor` now reports export root `C:\TiaProjects\CorpusExport` and projects root `C:\TiaProjects\Corpus`.

## C15 – priority of OB_HwInterrupt (OB40)

Openness V21 exposes no `PriorityNumber` attribute on a hardware interrupt OB (OB_DiagError OB82 was set to priority 7 with `om_set`; OB40 lists only AutoNumber, ConstantName, EventClass, ProcessImagePartNumber, …). The runbook asks for a non-default priority "where TIA allows". If you want it:

1. Open `C:\TiaProjects\Corpus\PlcStudioCorpus_V21\PlcStudioCorpus_V21.ap21` in TIA Portal V21.
2. PLC_Main > Program blocks > `OB_HwInterrupt [OB40]` > right-click > Properties > General > Attributes (or "Priority").
3. If the Priority field is editable, set it to `18` (default 16). If it is greyed out, note "not changeable" and change nothing.
4. Compile PLC_Main (software only), save the project.
5. Tell Claude Code; it then re-exports C15 and records the value. (Until then C15's OB40 keeps TIA's default priority.)

Status: open (optional).

## B22 – delete the obsolete duplicate FB_Filler_B22 (FB36)

A documents re-import (overwrite) created a second block `FB_Filler_B22` without a namespace (FB36) next to the case block `Filling.FB_Filler_B22` (FB35). Both have the path `Broken/FB_Filler_B22`, so `plc_delete`/`plc_rename` cannot tell them apart, and the generic `om_*` tools refuse to delete or rename blocks.

1. Open the project in TIA Portal V21. PLC_Main > Software units > Unit_Filling > Program blocks > Broken.
2. Select the block **FB_Filler_B22 [FB36]** (no namespace; its compile errors include "Invalid function block call '#Filling.FC_FillHelper'"). Keep `Filling.FB_Filler_B22 [FB35]`.
3. Delete FB36, compile PLC_Main (software only), save.
   Do this in a TIA instance that the tia-mcp server is **not** attached to. While the server is attached it answers TIA's "Confirm deletion" dialog with "No". It did that 6 times on 2026-10-23, and that is why the delete in the UI seemed to fail. The server was detached from that instance (pid 10932) afterwards.
4. Tell Claude Code; FB36 is then removed from the B22 folder notes. Until then FB36 is listed in `compile-broken-PLC_Main.json` and ignored in B22's `expected.json`.

Status: **done** (2026-10-23). The owner deleted FB36 in TIA's UI and saved. `plc_list_blocks` shows only `Filling.FB_Filler_B22 [FB35]`. The new compile (28 errors, no FB36 messages) is `final` in `compile-broken-PLC_Main.json`.

## B12, B16 – try the duplicate names in TIA's editor (optional)

TIA keeps neither error through Openness: SCL source generation silently renamed the duplicate (`state` → `state_1` in FB_SclSections_B12, `Enable` → `Enable_1` in UDT_Motor_B16), and the documents import refused both ("Import failed because of duplicate variable 'State' in declaration section." / "… 'Enable' …").

1. In TIA, open `Broken/FB_SclSections_B12` (PLC_Main), Static section: rename `state_1` to `state` (same letters as `State`, lower-case s). Note what the editor does (refuses, renames, or shows an error) and the exact message.
2. Same in `PLC data types > Broken > UDT_Motor_B16`: rename `Enable_1` to `Enable`.
3. If the editor accepts it, compile PLC_Main and give Claude Code the compile messages; otherwise give it the editor's message. Change nothing else; save.

Status: open (optional).

## Notes for the tia-mcp server (no TIA step needed)

Found in Step 4; the corpus does not depend on either.

1. `om_invoke ExportAsDocuments` cannot be called: the server classifies the string parameter `fileNameWithoutExtension` as a file path and passes it on as an absolute path, so TIA refuses it with "The file name is missing or contains invalid characters." (the folder parameter `directoryInfo` alone should be path-checked). As a result, `documents/` comes from the `plc_export_block` text, without BOM (see `format-findings.md` 7).
2. `vci_sync export` with format SimaticSD of the know-how protected F-OB `FOB_RTG1` crashed TIA Portal (NonRecoverableException in `Workspace.ExportObject`, the TIA process ended). The server could refuse VCI exports of know-how protected blocks before calling TIA, as `plc_export_block` already does.
3. `om_invoke Export` accepts only one `ExportOptions` value ("WithDefaults, WithReadOnly" → INVALID_ARGUMENT), so no single SimaticML file has both the default-valued attributes and the read-only ones such as `PriorityNumber`.

Status: information only.
