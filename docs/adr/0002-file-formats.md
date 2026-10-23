# SIMATIC SD as primary format, external sources for SCL, SimaticML only for tag tables

SIMATIC SD documents (`.s7dcl` + `.s7res`) are the primary format because they are the only text format covering SCL, LAD and FBD alike and they diff well in git. External sources (`.scl`, `.udt`, `.db`) are fully supported for SCL because many users work with them. SimaticML XML is used only for tag tables, which have no SD format (VCI exports them only as SimaticML).

## Consequences

- LAD/FBD support exists only for SIMATIC SD documents.
- TIA V19 and older, which lack SIMATIC SD, are out of scope.
