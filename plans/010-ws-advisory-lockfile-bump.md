# Plan 010: Clear the high-severity `ws` advisory from the production dependency tree

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `pnpm audit --prod`
> This plan was written when that command reported exactly one finding:
> `ws` (high, GHSA-96hv-2xvq-fx4p, patched `>=8.21.0`, path `.>viem>ws`).
> If it now reports zero findings, mark this plan REJECTED ("fixed
> independently") in `plans/README.md` and stop. If it reports different
> findings, STOP and report them.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `7f94c6f`, 2026-07-02

## Why this matters

`pnpm audit --prod` reports one high-severity advisory: the `ws` WebSocket
library (transitive via `viem`) is vulnerable to memory-exhaustion DoS
(GHSA-96hv-2xvq-fx4p); patched in `>=8.21.0`. Exposure is narrow — it only
matters for consumers using WebSocket transports against an untrusted RPC
endpoint — but a wallet-facing library should ship a clean production audit,
and the fix is a lockfile refresh.

## Current state

- `package.json`: single runtime dependency `"viem": "^2.45.1"`;
  `pnpm-lock.yaml` currently resolves viem `2.54.0`, which still pins a
  vulnerable `ws` in the lockfile.
- No `pnpm.overrides` block exists in `package.json`.
- Audit output path: `. > viem > ws`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Audit | `pnpm audit --prod` | "No known vulnerabilities found" after fix |
| Refresh dep | `pnpm update viem` / `pnpm update ws` | exit 0, lockfile updated |
| Full gate | `pnpm typecheck && pnpm lint && pnpm test` | exit 0 |

## Scope

**In scope**:

- `pnpm-lock.yaml`
- `package.json` (ONLY if an override is required — see steps)
- `plans/README.md` (status row only)

**Out of scope**: everything else. No source changes.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Try the in-range refresh

Run `pnpm update viem` then `pnpm update ws` (updates transitive `ws` within
viem's declared range if the range permits `>=8.21.0`).

**Verify**: `pnpm audit --prod` → no vulnerabilities. If clean, skip Step 2.

### Step 2 (only if Step 1 leaves the advisory): pin an override

Add to `package.json`:

```json
"pnpm": {
  "overrides": {
    "ws": ">=8.21.0"
  }
}
```

Then `pnpm install`. Run `pnpm lint:fix` to let oxfmt normalize
`package.json`.

**Verify**: `pnpm audit --prod` → no vulnerabilities.

### Step 3: Regression gate

**Verify**: `pnpm typecheck && pnpm lint && pnpm test` → all exit 0. (The
test suite doesn't use WebSocket transports, so failures here would indicate
an unrelated lockfile disturbance — investigate before proceeding.)

## Test plan

No new tests. The audit command is the acceptance test; the existing suite is
the regression gate.

## Done criteria

- [ ] `pnpm audit --prod` reports zero vulnerabilities
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0
- [ ] `git status --porcelain` shows only `pnpm-lock.yaml` (and `package.json` iff Step 2 ran)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The override forces a `ws` major version that viem's runtime rejects (test
  failures referencing ws/isows) — report; a viem upgrade may be needed
  instead.
- `pnpm audit --prod` surfaces NEW advisories after the update.

## Maintenance notes

- If Step 2's override was needed, remove it once viem's own range moves past
  the patched version — overrides rot. Check on the next viem bump.
- Consider wiring `pnpm audit --prod` into the CI plan's workflow (plan 008)
  as a non-blocking step once both have landed — deferred here to keep the CI
  gate deterministic.
