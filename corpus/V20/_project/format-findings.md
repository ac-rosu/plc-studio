# Format findings – TIA V20

How V20's exports differ from V21's for the same blocks. Paths are relative to `corpus/`. TIA Portal V20 Update 6 (`run-log.md`); the V21 corpus is V21 Update 1.

## 1. SIMATIC SD: two extra spaces

In the interface of a code block V20 writes a space after `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` and `VAR`, and in a network after the comma between the parameters of a box written on several lines. Everything else in the four documents imported from V21 comes back unchanged.

- `V20/C16-lad-contacts/documents/FC_LadContacts.s7dcl` line 7 `    VAR_INPUT ` and line 64 `                operand := #Sensor, `; `V21/C16-lad-contacts/documents/FC_LadContacts.s7dcl` lines 7 and 64 have no trailing space. `V20/C17-lad-boxes/documents/FB_LadBoxes.s7dcl` line 37 `    VAR `.
- A data block has none: `V20/C02-global-db/documents/DB_Machine.s7dcl` lines 7 `    VAR` and 93 `    VAR RETAIN`.
- V20 imported V21's documents (no trailing spaces) without a message (`run-log.md` steps 5–6), so SD text written the V21 way is valid V20 input.

## 2. SimaticML: same schema, other layout

V20 uses the namespaces V21 uses: `…/SW/Interface/v5`, `…/SW/NetworkSource/FlgNet/v5`, `…/SW/NetworkSource/StructuredText/v4` (`V20/C05-scl-sections/simaticml/FB_SclSections.xml` lines 57 and 245). V20 starts the `Sections`, `FlgNet` and `StructuredText` elements on the line of their parent and indents their content from column 0 (`V20/C16-lad-contacts/simaticml/FC_LadContacts.xml` lines 57–58 and 189), where V21 puts them on their own lines (`V21/C16-lad-contacts/simaticml/FC_LadContacts.xml` lines 53 and 187–188). Whitespace only: the element trees are equal apart from `<Engineering version>`, numbers, and texts and part order that came from a different import (V21 imported C19 as SimaticML, V20 as SD).

## 3. SIMATIC SD export refused for objects made from sources

`plc_export_block`/`plc_export_type` format documents refused FB_SclSections (`plc_generate_from_scl`) and UDT_Motor (`plc_import_type` format source): "SIMATIC SD export failed due to project modifications made with a TIA Portal version earlier than V20 Update 4. … Add-In "SimaticSdEnabler" …", although the project was created in V20 Update 6. DB_Machine, also generated from a source, exported. Recorded in `V20/C01-udts/expected.json` and `V20/C05-scl-sections/expected.json` under `exports.refused.documents`.

## 4. Start values of a DB generated from a source

TIA keeps only start values that differ from the type's default and writes hexadecimal values in its own form, in all three formats: `V20/C02-global-db/source/DB_Machine.db` line 53 `StatusByte := 16#000F;`, line 55 `StatusDWord := 16#FFFF;` (the input had `16#0F` and `16#0000_FFFF`, as in `V21/C02-global-db/source/DB_Machine.db` lines 54 and 56); `V20/C02-global-db/simaticml/DB_Machine.xml` lines 82 and 106; `V20/C02-global-db/documents/DB_Machine.s7dcl` lines 100 and 102. `MachineOn := FALSE;` (V21 line 53) is gone.

## 5. An empty LAD network

TIA's default OB1 has one LAD network without parts: `<NetworkSource />` in SimaticML (`V20/C00-default-main/simaticml/Main.xml` line 101), `RUNG wire#powerrail` / `END_RUNG` in SIMATIC SD (`V20/C00-default-main/documents/Main.s7dcl` lines 9–10).

## 6. Same as V21

- External sources: TIA's file has a UTF-8 BOM and starts every line of the code after `BEGIN` with a tab (`V20/C05-scl-sections/source/FB_SclSections.scl` lines 44–45), as in V21.
- Array element start values in SIMATIC SD are indented by eight spaces (`V20/C02-global-db/documents/DB_Machine.s7dcl` line 123), as in V21.
- `GenerateSource` refuses LAD/FBD blocks with the same message as V21.
