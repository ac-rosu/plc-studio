# SimaticML blocks: shown read-only, never checked or edited

ADR 0002 limited SimaticML to tag tables. The owner wants every SimaticML export shown by its content, wherever it comes from (Openness, VCI, other tools), for TIA V20, V21 and later versions (2026-10-24). PLC Studio therefore reads SimaticML blocks and PLC data types and shows them in the same views as the text formats: data blocks in the data block view, PLC data types in the interface table, LAD/FBD blocks in the LAD/FBD view, SCL blocks as SCL text rebuilt from the XML. Tag tables stay editable as before.

These views are read-only. A SimaticML block is never edited and never checked: editing would need a writer that changes only the affected XML (parts and wires are linked by ids), and the zero-false-errors rule (ADR 0003) needs TIA evidence for every format, which XML blocks do not have yet. The views state that the file is shown read-only and is not checked.

Each view gets its data from the XML itself: the interface with start values, comments in every language and the members of PLC data types are in the export. LAD/FBD networks are translated into the SIMATIC SD rung text the LAD/FBD view already draws; SCL networks are rebuilt from the XML's token stream. The corpus holds SIMATIC SD and SimaticML of the same blocks, so each translation is tested against TIA's own SD export of the block.

The SimaticML schema versions differ between TIA versions (namespace versions of the interface, the networks and the structured text). The reader matches elements by their local names; the versions known per TIA version are profile data (ADR 0005).

## Considered Options

- Keep XML for tag tables only (ADR 0002): rejected by the owner.
- Edit SimaticML blocks too: rejected for now; it needs a lossless XML writer and TIA evidence first.
- Check SimaticML blocks with the checker: rejected; no corpus evidence for errors in XML exports, and the files TIA exports are consistent blocks in most cases.

## Consequences

- SimaticML blocks open in a matching read-only view; edits go to the text formats.
- A construct the translation does not know is shown as text (the network's XML), never as an error.
- ADR 0002 still holds for editing: SIMATIC SD and external sources are the formats PLC Studio writes.
