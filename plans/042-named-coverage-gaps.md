# Plan 042: Close the named test-coverage gaps (debug sink, block selection, estimator revert fields, selectorless reverts, vacuous test)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop,
> revert the changes, mark this plan BLOCKED with what you found, and
> report — never adapt production code to make a new test pass. When done,
> update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8931d7e..HEAD -- test/ src/internal/rpc.ts src/internal/requirements.ts`
> Plan 039 (if executed first, as recommended) touches
> `test/errors.test.ts`, `src/internal/rpc.ts`, and
> `src/internal/requirements.ts` — that drift is expected; anything else
> changed means compare "Current state" excerpts before proceeding and STOP
> on mismatch.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW — test-only additions plus one vacuous-test replacement; no
  production code changes allowed.
- **Depends on**: 039 (recommended order only — both edit
  `test/errors.test.ts`; execute 039 first to avoid rebasing)
- **Category**: tests
- **Planned at**: commit `8931d7e`, 2026-07-10

## Why this matters

Five verified gaps let documented public behavior regress silently:
(1) the console/env debug sink (`debug: true`, `VIEM_TX_SIM_DEBUG_RPC=1`)
has zero coverage — every test uses the callback form; (2) historical-block
simulation (`blockNumber`/`blockTag`) runs only in the opt-in mainnet
suite, so CI never exercises the block-parameter wiring; (3) the
reverted-estimate path never asserts its decoded revert fields and no
`estimateRequirements` test passes `errorAbi`, leaving the estimator's
independent copy of the revert plumbing unpinned; (4) no test produces
selector-less revert data (bare `revert()`), so behavior for the common
empty-returndata revert is unspecified; (5) one test asserts nothing
(`expect(fake).toBeDefined()` on a module-scope const).

## Current state

All verified at `8931d7e`:

- `src/internal/rpc.ts:154-209` — `emitDebug` (console branch when
  `debug === true` or `envDebugEnabled()`), `envDebugEnabled` (reads
  `VIEM_TX_SIM_DEBUG_RPC === "1"`), `formatDebugEvent`, `formatValue`
  (bigint/array branches). `grep -rn "debug: true\|DEBUG_RPC" test/`
  (excluding mainnet) → no hits.
- `src/internal/rpc.ts:34-40` `blockOptionsSpread`, `:58-62`
  (`blockNumber` precedence in `buildCallParameters`), `:97-98` (block arg
  in `createAccessList`). Only `test/mainnet.test.ts` uses `blockNumber`.
- `src/internal/requirements.ts:133-145` — the reverted branch copies
  `revertData`/`revertReason`/`revertError`/`revertSelector`/`failingCallIndex`
  onto the estimate result. The only reverting-estimate test
  (`test/requirements.test.ts:205-231`, "measures the executed prefix when
  a batch reverts mid-way") asserts `failingCallIndex`, balances, and
  allowances — no revert-decode fields, and no `errorAbi` anywhere in that
  suite.
- `src/internal/simulator.ts:226-240` `decodeRevert`: `!data || data ===
  "0x"` → `{}`. All reverting fixtures carry 4-byte selectors; nothing
  exercises the empty-returndata path end to end.
- `test/txSimulator.test.ts:86-88`:

```ts
  it("is structurally mockable", () => {
    expect(fake).toBeDefined();
  });
