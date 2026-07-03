# Plan 034: Per-call balance attribution — `BalanceDelta.byCall` via balance checkpoints

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f86857..HEAD -- contracts/TxSimulator.sol src test README.md`
> If any in-scope file changed since this plan was written (plan 033 touches
> only workflows/gitignore/README-scope — that drift is fine), compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch in contract or src excerpts, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (contract + public-type change on a now-PUBLISHED package; ships as a 0.x minor via changeset)
- **Depends on**: none (031/032 DONE; independent of 033)
- **Category**: direction (deferred finding activated 2026-07-04 — external demand from the Origami integration)
- **Planned at**: commit `9f86857`, 2026-07-04

## Why this matters

`simulate()` reports what each queried balance did across the WHOLE batch —
but not which call did it. For multi-step bundles (approve → zap → refund)
both wallet UIs ("step 2 moved your USDS") and dapp quote refinement
("how much flash token was left at the plugin *after call 1*, before the
repay in call 2") want per-call granularity. The contract already proves
the mechanism: `allowanceCheckpoints` records allowance values at every
call boundary (flattened, stride `calls+1`, fill-forward on mid-batch
revert). This plan gives balance probes the same treatment and exposes it
as `BalanceDelta.byCall: readonly bigint[]` — one signed delta per call,
with the invariant `sum(byCall) === delta`.

Design decisions (maintainer-approved 2026-07-04, do not relitigate):

- **Always on, no opt-in flag**: for realistic sizes (calls × queries) the
  added per-call `balanceOf` staticcalls cost tens of thousands of gas
  against the 16M budget; a mode flag and dual ABI path are not worth it.
- **Checkpoints REPLACE the endpoint arrays**: `balanceBefore`/
  `balanceAfter` become `checkpoints[0]`/`checkpoints[calls.length]` —
  the contract result struct gets simpler, not bigger.
- **Breaking `BalanceDelta` on a published package**: pre-1.0, ships as a
  minor (0.2.0) via changeset — the executor ADDS the changeset (Step 5);
  no compat aliases.

## Current state

(All at `9f86857`.)

### Contract — `contracts/TxSimulator.sol`

Endpoint snapshots today: `simulate(...)` allocates
`result.balanceBefore/balanceAfter/balanceProbeOk` (`:68-70`), calls
`_snapshotBalanceProbes(balanceProbes, result)` before executing (`:71-73`,
impl `:166` — sets `ok` + `balanceBefore`), and
`_writeBalanceProbeResults(balanceProbes, result)` after (`:90-92`, impl
`:177-185` — ANDs `ok`, sets `balanceAfter`). Probe read helper pattern:
`token == address(0)` → native, else `_tryBalanceOf(token, account)`.

The allowance machinery to mirror: `_recordAllowanceCheckpoints(probes,
stride, offset, checkpoints)` (`:240`) called at offset 0 pre-calls
(`:199`) and offset `i+1` after each successful call (`:218`), with
`_fillRemainingCheckpoints(probeCount, stride, lastOffset, checkpoints)`
(`:252`) on a failing call (`:209`) — **`_fillRemainingCheckpoints` is
already generic** (plain probeCount/stride/array params); reuse it for
balance checkpoints unchanged. `ExecutionState` (`:53-58`) carries
`checkpoints` + `stride` for allowances; extend it (or add parallel
fields) for the balance arrays.

Result struct (`:29-43`) tail:
`... uint256[] allowanceCheckpoints; uint256[] balanceBefore; uint256[] balanceAfter; bool[] balanceProbeOk;`

### TS

- `src/internal/simulator.ts` — decoded tuple declares
  `balanceBefore/balanceAfter/balanceProbeOk` (`:38-40`); inline `parseAbi`
  result-struct string at `:62`; `balanceProbes` arg mapping
  (`"native"` ↔ zero address) at `:75-96`; `probeData` carries the arrays.
- `src/txSimulator.ts` — `runSimulate` builds
  `balanceDeltas`/`unresolved` from the probe arrays (~`:230-260`):
  ok probes → `{asset, account, before, after, delta}` in input order.
- `src/types.ts` — `BalanceDelta = { asset; account; before; after; delta }`.
- Tests assert exact `BalanceDelta` objects via `toContainEqual` — those
  gain the `byCall` field (shape-only edits; every existing VALUE frozen).

## Target design

### Contract

1. Result struct: REPLACE `uint256[] balanceBefore; uint256[] balanceAfter;`
   with `uint256[] balanceCheckpoints;` (flattened,
   `balanceProbes.length * (calls.length + 1)`, row-major per probe —
   identical layout discipline to `allowanceCheckpoints`). Keep
   `bool[] balanceProbeOk` — semantics: `ok[i]` = every ERC-20 read for
   probe `i` across ALL checkpoints succeeded (native always true); AND it
   at each recording.
2. Delete `_snapshotBalanceProbes`/`_writeBalanceProbeResults`; add
   `_recordBalanceCheckpoints(balanceProbes, stride, offset, checkpoints, ok)`
   mirroring `_recordAllowanceCheckpoints` (with the native/zero-address
   branch and the ok-AND). Call it at offset 0 pre-calls and offset `i+1`
   per successful call, both guarded by `balanceProbes.length > 0`; on a
   failing call, reuse `_fillRemainingCheckpoints(balanceProbes.length,
   stride, i, balanceCheckpoints)` alongside the allowance fill.
3. `_executeCalls` gains the balance probes/arrays (via `ExecutionState`
   extension or parameters — match the file's existing style).

### TS

1. ABI struct string updated to match (field order exactly as the
   Solidity struct).
2. `probeData`: `balanceCheckpoints: bigint[]` + `balanceProbeOk` (drop the
   two endpoint arrays).
3. `runSimulate`: per ok-probe `i` with stride `s = calls.length + 1`:
   `before = cp[i*s]`, `after = cp[i*s + calls.length]`,
   `byCall[k] = cp[i*s + k + 1] - cp[i*s + k]` (plain bigint subtraction —
   values fit safely), `delta = after - before`. Failed probes →
   `unresolved` as today.
4. `src/types.ts`:

```ts
export type BalanceDelta = {
  asset: "native" | Address;
  account: Address;
  before: bigint;
  after: bigint;
  delta: bigint;
  /** Signed change per call, index-aligned with `calls`. Sums to `delta`; on a revert, entries from the failing call onward are 0n. */
  byCall: readonly bigint[];
};
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (needs forge/anvil) |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |
| Changeset | `pnpm changeset` | interactive; pick **minor** |

