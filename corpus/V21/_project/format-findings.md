# Format findings – TIA V21

Every answer quotes its evidence: the case, the file and the exact lines from the exports. Paths are relative to `corpus/V21/`. TIA Portal V21 Update 1, STEP 7 Safety V21, Openness through the tia-mcp V21 server.

How the folders were produced (applies to all answers):

- `documents/`: the text returned by `plc_export_block` / `plc_export_type` format `documents`, split at the `=== <file> ===` lines. The tool never returns the UTF-8 BOM. In a multi-file result it also replaces each file's final CRLF with the LF it uses as a separator. That CRLF was put back, and all 166 files were then checked byte for byte against VCI's SimaticSD files (see 7).
- `source/`: written by TIA itself (`om_invoke` `PlcExternalSourceSystemGroup.GenerateSource`, option `None`). `plc_export_block` format `source` returns the same text without the BOM (checked on FC_AnaDead: 270 characters vs. 273 bytes with BOM).
- `simaticml/`: written by TIA itself (`om_invoke` `Export`, `ExportOptions.WithDefaults`, the setting `plc_export_block` reports in `<ExportSetting>`). The OBs also have `<OB>.readonly.xml` (`ExportOptions.WithReadOnly`), see 1.
- `vci/`: VCI workspaces `Corpus_SimaticSD` and `Corpus_SimaticML` (`vci_sync export`), files copied unchanged.

## 1. OB attributes

Are OB priority, cyclic time, phase offset and OB type present in `.s7dcl`? Under which attribute names? Where in SimaticML?

- Answer: **No.** `.s7dcl` (and the identical VCI SimaticSD file) has no OB type, OB number, cyclic time, phase offset or priority. The header carries only `S7_EditorMode`, `S7_Optimized` and `S7_Version`, and the only OB-specific text is the keyword `ORGANIZATION_BLOCK`. The `.scl` source has none of them either. A `.s7dcl` or SCL-source import always creates a ProgramCycle OB (run-log Step 2). In SimaticML they are elements of `SW.Blocks.OB/AttributeList`: `<SecondaryType>`, `<Number>`, `<CyclicTime>` and `<PhaseOffset>` (in µs), and with `AutoNumber`. The priority is **not** in the default export (`WithDefaults`). It appears only with `ExportOptions.WithReadOnly`, as `<PriorityNumber ReadOnly="true">`, next to `<EventClass ReadOnly="true">` and `<ConstantName ReadOnly="true">`. But `WithReadOnly` leaves out attributes that have their default value: OB35's `<CyclicTime>100000</CyclicTime>` is missing from the readonly file. So a reader needs both files, or the extension must apply TIA's defaults. OB40 (hardware interrupt) has no `PriorityNumber` at all, not even in `WithReadOnly`; Openness exposes none on that OB.
- Evidence (C13, C15):
  - `C13-ob-cyclic/documents/OB_Cyclic100ms.s7dcl` lines 1–8: `{` / `    S7_EditorMode := "SCL";` / `    S7_Optimized := "TRUE";` / `    S7_Version := "0.1"` / `}` / `ORGANIZATION_BLOCK "OB_Cyclic100ms"` / `    { S7_Language := "SCL" }` / `    NETWORK`
  - `C13-ob-cyclic/source/OB_Cyclic100ms.scl` lines 1–4: `ORGANIZATION_BLOCK "OB_Cyclic100ms"` / `TITLE = Cyclic interrupt 100 ms` / `{ S7_Optimized_Access := 'TRUE' }` / `VERSION : 0.1`
  - `C13-ob-cyclic/simaticml/OB_Cyclic100ms.xml` line 49 `<CyclicTime>100000</CyclicTime>`, 76 `<Number>35</Number>`, 77 `<PhaseOffset>20000</PhaseOffset>`, 79 `<SecondaryType>CyclicInterrupt</SecondaryType>`. No priority element.
  - `C13-ob-cyclic/simaticml/OB_Cyclic100ms.readonly.xml` line 55 `<EventClass ReadOnly="true">Cyclic interrupt</EventClass>`, 87 `<PhaseOffset>20000</PhaseOffset>`, 88 `<PriorityNumber ReadOnly="true">13</PriorityNumber>`. No `<CyclicTime>` (default value).
  - `C15-ob-diag-hw/simaticml/OB_DiagError.xml` line 84 `<Number>82</Number>`, 86 `<SecondaryType>DiagnosticErrorInterrupt</SecondaryType>`. No priority, although `om_get` shows `PriorityNumber` = 7 (set in Step 2).
  - `C15-ob-diag-hw/simaticml/OB_DiagError.readonly.xml` line 95 `<PriorityNumber ReadOnly="true">7</PriorityNumber>`.
  - `C15-ob-diag-hw/simaticml/OB_HwInterrupt.readonly.xml` line 54 `<EventClass ReadOnly="true">Hardware interrupt</EventClass>`, 101 `<SecondaryType>HardwareInterrupt</SecondaryType>`. No `PriorityNumber`.
  - `C14-ob-startup/simaticml/OB_Startup.xml` line 77 `<SecondaryType>Startup</SecondaryType>`. `C12-ob-main/simaticml/OB_Main.readonly.xml` line 177 `<SecondaryType>ProgramCycle</SecondaryType>`.

