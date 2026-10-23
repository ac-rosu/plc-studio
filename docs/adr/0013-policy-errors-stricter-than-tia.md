# Policy errors: a closed list of errors stricter than TIA

Two constructs are errors in PLC Studio even though TIA V21 accepts them: recursion (a block that calls itself, directly or indirectly) and two identifiers in one scope that differ only by case. TIA compiles a recursive FC without any message (corpus B13). When it imports an external source, it silently renames a case-only duplicate (`state` → `state_1`, corpus B12 and B16), while a `.s7dcl` import with the duplicate is refused. The owner decided that the extension does not allow either construct, in any format, whatever TIA does with it.

This is a deliberate exception to ADR 0003. Errors for code TIA accepts are allowed only as policy errors: a closed list that only the owner extends, with each entry backed by corpus cases that record what TIA really does. The zero-false-errors gate expects a policy error where one is listed on a TIA-clean case; any other error on a TIA-clean case is still a false error.

## Considered Options

- Report them as warnings, as ADR 0003 would require: rejected by the owner (2026-10-23).