## Scope

**In scope**: `contracts/TxSimulator.sol`, `src/generated/` + `dist/` (via
build only), `src/internal/simulator.ts`, `src/txSimulator.ts`,
`src/types.ts`, `test/simulate.test.ts` + `test/txSimulator.test.ts`
(shape edits + new tests), `README.md` (byCall in the dapp example + one
sentence), `CLAUDE.md` (invariants: two checkpoint arrays now),
`.changeset/*.md` (one new minor changeset), `plans/README.md` (status
row).

**Out of scope**: `estimateRequirements`/requirements machinery (passes no
balance probes; its allowance checkpoints are untouched);
`allowanceCheckpoints` semantics; any opt-in flag or compat alias for the
old `BalanceDelta` shape; `test/errors.test.ts` and `test/mainnet.test.ts`
beyond compile-level shape fixes.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.
  Branch protection is active on `master` — the operator merges.

## Steps

### Step 1: Contract

Apply the contract Target design; `pnpm build` (regenerates bytecode).

**Verify**: `forge build` exit 0;
`grep -n "balanceBefore\|balanceAfter" contracts/TxSimulator.sol` → no
matches; `grep -c "_fillRemainingCheckpoints" contracts/TxSimulator.sol` →
≥3 (definition + allowance fill + balance fill).

