# No false errors

An error is reported only for code TIA would reject; when a rule cannot decide (missing reference data, unresolved calls, unknown constructs, partial exports) it reports a warning or info instead. This is enforced as a release gate on the corpus. A checker that reports errors TIA accepts gets switched off by its users, so precision is chosen over recall.
