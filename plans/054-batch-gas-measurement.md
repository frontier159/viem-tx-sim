# Plan 054: Per-call batch gas measurement (implement the decided design)

> **Executor instructions**: FIRST read `docs/design/batch-gas-measurement-design-2026-07-12.md`
> in full — it is the decided design this plan implements; its sections are referenced
> as D§1–D§7. Do not re-litigate its decisions (including D§5's do-not-build list).
> Then follow this plan step by step, run every verification command, and honor every
> STOP condition. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d002535..HEAD -- contracts/TxSimulator.sol src/internal/simulator.ts src/types.ts src/txSimulator.ts src/internal/debugSteps.ts test/helpers/fakeClient.ts`
> **Anticipated drift**: plans 052 and 053 land before this plan — 052 adds
> `permit2`/`permit2Probes` params and a `permit2Checkpoints` struct field; 053 adds
> `nftCollections`, the `NftReceipt` machinery (recording hooks, two storage vars),
> and an `nftReceipts` struct field, each mirrored in `txSimulatorAbi`/`fakeClient.ts`.
> Confirm both are present and treat them as the base. This plan touches NONE of
> `simulate`'s signature or `SimulationResult` — it only ADDS a function — so any
> other divergence is a STOP. If 052 or 053 has NOT landed, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (new contract entry point; bytecode regen; new public namespace)
- **Depends on**: plans 052 and 053 (same contract/ABI files; strictly after)
- **Category**: direction
- **Planned at**: commit `d002535`, 2026-07-12

**Maintainer decision note**: the design's own verdict (D§7) was "REJECTED-pending-demand". On 2026-07-12 the maintainer explicitly scheduled the implementation — that instruction is the demand signal; D§7's verdict is superseded and recorded as such in `plans/README.md`.

**This plan explicitly authorizes regenerating `src/generated/txSimulatorBytecode.ts` via `pnpm build:contracts`.**

## Why this matters

Dependent calls in a non-atomic ERC-5792 batch (approve-then-swap) cannot be `eth_estimateGas`-ed standalone — the second leg reverts without the first leg's state. The ghost already runs the batch sequentially in one frame; a probe-free measurement entry point turns that into per-call gas figures usable as per-leg limits (D-Problem). The central hazard the design resolves is **measurement pollution**: `simulate()`'s loop interleaves probe work between calls, so measurement gets its own bare loop (D§1).

## Current state

- `contracts/TxSimulator.sol` post-052/053. The relevant primitive is `_executeCall` (pre-052 lines 202–206) — the minimal `to.call{value}(data)` with revert-data capture; `_executeCalls` (the probe-laden loop) is the pollution source and must NOT be reused (D§1).
- `src/internal/simulator.ts` — `txSimulatorAbi` and `runSimulator` (the shape to mirror for the new `runBatchGas`: encode → `buildStateOverride` with ghost code at `from` → one debug-wrapped `client.call` → decode → typed `StateOverrideUnsupportedError` on infra failure). `buildStateOverride`/`tokenSlotOverridesToStateDiff` are module-private — export them or (preferred) put `runBatchGas` in the same file.
- `src/internal/debugSteps.ts` — the vocabulary; post-048 it ends at `permit2AllowanceVerify`. Add `gasEstimateBatch: "gas.estimateBatch"` (D§4).
- `src/txSimulator.ts` — the instance interface/factory; `defaults()`/`revertDefaults()` at lines 174–194 (post-fix version also produces `accessListGas` — irrelevant here since this method makes zero access-list calls).
- `src/types.ts` — `SimulationOptions` (68–77), `SimulateArgs` (146–165, the override options to mirror: `tokenSlotOverrides`, `nativeBalanceOverrides`).
- Fixtures: `contracts/test/TestToken.sol` + `contracts/test/Spender.sol` / `StoredTokenSpender.sol` (read them; if neither pulls via `transferFrom` in one call, create a minimal `Puller.sol`).

## Design parameters (from the design doc — implement exactly)

- **Contract** (D§1): `function simulateBatchGas(SimulatedCall[] calldata calls) external returns (bool allSuccess, uint256 failingCallIndex, uint256[] memory execGasPerCall)` — bare loop over `_executeCall` only, `uint256 gasBefore = gasleft();` immediately before and delta immediately after each call, **halt-and-report**: on the first failure set `allSuccess = false`, `failingCallIndex = i`, leave `execGasPerCall[i..]` at 0 and break. Default `failingCallIndex = type(uint256).max`. No probes, no checkpoints, no struct changes.
- **TS internal** (D§6.3): `runBatchGas` beside `runSimulator` in `src/internal/simulator.ts` — same state-override assembly (ghost code at `from`, `tokenSlotOverrides`, `nativeBalanceOverrides` via `extraStateOverrides`), one `eth_call` wrapped in `withRpcDebug` with step `gas.estimateBatch`, decode the flat tuple, infra failures → `StateOverrideUnsupportedError`. Intrinsic math in a new `src/internal/gas.ts`: `intrinsicAndCalldataGas(data) = 21_000n + max(4z + 16nz, 10(z + 4nz))` where z/nz are zero/non-zero calldata byte counts (EIP-7623 floor, D§3) — pure function, unit-testable without Anvil.
- **Public surface** (D§2): `readonly gas: { estimateBatch(args: EstimateBatchGasArgs): Promise<BatchGasEstimate> }` on the `TxSimulator` interface, wired through `defaults()` like the other namespaces. Types exactly as D§2:
  - `EstimateBatchGasArgs = SimulationOptions & { from; calls; tokenSlotOverrides?; nativeBalanceOverrides? }` (throw `InvalidSimulationInputError` on empty `calls`, matching `simulate`).
  - `BatchGasEstimate = { byCall: BatchGasCallEstimate[]; totalSuggestedLimit: bigint; failingCallIndex: number | null }`; `BatchGasCallEstimate = { executionGas; intrinsicAndCalldataGas; suggestedLimit }` with `suggestedLimit = executionGas + intrinsicAndCalldataGas`, **pre-buffer** (D§3: the 2× EIP-150 buffer is the consumer's, documented not applied). `byCall` zero-entries (`executionGas: 0n`, but intrinsic still computed? NO — from the failing call onward ALL THREE fields are `0n`, matching the contract zero-fill and the repo's zero-tail convention; state this in the JSDoc).
- **ABI** (D§4): one `simulateBatchGas` line added to `txSimulatorAbi`; a small `encodeBatchGasResult` helper in `fakeClient.ts` for error-path tests. Flat tuple — no struct lockstep.
- **Docs** (D§6.4): README section with the recommended 2× buffer and BOTH error bars — cross-block state drift, and the cold-start systematic under-measurement for separately-broadcast legs (D§3's known-direction warning). Lift the wording from D§3 rather than paraphrasing loosely.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Rebuild | `pnpm build:contracts` | exit 0 |
| Gate | `pnpm verify` | exit 0 |
| Focused | `pnpm test -- test/gas.test.ts test/abi.test.ts` | all pass |

## Scope

**In scope**: `contracts/TxSimulator.sol`; `src/generated/txSimulatorBytecode.ts` (regenerated); `src/internal/simulator.ts`; `src/internal/gas.ts` (create); `src/internal/debugSteps.ts`; `src/types.ts`; `src/txSimulator.ts`; `src/index.ts` (export the three new types); `test/helpers/fakeClient.ts`; `test/gas.test.ts` (create); `contracts/test/Puller.sol` (create only if no existing fixture pulls via `transferFrom`); README; `.changeset/<new>.md` (minor); `plans/README.md`; `test/txSimulator.test.ts` (the interface-conformance mock needs the new namespace — one-line addition, precedent from plan 048).

**Out of scope** (D§5 — do NOT build): `eth_simulateV1` anything; per-chain gas registries; EIP-7702 delegate-code handling; a library-applied buffer; discovery inside `estimateBatch` (overrides are the caller's prior step); changes to `simulate()`'s path, params, or `SimulationResult`.

## Git workflow

- Branch: `advisor/054-batch-gas-measurement` (or master if the operator says so); message `feat: per-call batch gas measurement (plan 054)`.
- Do NOT push unless instructed.

## Steps

### Step 1: Contract + ABI

Add `simulateBatchGas` per Design parameters; regenerate; add the `txSimulatorAbi` line; extend `fakeClient.ts`.

**Verify**: `pnpm build:contracts` → exit 0; `pnpm test -- test/abi.test.ts` → passes.

### Step 2: TS internals

`src/internal/gas.ts` (`intrinsicAndCalldataGas`), `runBatchGas` in `simulator.ts`, the `gasEstimateBatch` debug step.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Public surface

Types, interface JSDoc (including the zero-tail and pre-buffer semantics and the D§3 buffer guidance), factory wiring, barrel exports, conformance-mock line in `test/txSimulator.test.ts`.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0; full suite green (`pnpm test`) — nothing existing may move.

### Step 4: Tests (`test/gas.test.ts`, Anvil, modeled on `test/simulate.test.ts`)

1. **Dependent-calls (load-bearing, D§6)**: TestToken + a puller; batch `[approve(puller, 500), puller.pull(token, from, 500)]`. Assert (a) standalone `client.estimateGas` of call 2 alone REVERTS (proves the problem), and (b) `gas.estimateBatch` → `failingCallIndex === null`, `byCall[0].executionGas > 0n`, `byCall[1].executionGas > 0n`, `totalSuggestedLimit === sum(byCall[i].suggestedLimit)`.
2. **Failing call**: batch whose 2nd call reverts → `failingCallIndex === 1`, `byCall[1]` all-zero, `byCall[0].executionGas > 0n`.
3. **Intrinsic math unit test** (no Anvil): known byte mixes hit both sides of the 7623 `max` — e.g. 4 nonzero bytes (standard wins) vs a long zero-heavy payload (floor wins); exact expected values computed in the test.
4. **RPC-count pin**: debug callback → exactly one `eth_call` with step literal `"gas.estimateBatch"`, zero `eth_createAccessList` (pin per ADR-0001, string literals).
5. **Overrides matter (D§2)**: unfunded `from` pulling tokens → without `tokenSlotOverrides` the pull leg fails (`failingCallIndex === 1`); with prepared overrides (reuse `tokenOverrides.forBalances`/`forAllowances`) it measures both legs.

**Verify**: `pnpm test -- test/gas.test.ts` → all pass.

### Step 5: Docs, changeset, index

README section per Design parameters. Minor changeset: "Add `gas.estimateBatch`: per-call gas measurement for sequential batches via a probe-free ghost entry point; returns pre-buffer suggested limits (EIP-7623-aware intrinsic math) — apply your own EIP-150 headroom buffer (2× recommended)." Update the 054 row in `plans/README.md` AND amend the deferred-findings entry for the batch-gas feature: superseded by maintainer decision 2026-07-12, D§7 verdict overridden.

**Verify**: `pnpm verify` → exit 0.

## Done criteria

- [ ] `grep -c "simulateBatchGas" contracts/TxSimulator.sol src/internal/simulator.ts` → ≥1 each; bytecode regenerated in the diff
- [ ] `grep -n "gas.estimateBatch" src/internal/debugSteps.ts test/gas.test.ts` → vocabulary entry + literal pin
- [ ] `pnpm verify` exits 0; 5 new tests pass; zero pre-existing test modifications beyond the authorized conformance-mock line
- [ ] `grep -in "simulateV1" src/` → no matches
- [ ] README section present; minor changeset present
- [ ] No files outside the in-scope list modified; `plans/README.md` updated (row + deferred-entry amendment)

## STOP conditions

- Plan 052 or 053 has not landed, or the contract diverges beyond their expected additions.
- Test 4 shows more than one `eth_call` (hidden RPC — the invariant this feature was designed around).
- Test 1(a) does NOT revert standalone (the fixture isn't dependent; find/build one that is rather than weakening the assertion).
- Implementing `runBatchGas` seems to require touching `_executeCalls`, `SimulationResult`, or any probe machinery.
- Measured `executionGas` values are wildly implausible (e.g. 0 for a successful ERC-20 transfer, or > the eth_call budget) — report raw values.

## Maintenance notes

- The `gasleft()` deltas include `_executeCall`'s returndata-copy overhead — inherent and small; if precision complaints arrive, the fix is an assembly call with no returndata copy, at the cost of losing failure diagnostics in this entry point.
- Anyone adding probes or checkpoints later must NOT wire them into `simulateBatchGas`'s loop — pollution-freedom is the entry point's entire reason for existing (D§1). The RPC-count/step-pin test plus a code-review eye are the guards.
- Consumer-facing accuracy caveats live in README; if a consumer reports systematic under-measurement on separately-broadcast legs, that is the documented cold-start divergence (D§3), not a bug.