### Step 2: TS plumbing + type

ABI string, probeData, `runSimulate` math, `BalanceDelta.byCall` per
Target design.

**Verify**: `pnpm typecheck` → errors only in tests.

### Step 3: Tests

Shape-fix existing `BalanceDelta` assertions (add exact `byCall` arrays —
compute the expected values, don't use `expect.anything()`), then add:

1. **Three-call attribution**: batch [mint-to-spender? no — use approve(400),
   pull(300), refund-style transfer back 100 with the existing fixtures] —
   query `{token, from}` → `byCall` exactly `[0n, -300n, 100n]`-shaped for
   the actual fixture chosen; assert `byCall.reduce(+) === delta` AND the
   exact array.
2. **Zero-effect call**: a call touching nothing for the queried pair →
   its `byCall` entry is exactly `0n`.
3. **Revert mid-batch**: failing call at index 1 of 3 → `byCall[0]` real,
   `byCall[1]` and `byCall[2]` are `0n` (fill-forward), `delta` equals
   `byCall[0]`.
4. **Native per-call**: two value-bearing calls → `byCall` matches the two
   values.

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass,
three consecutive runs.

### Step 4: Docs

README: extend the dapp partial-bundle example to read a per-call value
(`.byCall[0]` for "leftover after the zap call, before repay") + one
sentence defining byCall alignment and the revert fill-forward. CLAUDE.md:
the pinned-invariants section now names BOTH checkpoint arrays and the
`sum(byCall) === delta` invariant.

**Verify**: `grep -c "byCall" README.md` → ≥2; `pnpm lint` → exit 0.

### Step 5: Changeset + full gate

`pnpm changeset` → **minor** — summary along the lines of: "BalanceDelta
gains required byCall (per-call attribution); contract result replaces
balanceBefore/balanceAfter with balanceCheckpoints." Leave the changeset
file committed with the work (the release workflow's Version Packages PR
picks it up).

**Verify**: `ls .changeset/*.md | grep -v README | wc -l` → ≥1;
`pnpm verify` → exit 0.

## Test plan

Step 3's four attribution tests (exact arrays, no matchers) + frozen
existing values + the triple-run flake bar.

## Done criteria

- [ ] `pnpm verify` exits 0; suite green 3 consecutive runs
- [ ] Contract has `balanceCheckpoints`, no `balanceBefore`/`balanceAfter`
- [ ] `BalanceDelta.byCall` required; sum-invariant + revert fill-forward tests pass with exact arrays
- [ ] `estimateRequirements` tests untouched (`git diff -- test/requirements.test.ts` → empty)
- [ ] A minor changeset exists describing the break
- [ ] README + CLAUDE.md updated per Step 4
- [ ] `plans/README.md` status row updated

## STOP conditions

- Gas: the per-call probe loop blows the 16M budget in any test — report
  the counts (calls × probes) rather than raising the budget.
- Any assertion VALUE (not shape) in existing tests needs changing —
  before/after/delta semantics must be byte-identical to pre-034.
- The `ok`-AND semantics force a probe to flip ok mid-batch in a way that
  makes `unresolved` ambiguous — report the case (a token that starts
  answering balanceOf and stops mid-batch is pathological; document rather
  than invent handling).

## Maintenance notes

- `byCall` is call-boundary granularity — intra-call transients remain
  invisible (same limitation as the requirements machinery; documented in
  Known limitations). `debug_traceCall` remains deliberately out of scope.
- The two checkpoint arrays (allowance, balance) now share stride math and
  the fill helper — any future stride change touches both; the CLAUDE.md
  invariant note marks it.
- This is the LAST deferred direction finding — after this the plans
  backlog has no standing findings; future work enters via new audits or
  maintainer/consumer requests.