```

  where `fake` is a module-scope object literal typed `TxSimulator`
  (lines ~91-106); the runtime assertion is vacuous (the type conformance
  is what matters, and `pnpm typecheck` enforces that).

Repo conventions:
- Anvil behavior tests: `test/simulate.test.ts` pattern —
  `startAnvil()` per test via `beforeEach`, `deploy`/`write` from
  `test/helpers/contracts.ts`.
- Chain-free error/edge tests: `test/errors.test.ts` pattern over
  `fakeClient`/`encodeSimulationResult` from `test/helpers/fakeClient.ts`.
- Custom-error exemplar to model TESTS-05 on: `test/simulate.test.ts`
  "decodes custom error reverts with per-call ABI" (deploys
  `CustomErrorTarget.sol`, passes
  `errorAbi: parseAbi(["error InsufficientBalance(uint256 have, uint256 want)"])`,
  asserts `revertError`, `revertReason`, `revertSelector`).
- ADR-0001: pin debug-step names as string literals in tests; never import
  `DEBUG_STEPS` into tests.
- Debug-step counts are pinned per operation in existing tests — new tests
  must not alter any existing assertion.

## Commands you will need

| Purpose    | Command                                        | Expected on success |
|------------|------------------------------------------------|---------------------|
| Install    | `pnpm install`                                 | exit 0              |
| Contracts  | `pnpm build:contracts`                         | exit 0              |
| One suite  | `pnpm exec vitest run test/errors.test.ts`     | all pass            |
| One suite  | `pnpm exec vitest run test/simulate.test.ts`   | all pass (needs Anvil on PATH) |
| Full gate  | `pnpm verify`                                  | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `test/errors.test.ts` (debug sink, selectorless revert)
- `test/simulate.test.ts` (block-number pinning)
- `test/requirements.test.ts` (estimator revert fields + errorAbi)
- `test/txSimulator.test.ts` (vacuous test)

**Out of scope** (do NOT touch):
- Anything under `src/` or `contracts/` — if a new test exposes a real
  production bug, STOP and report; do not fix it here.
- `test/mainnet.test.ts`, `test/checkpoints.test.ts`.
- Existing assertions in any suite (especially pinned step counts).

## Git workflow

- Branch: `plan-042-named-coverage-gaps`
- Commit per step; message style matches `git log`.
- No changeset (test-only).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Debug sink tests (`test/errors.test.ts`)

Two tests using `fakeClient` with `eth_call: () => encodeSimulationResult()`:

1. `debug: true` logs to the console: `const spy = vi.spyOn(console,
   "debug").mockImplementation(() => {})`; run
   `sim.simulate({ from, calls: [{ to, data: "0x" }], balanceQueries: [], debug: true })`;
   assert `spy` was called with a string containing `"txSimulator.simulate"`
   (string literal per ADR-0001) and `"[viem-tx-sim]"`; restore the spy.
2. `VIEM_TX_SIM_DEBUG_RPC=1` enables the same sink without `debug`:
   set `process.env.VIEM_TX_SIM_DEBUG_RPC = "1"` in a try/finally (delete it
   in finally), spy on `console.debug`, simulate WITHOUT a `debug` arg,
   assert a call containing `"txSimulator.simulate"`.

Import `vi` from `vitest`.

**Verify**: `pnpm exec vitest run test/errors.test.ts` → all pass, 2 new tests.

### Step 2: Selectorless revert test (`test/errors.test.ts`)

Script `eth_call: () => encodeSimulationResult({ success: false,
failingCallIndex: 0n, revertData: "0x" })`; simulate one call; assert
`result.status === "reverted"`, `result.revertData === "0x"`,
`result.revertSelector`, `result.revertReason`, `result.revertError` all
`undefined`, and `result.failingCallIndex === 0`.

**Verify**: `pnpm exec vitest run test/errors.test.ts` → all pass, 1 more new test.

### Step 3: Historical-block test (`test/simulate.test.ts`)

Anvil test following the suite's existing `beforeEach` context pattern:

1. Deploy `TestToken.sol`, `mint` 1_000n to `ctx.account.address` (see the
   suite's existing mint calls for the `write` helper shape).
2. `const pinned = await ctx.publicClient.getBlockNumber()`.
3. `mint` another 500n (advances a block and changes state).
4. `sim.simulate({ from, calls: [{ to: token.address, data: <a transfer of 1n> }], balanceQueries: [{ asset: token.address, account: from }], blockNumber: pinned })`.
5. Assert the returned delta's `before === 1_000n` (the pre-second-mint
   balance), proving the `blockNumber` threaded through both the state read
   and the call.

**Verify**: `pnpm exec vitest run test/simulate.test.ts` → all pass, 1 new test.

### Step 4: Estimator revert fields + errorAbi (`test/requirements.test.ts`)

New test modeled on the suite's "measures the executed prefix when a batch
reverts mid-way" (`:205-231`) crossed with `test/simulate.test.ts`'s
"decodes custom error reverts with per-call ABI":

1. Deploy `CustomErrorTarget.sol`; encode `failWithArgs(1n, 2n)`.
2. `sim.tokenOverrides.estimateRequirements({ from, calls: [{ to: target.address, data }], errorAbi: parseAbi(["error InsufficientBalance(uint256 have, uint256 want)"]) })`.
3. Assert `status === "reverted"`, `failingCallIndex === 0`,
   `revertError` equals `{ name: "InsufficientBalance", args: [1n, 2n] }`,
   `revertReason === "InsufficientBalance(1, 2)"`, and `revertSelector`
   is defined.

**Verify**: `pnpm exec vitest run test/requirements.test.ts` → all pass, 1 new test.

### Step 5: Replace the vacuous assertion (`test/txSimulator.test.ts`)

Replace the body of `it("is structurally mockable", ...)`: instead of
`expect(fake).toBeDefined()`, invoke the mock through the interface type and
assert its stubbed result, e.g.
`await expect(fake.simulate(<minimal SimulateArgs literal>)).resolves.toEqual(<the stub's return>)`
using whatever the module-scope `fake` stub already returns (read the stub
first; do not change its shape). If the stub's `simulate` is not callable
as-is, make the smallest change to the stub that keeps its `TxSimulator`
type annotation intact. Do not delete the type-conformance const — it is
the compile-time check.

**Verify**: `pnpm exec vitest run test/txSimulator.test.ts` → all pass.

### Step 6: Full gate

**Verify**: `pnpm verify` → exit 0; total test count increased by exactly 5 (2 debug + 1 selectorless + 1 block + 1 estimator) with Step 5 replacing an existing test 1:1.

## Test plan

This plan IS the test plan: five new/replaced tests as specified per step,
each following the named exemplar in its target suite. No production code
changes.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm verify` exits 0
- [ ] `grep -c "debug: true" test/errors.test.ts` ≥ 1 and `grep -c "VIEM_TX_SIM_DEBUG_RPC" test/errors.test.ts` ≥ 1
- [ ] `grep -c "blockNumber" test/simulate.test.ts` ≥ 1
- [ ] `grep -c "errorAbi" test/requirements.test.ts` ≥ 1
- [ ] `grep -c "toBeDefined" test/txSimulator.test.ts` = 0
- [ ] No files under `src/` or `contracts/` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any new test FAILS against unmodified production code — that is a real
  bug discovery (e.g. block-number threading broken, estimator revert
  fields not populated); report the failure verbatim.
- An existing pinned assertion (step counts, delta values) breaks.
- Step 3's historical read behaves unexpectedly on Anvil (e.g. state
  overrides rejected at historical blocks) — report rather than switching
  the test to `blockTag: "latest"` (which would not cover the gap).
- The `fake` stub in `test/txSimulator.test.ts` differs materially from the
  description here.

## Maintenance notes

- The debug-sink tests intentionally pin the `[viem-tx-sim]` console prefix
  and the `txSimulator.simulate` step literal; renaming either is a
  conscious, reviewed act (ADR-0001).
- Deferred out of this plan (recorded in `plans/README.md`): duplicate-input
  aliasing specs (TESTS-07), a bespoke fixture for the
  `computeAllowanceSlot` re-probe fallback (TESTS-03), and coverage
  instrumentation (TESTS-09 — blocked on the vitest major bump decision).
