# Decisions

Design decisions made during the work, one dated entry each, oldest first. Decisions that are hard to reverse, surprising and a real trade-off also get an ADR in [docs/adr/](docs/adr/).

## 2026-10-23 – Recursion is an error, although TIA compiles it

- Context: the spec's cross-block rules call recursion an error because "S7 does not allow it". Corpus case B13 (an FC that calls itself) compiles in TIA V21 with no message at all.
- Decision (owner): not allowed, whatever TIA does. Recursion, direct or indirect, is reported as an error.
- Consequences: a policy error under [ADR 0013](docs/adr/0013-policy-errors-stricter-than-tia.md). The zero-false-errors gate expects this error on B13. The spec's reason "S7 does not allow it" does not hold for V21.

## 2026-10-23 – Identifiers that differ only by case are errors in every format

- Context: B12 and B16. TIA refuses a `.s7dcl` import that has the duplicate. When it imports an external source, it silently renames the second identifier (`state` → `state_1`, `Enable` → `Enable_1`) and compiles.
- Decision (owner): not allowed in the extension, whatever TIA does: an error in `.s7dcl`, `.scl`, `.udt` and `.db` alike.
- Consequences: a policy error under ADR 0013. The corpus exports of B12/B16 hold TIA's renamed variant, so the failing cases for this rule are files written for the project (mutations of C05 and C01).

## 2026-10-23 – Where OB type, number, cycle time and priority come from: deferred

- Context: neither `.s7dcl` nor `.scl` carries the OB type, number, cycle time, phase offset or priority, and importing either always creates a program-cycle OB. SimaticML has type, number, cycle time and phase offset in the default export. The priority appears only with the read-only export option, which in turn leaves out attributes at their default value. OB40 has no priority in either export. ([format notes](docs/format-notes.md), corpus finding 1.)
- Decision (owner): noted for later.
- Where it comes back: M2 (manifest schema) and M6 (execution context of the call graph). Listed as an open question in both milestones in `PLAN.md`.

## 2026-10-24 – TIA V20 moves to a later version; v1 is V21 only

- Context: the spec planned V20 and V21 for v1, but only a V21 corpus exists. The owner expects V20 to differ little from V21 in syntax and declarations.
- Decision (owner): V20 is not in v1. When it is taken up, a small V20 export is compared with the V21 findings first, to decide whether V20 needs a profile of its own or can share V21's.
- Consequences: the spec's scope, profile, milestone (M0, M2) and "Later" sections now say V21; M0 has no V20 corpus task. ADR 0005 is unchanged.

## 2026-10-24 – Publisher, repository and harness location

- The owner chose the publisher id `acro` and the repository https://github.com/ac-rosu/plc-studio.
- The corpus harness is Node-only test tooling and lives in `tools/corpus-harness/`, a private workspace package outside `packages/`, approved by the owner.
- The spec and glossary edits for ADR 0013 were made by Claude at the owner's request.