## 2. Recognizing F-blocks

How is an F-block recognizable in `.s7dcl`, `.s7res`, SimaticML and the VCI folder layout (language, attributes, file or folder names)? Compare C24 with C16/C19.

- Answer:
  - `.s7dcl`: through the header attribute `S7_Safety`. F-FB/F-FC have `S7_Safety := "TRUE"` (upper case), F-DBs have `S7_Safety := "True"` (mixed case), and the instance F-DB additionally `S7_UserDefinedId := "FUSI"`. An F-compliant UDT has no header block; it carries `{ S7_Safety := "True" }` inside `TYPE`, before the type name. The language attribute is the standard one, without the F prefix (`S7_PreferredLanguage := "LAD"` / `"FBD"`), so it is identical to C16/C19, which simply lack `S7_Safety`.
  - `.s7res`: nothing marks an F-block. It contains only texts.
  - SimaticML: `<ProgrammingLanguage>` is `F_LAD`, `F_FBD` or `F_DB`, on the block and on every compile unit. F-UDT: `<IsFailsafeCompliant>true</IsFailsafeCompliant>`. The `STEP 7 Safety` product line under `InstalledProducts` appears in every export (also C16), so it is no marker.
  - `.scl` (F-DBs only, F_LAD/F_FBD have no source): no marker at all. `C24-failsafe/source/F_DB_Settings.db` reads like a standard DB.
  - VCI: no special file or folder names. Files are named `<block>.s7dcl/.s7res/.xml` in the folder given at export (here `PLC_Main/`), exactly like standard blocks. The F-OB `FOB_RTG1` (know-how protected, generated by TIA) cannot be exported in any format (refusals in `C24-failsafe/expected.json`), and its VCI SimaticSD export **crashed TIA Portal** (run-log).
- Evidence:
  - `C24-failsafe/documents/F_FB_MainSafety.s7dcl` line 3 `    S7_PreferredLanguage := "LAD";`, line 4 `    S7_Safety := "TRUE";`. `C16-lad-contacts/documents/FC_LadContacts.s7dcl` line 3 `    S7_PreferredLanguage := "LAD";`, without `S7_Safety`.
  - `C24-failsafe/documents/F_FC_Logic.s7dcl` lines 3–4 `S7_PreferredLanguage := "FBD";` / `S7_Safety := "TRUE";`. `C19-fbd-logic/documents/FC_FbdLogic.s7dcl` line 3 `S7_PreferredLanguage := "FBD";` only.
  - `C24-failsafe/documents/F_DB_Settings.s7dcl` line 3 `    S7_Safety := "True";`. `F_IDB_MainSafety.s7dcl` line 3 `S7_Safety := "True";`, line 5 `S7_UserDefinedId := "FUSI";`.
  - `C24-failsafe/documents/UDT_FSignals.s7dcl` lines 2–3 `    { S7_Safety := "True" }` / `    UDT_FSignals : STRUCT`.
  - `C24-failsafe/simaticml/F_FB_MainSafety.xml` line 105 `<ProgrammingLanguage>F_LAD</ProgrammingLanguage>`. `F_FC_Logic.xml` line 96 `F_FBD`. `F_DB_Settings.xml` line 108 and `F_IDB_MainSafety.xml` line 93 `F_DB`. `UDT_FSignals.xml` line 90 `<IsFailsafeCompliant>true</IsFailsafeCompliant>`. `C16-lad-contacts/simaticml/FC_LadContacts.xml` line 163 `<ProgrammingLanguage>LAD</ProgrammingLanguage>`.

