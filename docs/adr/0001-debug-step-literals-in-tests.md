# ADR-0001: Tests pin debug steps as literals; implementation imports constants

**Status:** accepted (2026-07-10)

## Context

Debug step names are a pinned invariant: tests assert exact step names and per-step RPC counts so refactors can't add hidden RPC calls. Historically the names were free string literals scattered across every emitting module, so a typo in the implementation was only caught at test time, and reading the full vocabulary meant grepping five files.

The obvious fix — one shared constants module imported by both implementation and tests — has a flaw: if a rename propagates to both sides through the same constant, tests keep passing and the pin loses its teeth exactly when it should bite.

## Decision

- The implementation emits steps via constants from a single internal debug-step vocabulary module. A typo or drift inside the implementation is a type error.
- Tests deliberately do **not** import those constants. They pin step names as string literals, acting as the black-box check from outside the seam. Renaming a step therefore fails CI on purpose.
- The step vocabulary is not exported from the public barrel; the public debug-event type keeps `step: string`.

## Consequences

- Renaming a debug step is intentionally noisy: change the constant, then update every literal in tests as a conscious, reviewed act.
- Future refactors must not "clean up" the test literals into constant imports — that would silently disarm the pinned invariant.