## 3. `.s7res` layout

The exact layout with two languages: ids, ordering, escaping, what happens with an empty translation.

- Answer: YAML.
  - Structure: the first line is `MultiLingualTexts:`, then per text `  - id: <id>` followed by one `    <culture>: <text>` line per language that has a text. Cultures are in alphabetical order (`de-DE` before `en-US`), not editing language first.
  - Empty translation: the line is left out. With no text in any language the id does not appear at all.
  - Ids: free strings. Ids given in an imported `.s7dcl/.s7res` are kept (`MLC_I1`, `MLC_N1T`). TIA invents ids for objects created another way (SCL source, Openness): `MLC_` + 2–3 alphanumerics, e.g. `MLC_3uG`. They are stable: the same object exported again, and through VCI, has the same ids. Ids are unique only per file; DB_Machine_B15 reuses DB_Machine's ids.
  - Order: the order of first reference in the `.s7dcl`: members in declaration order, then the networks. For a network, the title comes before the comment, although the `.s7dcl` attribute block lists `S7_NetworkComment` before `S7_NetworkTitle`.
  - Escaping: a value is put in single quotes when it contains `: ` or ` #`. `"`, `'` and `&` inside a value stay unquoted. Non-ASCII (umlauts) is written as raw UTF-8.
  - Block title and block comment are **not** in `.s7res`, and not in `.s7dcl` either: documents carry no block title or comment at all. They are only in SimaticML and in `.scl` (`TITLE =`, `//` comment).
  - A block without any comment text has no `.s7res`, and then the tool result is a single file without a header.
  - C19 `FC_FbdLogic` was imported from SimaticML with bilingual network titles and a block title. Its documents export has no `S7_NetworkTitle` and no `.s7res`, while the SimaticML export still has all titles. C20 (titles imported through `.s7res`) keeps them.
- Evidence (C05, C16, C20, C02):
  - `C05-scl-sections/documents/FB_SclSections.s7res` lines 1–15: `MultiLingualTexts:` / `  - id: MLC_4nB` / … / line 5 `    en-US: 'Mode: 0 = off, 1 = manual, 2..5 = automatic'` / line 7 `    en-US: Setpoint for the "sum" check` / line 11 `    en-US: Average of the 'valid' values` / line 13 `    en-US: 'Number of steps # executed'` / line 15 `    en-US: Measured values & limits`.
  - `C01-udts/documents/UDT_Motor.s7res` line 5 `    en-US: 'Feedback: motor is running'`.
  - `C16-lad-contacts/documents/FC_LadContacts.s7res` lines 47–52: `  - id: MLC_N1T` / `    de-DE: Schließer und Öffner` / `    en-US: Normally open and normally closed contact` / `  - id: MLC_N1C` / `    de-DE: Der Motor läuft, …` / `    en-US: The motor runs …`. `C16-lad-contacts/documents/FC_LadContacts.s7dcl` lines 46–47 `        S7_NetworkComment := "MLC_N1C";` / `        S7_NetworkTitle := "MLC_N1T"`.
  - `C02-global-db/documents/DB_Machine.s7res` lines 110–114: `  - id: MLC_4TX` / `    de-DE: Betriebsstunden, remanent` / `    en-US: Operating hours, retentive` / `  - id: MLC_4DE` / `    en-US: Last recipe, retentive` (no de-DE line: the empty translation).
  - `C20-fbd-boxes/documents/FB_FbdBoxes.s7res`: network titles and comments in both languages. `C19-fbd-logic/documents/` has only `FC_FbdLogic.s7dcl`, while `C19-fbd-logic/simaticml/FC_FbdLogic.xml` lines 171–182 carry the title `UND` / `AND` of network 1 (and so on for all 7 networks, plus the block title `FUP-Logik` / `FBD logic`).

## 4. Line numbering

For each broken SCL case, which line of the exported file does TIA's message line number point to (from `BEGIN` in `.scl`, from `NETWORK` in `.s7dcl`)? For LAD/FBD, how are networks numbered in messages?

Rule (all 36 line messages of the corpus):

- **SCL**: TIA's line n is the n-th line after the `BEGIN` line in `.scl`, and the n-th line after the `NETWORK` line in `.s7dcl`. Line 1 is the empty first line of the body: in `.scl` a line consisting of one TAB (`BEGIN\r\n\t\r\n`), in `.s7dcl` a line of 8 spaces (`    NETWORK\r\n        \r\n`, 12 inside a NAMESPACE). Lines are identical in both files except for the indentation: in `.scl` every body line gets one TAB in front of the source indentation, in `.s7dcl` 8 spaces (12 in a unit).
- The line is where the parser notices the problem, not always the faulty statement. B03 (missing `END_IF` after `#Average := 0.0;`, line 60) is reported at line 62. B26 (counter assignment `#Index := 10;` at line 6) is reported at the `FOR` line 3. B04/B05 point to the first line of a multi-line call. Several messages can share one line (B06: 7 messages at line 25).
- **LAD/FBD**: the message path ends in `Network n`, the 1-based position of the network in the block. That is the n-th `NETWORK` keyword in `.s7dcl`; network titles do not matter. There is no line or element position.
- **SCL network inside a LAD block (B25)**: only `Network 2`, no line number at all.
- Messages on the declaration part end in `> Interface` (B15, B22, B23), without a line.

| Case | Message line/network | Line in `.scl` | Line in `.s7dcl` | Rule |
| --- | --- | --- | --- | --- |
| B01 | line 64 (1 msg) | file line 107 = BEGIN + 64: `#Speed := #Average;` | file line 121 = NETWORK + 64 | BEGIN + n / NETWORK + n |
| B02 | line 29 (1 msg) | file line 72 = BEGIN + 29: `#Sum := 0.0` | file line 86 = NETWORK + 29 | BEGIN + n / NETWORK + n |
| B03 | line 62 (2 msg) | file line 105 = BEGIN + 62: `#StepCount := #Iterations;` | file line 119 = NETWORK + 62 | BEGIN + n / NETWORK + n (reported 2 lines after the missing END_IF) |
| B04 | line 3 (2 msg) | file line 43 = BEGIN + 3: `#Sections(Enabel := #Enable,` | file line 58 = NETWORK + 3 | BEGIN + n / NETWORK + n (first line of the call) |
| B05 | line 3 (1 msg) | file line 43 = BEGIN + 3: `#Sections(Enable := #Enable,` | file line 58 = NETWORK + 3 | BEGIN + n / NETWORK + n (first line of the call) |
| B06 | line 25 (7 msg) | file line 65 = BEGIN + 25: `#ConvertedWord := "FC_IecMissing"(InInt := #Mode, …);` | file line 80 = NETWORK + 25 | BEGIN + n / NETWORK + n |
| B07 | line 33 (1 msg, warning) | file line 82 = BEGIN + 33: `#TempInt := #TempReal;` | file line 85 = NETWORK + 33 | BEGIN + n / NETWORK + n |
| B08 | line 3 (1 msg) | file line 22 = BEGIN + 3: `#OutInt := #InWord;` | file line 29 = NETWORK + 3 | BEGIN + n / NETWORK + n |
| B09 | line 10 (1 msg) | file line 59 = BEGIN + 10: `"MAXIMUM_PIECES" := INT#1000;` | file line 62 = NETWORK + 10 | BEGIN + n / NETWORK + n |
| B10 | line 20 (1 msg, warning) | file line 63 = BEGIN + 20: `1:` | file line 77 = NETWORK + 20 | BEGIN + n / NETWORK + n |
| B11 | line 31 (1 msg) | file line 74 = BEGIN + 31: `FOR #Average := 0.0 TO 9.0 DO` | file line 88 = NETWORK + 31 | BEGIN + n / NETWORK + n |
| B14 | line 3 (1 msg) | file line 37 = BEGIN + 3: `#OnDelay(IN := #Start, PT := 5, Q => #DelayedOn);` | file line 50 = NETWORK + 3 | BEGIN + n / NETWORK + n |
| B17 | line 16 (1 msg) | file line 54 = BEGIN + 16: `#Measurement.Header.Label := #TemperatureRef^;` | file line 69 = NETWORK + 16 | BEGIN + n / NETWORK + n |
| B18 | Network 1 (1 msg) | – | NETWORK no. 1 of 8 (file line 49, LAD) | n-th NETWORK |
| B19 | Network 3 (1 msg) | – | NETWORK no. 3 of 10 (file line 86, LAD) | n-th NETWORK |
| B20 | Network 3 (1 msg) | – | NETWORK no. 3 of 8 (file line 83, FBD) | n-th NETWORK |
| B21 | line 3 (1 msg) | file line 24 = BEGIN + 3: `#Recipe.TargetVolume := _.Filling.FC_FillHelper(RawFlow := 50, Factor := 0.01);` | file line 32 = NETWORK + 3 | BEGIN + n / NETWORK + n (unit block: NAMESPACE wrapper) |
| B24 | line 14 (2 msg) | file line 43 = BEGIN + 14: `#DelayMilliseconds := LTIME_TO_DINT(LT#2s);` | file line 51 = NETWORK + 14 | BEGIN + n / NETWORK + n |
| B25 | Network 2 (1 msg) | – | NETWORK no. 2 of 3 (file line 44, SCL network in a LAD block) | n-th NETWORK, no line |
| B26 | line 3 (1 msg) | file line 19 = BEGIN + 3: `FOR #Index := 0 TO 10 DO` | file line 22 = NETWORK + 3 | BEGIN + n / NETWORK + n (the change is at line 6) |
| C10 | lines 3–6 (4 warnings) | file lines 22–25 = BEGIN + 3…6: `#OutInt := #InWord;` … `#FC_IecOff := #InInt;` | file lines 28–31 = NETWORK + 3…6 | BEGIN + n / NETWORK + n |
| C26f | line 2 (warning) | file line 13 = BEGIN + 2: `#Value := #Value * 2;` | file line 15 = NETWORK + 2 | BEGIN + n / NETWORK + n |
| C26l | line 4 (warning) | file line 23 = BEGIN + 4: `#Count := #Count + 1;` | file line 25 = NETWORK + 4 | BEGIN + n / NETWORK + n |

## 5. IEC check

Where is it stored in each format for `FC_IecOn` / `FC_IecOff`?

- `.s7dcl`: header attribute `S7_IECCheck := "TRUE"` when it is on. When off, the attribute is absent (not `"FALSE"`). Evidence: `C10-iec-check/documents/FC_IecOn.s7dcl` line 3 `    S7_IECCheck := "TRUE";`. `C10-iec-check/documents/FC_IecOff.s7dcl` lines 1–5 contain only `S7_EditorMode`, `S7_Optimized` and `S7_Version`. The same holds in B08 (`B08-iec-implicit-conversion/documents/FC_IecOn_B08.s7dcl` line 3).
- `.scl`: **not stored.** `C10-iec-check/source/FC_IecOn.scl` and `FC_IecOff.scl` lines 1–4 differ only in the name and title (`{ S7_Optimized_Access := 'TRUE' }` in both). Regenerating `FC_IecOn` from SCL source reset the IEC check to off (run-log Step 2).
- SimaticML: `<IsIECCheckEnabled>true</IsIECCheckEnabled>` (`C10-iec-check/simaticml/FC_IecOn.xml` line 97) vs. `false` (`FC_IecOff.xml` line 97). It is always written for code blocks.

## 6. Software units

How namespace, unit membership and published state appear in each format.

- Answer:
  - `.s7dcl`: the whole file is wrapped in `NAMESPACE <ns>` … `END_NAMESPACE`, with everything inside indented by 4 more spaces. Published state is the header attribute `S7_UnitAccess := "Published"` or `"Unpublished"`; it is always written, also for OBs and instance DBs (UDT: in the `{ … }` block before the type name). References are fully qualified from the root: `_.Filling.FB_Filler`, `_.Filling.UDT_FillRecipe`, root tags `_.FillValveOpen`. Inside the same namespace, objects are unqualified (`FC_FillHelper(…)`, `UDT_FillRecipe`). An unresolvable reference is written as one quoted identifier: B22 `Doser : "_.Dosing.FB_Doser";`, while the resolved one in FB_Doser reads `Filler : _.Filling.FB_Filler;`.
  - `.scl`/`.db`/`.udt`: the first line is `NAMESPACE <ns>` and the last line `END_NAMESPACE`, without extra indentation. Published state is `Published := 'TRUE'` / `'FALSE'` in the attribute block (`{ S7_Optimized_Access := 'TRUE' ; Published := 'TRUE' }`). References: `_.Filling.FB_Filler`, `_.FillValveOpen`.
  - SimaticML: `<Namespace>Filling</Namespace>` and `<Access>Published</Access>` / `<Access>Unpublished</Access>` in the AttributeList. Type references are written without the root prefix and quoted (`Datatype="&quot;Filling.FB_Filler&quot;"`), calls as `<CallInfo … Name="Filling.FB_Filler">`. Tag tables: `<Access>Published</Access>`, but no namespace.
  - Unit membership: in **no** file. Neither the unit name (`Unit_Filling`) nor the unit relations appear anywhere; only the namespace (= the unit's `NamespacePreset`) does. In VCI the folder is whatever the export chose (here `vci/…/PLC_Main/Unit_Filling/`, set by me, not by TIA). Objects created through Openness (source generation, documents import) get `Namespace = ""` even inside a unit; it has to be set afterwards (run-log Step 2).
- Evidence (C22, C23):
  - `C22-unit-filling/documents/FB_Filler.s7dcl` lines 1–6: `NAMESPACE Filling` / `    {` / `        S7_EditorMode := "SCL";` / `        S7_Optimized := "TRUE";` / `        S7_UnitAccess := "Published";` / … and last line `END_NAMESPACE`. `FC_FillHelper.s7dcl` line 5 `        S7_UnitAccess := "Unpublished";`. `UDT_FillRecipe.s7dcl` line 3 `        { S7_UnitAccess := "Published" }`.
  - `C23-unit-dosing/documents/FB_Doser.s7dcl` line 23 `            Filler : _.Filling.FB_Filler;`. `B22-missing-relation/documents/FB_Filler_B22.s7dcl` line 31 `            Doser : "_.Dosing.FB_Doser";`.
  - `C23-unit-dosing/documents/IDB_Doser.s7dcl` and `OB_Dosing.s7dcl`: `NAMESPACE Dosing` + `S7_UnitAccess := "Unpublished";`.
  - `C22-unit-filling/source/FB_Filler.scl` lines 1–4 `NAMESPACE Filling` / `FUNCTION_BLOCK "FB_Filler"` / … / `{ S7_Optimized_Access := 'TRUE' ; Published := 'TRUE' }`, last line 54 `END_NAMESPACE`. `FC_FillHelper.scl` line 4 `{ S7_Optimized_Access := 'TRUE' ; Published := 'FALSE' }`. `UDT_FillRecipe.udt` lines 1–4 `NAMESPACE Filling` / `TYPE "UDT_FillRecipe"` / `TITLE = …` / `{ Published := 'TRUE' }`.
  - `C22-unit-filling/simaticml/FB_Filler.xml` line 48 `<Access>Published</Access>`, line 161 `<Namespace>Filling</Namespace>`. `FC_FillHelper.xml` line 48 `<Access>Unpublished</Access>`, line 79 `<Namespace>Filling</Namespace>`. `C22-unit-filling/tagtables/Tags_Filling.xml` line 6 `<Access>Published</Access>`.
  - `C23-unit-dosing/simaticml/FB_Doser.xml` line 102 `<Member Name="Filler" Datatype="&quot;Filling.FB_Filler&quot;" …>`, line 176 `<Namespace>Dosing</Namespace>`, line 230 `<CallInfo UId="44" BlockType="FB" Name="Filling.FB_Filler">`.

## 7. Export tool vs VCI

Byte-level differences between `plc_export_block` documents and VCI SimaticSD files of the same object.

- Answer: the **content is identical**. All 166 `.s7dcl`/`.s7res` files of the 97 objects VCI exported are byte-identical to the documents text once VCI's UTF-8 BOM is removed. That includes the same MLC ids, CRLF line endings and final CRLF. The only differences come from the tool's transport, not from TIA:
  1. VCI files start with the UTF-8 BOM `EF BB BF`; the tool text has none.
  2. In a multi-file result (`.s7dcl` + `.s7res`), the tool joins the files as `=== <name> ===\n<text without its final CRLF>\n`. A single-file result is the file text itself, including its final CRLF. `documents/` here has the CRLF restored, so `documents/<x>` equals `vci/SimaticSD/<x>` minus the BOM.
  - VCI also writes `.vci/workspace.vci.config` in the workspace root. File names are `<object name>.s7dcl/.s7res`, with no type prefix and no group folders; the folder is the `folder` given at export.
  - Not covered by VCI SimaticSD: tag tables ("Tags_IO supports the formats SimaticML.") and `FOB_RTG1` (crash). The documents export also works for inconsistent blocks, and so does VCI SimaticSD.
- Evidence: `vci_sync` comparison script, result `files 166 equal 166 differ [] … BOM 166 noBOM 0` (run-log Step 4). Example `C05-scl-sections/vci/SimaticSD/FB_SclSections.s7dcl` (3827 bytes, starts `EF BB BF 7B`) vs. `C05-scl-sections/documents/FB_SclSections.s7dcl` (3824 bytes, starts `7B`). The tool result of FC_AnaDead (Step 4): `…END_FUNCTION\n=== FC_AnaDead.s7res ===\nMultiLingualTexts:…`, while VCI's `FC_AnaDead.s7dcl` ends `END_FUNCTION\r\n`.

## 8. Line endings and encoding

| Format | Line endings | BOM | Trailing newline |
| --- | --- | --- | --- |
| `.s7dcl` | CRLF only (98/98 files) | yes in TIA's files (VCI 98/98); the tool text has none (`documents/` 0/98) | one CRLF, no empty last line |
| `.s7res` | CRLF only (69/69) | yes in TIA's files (VCI 69/69); none in the tool text | one CRLF |
| `.scl` / `.db` / `.udt` | CRLF only (85/85) | yes (85/85, written by TIA) | CRLF CRLF: the file ends with an empty line (85/85) |
| SimaticML `.xml` | CRLF only (77/77 blocks and UDTs, 4/4 tag tables) | yes (81/81) | **none**: the file ends with `</Document>` |

Encoding is UTF-8 everywhere; non-ASCII (de-DE umlauts) appears in 13 `.s7res`, 10 block/UDT SimaticML and 2 tag-table SimaticML files. No file contains a bare LF. Indentation: `.s7dcl` uses 4 spaces per level, and the lines of an SCL network get 8 spaces (12 inside a NAMESPACE) in front of the source line's own indentation. `.scl` puts one TAB in front of the source line's own indentation. A LAD rung line that held a dropped template attribute is kept as an indented empty line, e.g. `C17-lad-boxes/documents/FB_LadBoxes.s7dcl`: `RUNG wire#powerrail` followed by a line of 12 spaces before `Move(`.

## 9. Inconsistent blocks

How a broken block's export differs from a consistent one, if at all.

- Answer:
  - documents, source and VCI SimaticSD all work for inconsistent blocks and contain the current, uncompiled text. **The file has no marker of the state**: same header attributes, same layout. Only the tool reports it (`isConsistent:false`, note "Not compiled since its last change (or it has errors): this is the current, uncompiled text.").
  - SimaticML is refused for every inconsistent block, both by `Export` ("Inconsistent blocks and PLC data types (UDT) cannot be exported.") and by VCI ("FB_SclSections_B01 [FB21] object(s) is not consistent").
  - Unresolved references are written differently: as one quoted identifier in `.s7dcl` (B22 `Doser : "_.Dosing.FB_Doser";`), while `.scl` keeps `Doser : _.Dosing.FB_Doser;`.
  - A broken block that TIA only warns about (B07, B10) or compiles (B12, B13, B16) is consistent after the compile and exports in every format, SimaticML included.
- Evidence: `B01-undeclared-variable/expected.json` `exports.refused.simaticml` and `exports.refused.vci_SimaticML`. `B01-undeclared-variable/documents/FB_SclSections_B01.s7dcl` lines 1–5 are identical to `C05-scl-sections/documents/FB_SclSections.s7dcl` lines 1–5 (`{` / `S7_EditorMode := "SCL";` / `S7_Optimized := "TRUE";` / `S7_Version := "0.1"` / `}`). `B22-missing-relation/documents/FB_Filler_B22.s7dcl` line 31 vs. `B22-missing-relation/source/FB_Filler_B22.scl` line 22 `      Doser : _.Dosing.FB_Doser;   // Doser of the unit Dosing, used without a relation`. `B07-int-real-assignment/simaticml/FC_SclTypes_B07.xml` exists (consistent after a warning-only compile).
