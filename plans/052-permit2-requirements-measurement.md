# Plan 052: Measure Permit2 allowance requirements in estimateRequirements

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d002535..HEAD -- contracts/TxSimulator.sol src/internal/simulator.ts src/internal/requirements.ts src/internal/slots.ts src/types.ts test/helpers/fakeClient.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (contract + struct + ABI lockstep change; bytecode regeneration)
- **Depends on**: none (first of the 052–054 contract-touching wave; 053/054 rebase on this)
- **Category**: direction
- **Planned at**: commit `d002535`, 2026-07-12

**This plan explicitly authorizes regenerating `src/generated/txSimulatorBytecode.ts` via `pnpm build:contracts`.** It extends the `simulate` signature and the `SimulationResult` struct, so the three-way ABI lockstep (contract / `txSimulatorAbi` / `fakeClient.ts`) must move together — `test/abi.test.ts` gates it.

## Why this matters

This is the deferred second half of plan 048 (see `docs/walletchan-learnings-2026-07-12.md` item 5). Plan 048 made Permit2-routed paths *simulatable* under forged internal allowances (`tokenOverrides.forPermit2Allowances`), but `estimateRequirements` still cannot *measure* the Permit2 leg: its allowance probing speaks only the ERC-20 `allowance(owner,spender)` selector, which Permit2 does not implement. On a Universal-Router/0x-style path the estimator today forges the ERC-20 balance and the ERC-20→Permit2 approval, then the measurement run reverts at the Permit2 internal-allowance check and reports nothing useful about it. After this plan, `estimateRequirements` on a Permit2-routed batch (a) forges the Permit2 internal allowance so the measurement succeeds and (b) reports the required Permit2 allowance per (token, spender) alongside the existing ERC-20 requirements — with zero RPC or behavior change on paths that never touch Permit2.

## Current state

Read these fully before editing; excerpts below are the load-bearing anchors.

- `contracts/TxSimulator.sol` — the ghost contract. `simulate` takes 4 params and returns the 9-field `SimulationResult` (lines 33–43, 62–67). Allowance checkpoints are recorded per call boundary by `_recordAllowanceCheckpoints` (lines 220–230) via the gas-capped `_tryAllowance` (lines 278–289, `staticcall{gas: PROBE_GAS_LIMIT}` with `PROBE_GAS_LIMIT = 150_000` at line 15). `_executeCalls` (lines 144–200) records offset 0, then offset `i+1` after each successful call, and `_fillRemainingCheckpoints` fill-forwards on failure. `ExecutionState` (lines 53–60) carries the grids through the loop.
- `src/internal/simulator.ts:60-67` — `txSimulatorAbi` parseAbi strings (struct + `simulate` signature must mirror the contract exactly; `test/abi.test.ts` compares against the forge artifact). `runSimulator` (line 69) encodes the 4 args and surfaces `probeData` with the checkpoint arrays.
- `src/internal/requirements.ts` — the estimator: candidate discovery with insufficient-funds fallback (lines 42–56), recon `runSimulator` (57–67), spender set = call targets + candidates minus `from` (68–71), parallel `prepareBalanceOverrides` + `prepareAllowanceOverrides` (73–92), forged measurement `runSimulator` with `allowanceProbes` (100–112), `requiredAllowances` decrease-sum with in-batch-grant exclusion and gross-outflow clamp (183–218), `firstInBatchAllowanceSetIndex`/`isAllowanceSetForSpender` (220–245) using `allowanceSettingAbi` (19–22).
- `src/internal/slots.ts:234-385` — the plan-048 Permit2 machinery: `CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"`, `preparePermit2Overrides` (254–287, sequential with per-invocation base-slot cache), `resolvePermit2Slot` (sentinel `OVERRIDE_PERMIT2_AMOUNT = 10^45` packed with preserved nonce), `readPermit2Allowance` (329–381, typed-error classification), `permit2AllowanceSlot` (383–385).
- `src/internal/checkpoints.ts:13-21` — `probeRow`, the sole home of the stride math `checkpoints[probeIndex * (calls.length + 1) + callIndex]`.
- `src/types.ts` — `EstimateAssetRequirementsArgs` (202–209), `EstimatedAssetRequirementsBase` (235–256, including the `unresolved` object), `RequiredAllowance` (229–233), `AllowanceSlotPair` (98–101).
- `test/helpers/fakeClient.ts:33-60` — `SimulationResultStruct` + `encodeSimulationResult` defaults; must gain the new field.
- Fixtures: `contracts/test/MockPermit2.sol` (plan 048; layout-faithful `allowance` at slot 1, `transferFrom(from,to,amount,token)` with expiration check and max-uint160 skip, `setNonce`), `contracts/test/TestToken.sol`. Test exemplars: `test/permit2.test.ts` (anvil setup + debug-event pinning), `test/requirements.test.ts` (estimator assertions, pinned RPC counts).

Repo conventions: tests spawn one Anvil per test; RPC counts and debug-step names are pinned as string literals (ADR-0001); deterministic ordering everywhere; `pnpm verify` is the gate.

## Design (decided — do not re-litigate)

- **Contract**: `simulate` gains two trailing params — `address permit2, AllowanceProbe[] calldata permit2Probes` (reusing the existing `AllowanceProbe {token, spender}` struct) — and `SimulationResult` gains one trailing field `uint256[] permit2Checkpoints`. A new `_tryPermit2Allowance(address permit2, address token, address owner, address spender)` staticcalls `permit2.allowance(owner, token, spender)` (selector `0x927da105` — verify with `cast sig "allowance(address,address,address)"` before hardcoding) with `{gas: PROBE_GAS_LIMIT}`, requires `data.length >= 96` (the getter returns three words), and decodes the FIRST word only (the `uint160 amount`; expiration/nonce are irrelevant to measurement). A new `_recordPermit2Checkpoints` mirrors `_recordAllowanceCheckpoints` (failed reads record 0), wired into `_executeCalls` at offset 0, after each successful call, and into the fill-forward on failure — identical stride, identical zero-tail convention. `ExecutionState` gains the array. When `permit2Probes.length == 0` nothing runs (the `permit2` address may be zero then).
- **TS plumbing**: `runSimulator` gains optional `permit2?: Address` and `permit2Probes?: readonly {token, spender}[]` (encoded as `zeroAddress` + `[]` when absent); `probeData` gains `permit2Checkpoints`. `txSimulatorAbi` and `fakeClient.ts` updated in lockstep.
- **Estimator**: `EstimateAssetRequirementsArgs` gains `permit2Address?: Address` (defaults to `CANONICAL_PERMIT2` — export it from slots.ts). Permit2 handling engages ONLY when the resolved permit2 address appears in the candidate set or call targets (compare via `addressKey`) — otherwise zero extra RPC calls and byte-identical behavior. When engaged: permit2 pairs = the same `allowancePairs(tokens, spenders)` cross-product (spenders additionally excluding the permit2 address itself); `preparePermit2Overrides` joins the existing `Promise.all` alongside the two ERC-20 prepares; resolved slots merge into `tokenSlotOverrides` for the measurement; resolved pairs become `permit2Probes`. Measurement math: a new `requiredPermit2Allowances` reuses the exact `requiredAllowances` shape — `probeRow` over `permit2Checkpoints`, sum of per-call decreases up to the first in-batch Permit2 grant, gross-outflow clamp against the pair's token, discards to `unresolved`.
- **In-batch Permit2 grant detection** (the analog of `firstInBatchAllowanceSetIndex`, but the call target is the permit2 address, not the token): decode calls to permit2 against `parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)", "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)"])`; a match on (token, spender) — for `permit`, additionally `owner == from` — marks the grant index. Batch-permit (`PermitBatch`) variants are out of scope; document in the JSDoc.
- **Result shape**: `EstimatedAssetRequirementsBase` gains `permit2Allowances: RequiredAllowance[]` (empty when Permit2 uninvolved) and its `unresolved` object gains `permit2Slots: AllowanceSlotPair[]` (pairs `preparePermit2Overrides` could not verify) and `permit2Allowances: AllowanceSlotPair[]` (measured-but-discarded). JSDoc mirrors the existing fields' style.
- **No new debug steps**: preparation reuses `permit2Allowance.read`/`permit2Allowance.verify` (already pinned by `test/permit2.test.ts`); measurement rides the existing `txSimulator.simulate` step.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rebuild contract + bytecode | `pnpm build:contracts` | exit 0; generated file rewritten |
| Selector check | `cast sig "allowance(address,address,address)"` | `0x927da105` (STOP if different) |
| Typecheck / lint | `pnpm typecheck` / `pnpm lint` | exit 0 |
| Focused tests | `pnpm test -- test/requirements.test.ts test/permit2.test.ts test/abi.test.ts` | all pass |
| Full gate | `pnpm verify` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `contracts/TxSimulator.sol`, `src/generated/txSimulatorBytecode.ts` (regenerated only)
- `src/internal/simulator.ts`, `src/internal/requirements.ts`, `src/internal/slots.ts` (export `CANONICAL_PERMIT2` only), `src/types.ts`, `src/txSimulator.ts` (JSDoc for the new arg/result fields only)
- `test/helpers/fakeClient.ts`, `test/requirements.test.ts` and/or `test/permit2.test.ts`, `contracts/test/Permit2Router.sol` (create)
- `.changeset/<new>.md`, `plans/README.md`

**Out of scope** (do NOT touch):
- `simulate()`'s public arg/result types — Permit2 measurement is an estimator feature; `SimulateArgs` gains nothing (the extra contract params are internal plumbing with empty defaults).
- `preparePermit2Overrides`' behavior and its debug steps (only re-exported/reused).
- `src/internal/checkpoints.ts` — `probeRow` is generic; use it, don't extend it.
- Batch-permit (`PermitBatch`) decoding; walletchan-style automatic retry logic.

## Git workflow

- Branch: `advisor/052-permit2-requirements-measurement` (or master if the operator says so)
- Message style: `feat: measure Permit2 allowance requirements in estimateRequirements (plan 052)` + the repo's Co-Authored-By trailer convention if instructed.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Contract

Add the two params, the struct field, `_tryPermit2Allowance`, `_recordPermit2Checkpoints`, the `ExecutionState` field, and the `_executeCalls` wiring (offset 0 / `i+1` / fill-forward), all mirroring the existing allowance-grid code style. Add `bytes4 internal constant PERMIT2_ALLOWANCE_SELECTOR = 0x927da105;` next to the other selectors (after verifying with `cast sig`).

**Verify**: `pnpm build:contracts` → exit 0; generated bytecode changed.

### Step 2: ABI lockstep

Update `txSimulatorAbi`'s `SimulationResult` struct line (append `uint256[] permit2Checkpoints`) and `simulate` line (append `address permit2, AllowanceProbe[] permit2Probes`); update `fakeClient.ts`'s `SimulationResultStruct` + `encodeSimulationResult` default (`permit2Checkpoints: []`).

**Verify**: `pnpm test -- test/abi.test.ts` → passes (it fails until both sides agree — use it as the gate).

### Step 3: runSimulator plumbing

Add the optional args, encode `args.permit2 ?? zeroAddress` and `args.permit2Probes ?? []` as the 5th/6th ABI args, and surface `permit2Checkpoints` in `probeData`.

**Verify**: `pnpm typecheck` → exit 0; full existing suite passes unchanged (`pnpm test`) — the empty-probe path must be behavior-invisible, including every pinned RPC-count test.

### Step 4: Types and estimator

Implement the Design section in `src/types.ts` and `src/internal/requirements.ts` (detection gate, pairs, Promise.all join, probes + merged slots into measurement, `requiredPermit2Allowances`, result fields). Export `CANONICAL_PERMIT2` from slots.ts and use it as the `permit2Address` default. Update the `estimateRequirements` JSDoc in `src/txSimulator.ts` (one sentence on Permit2 measurement + the PermitBatch limitation).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 5: Fixture and tests

Create `contracts/test/Permit2Router.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMockPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// Router-shaped fixture: pulls the user's tokens through Permit2's internal allowance,
/// so the estimator must discover and measure the (token, router) Permit2 requirement.
contract Permit2Router {
    function pull(address permit2, address token, address from, uint160 amount) external {
        IMockPermit2(permit2).transferFrom(from, address(this), amount, token);
    }
}
```

Anvil tests (in `test/requirements.test.ts`, modeled on its existing estimator cases; MockPermit2/TestToken deploy patterns are in `test/permit2.test.ts`):

1. **Measured requirement**: `from` holds nothing. Calls = `[TestToken.approve(mockPermit2, 500)]`-free — just `[router.pull(mockPermit2, testToken, from, 500)]`. `estimateRequirements({ from, calls, permit2Address: mockPermit2 })` → `status: "success"` (all three legs forged), `balances` includes `{ token: testToken, amount: 500n }`, `allowances` includes the ERC-20 `{ token: testToken, spender: mockPermit2, amount: 500n }`, and **`permit2Allowances` equals `[{ token: testToken, spender: router, amount: 500n }]`**.
2. **In-batch grant excluded**: calls = `[mockPermit2.approve(testToken, router, 500, maxUint48), router.pull(...)]`. NOTE: MockPermit2 (plan 048) has no `approve` — add a canonical-signature `approve(address token, address spender, uint160 amount, uint48 expiration)` to `contracts/test/MockPermit2.sol` that sets amount+expiration and leaves nonce alone (fixture edit, in scope). Expect `permit2Allowances` empty for that pair.
3. **Uninvolved path unchanged**: the existing estimator tests (pinned RPC counts and amounts) pass byte-identically — this is a done criterion, not a new test.
4. **Unresolved reporting**: `permit2Address` pointing at a non-Permit2 contract (e.g. TestToken) with a batch that touches it → pairs land in `unresolved.permit2Slots`, nothing throws, and the rest of the estimate still returns.

**Verify**: `pnpm test -- test/requirements.test.ts test/permit2.test.ts` → all pass, including ≥3 new tests.

### Step 6: Changeset and index

Minor changeset: "estimateRequirements now forges and measures Permit2 internal allowances on Permit2-routed paths, reporting them as `permit2Allowances` (with `unresolved.permit2Slots`/`unresolved.permit2Allowances`); paths that never touch Permit2 are unchanged." Update the 052 row in `plans/README.md`.

**Verify**: `pnpm verify` → exit 0.

## Test plan

Steps 5.1–5.4 above, plus: the entire pre-existing suite must pass **unchanged** (empty-probe contract path and uninvolved-estimator path are both behavior-invisible; pinned RPC counts prove it).

## Done criteria

- [ ] `grep -c "permit2Checkpoints" contracts/TxSimulator.sol src/internal/simulator.ts test/helpers/fakeClient.ts` → ≥1 each
- [ ] `cast sig "allowance(address,address,address)"` output matches the hardcoded selector
- [ ] `pnpm verify` exits 0; `test/abi.test.ts` passes; no existing test modified (except the authorized MockPermit2 fixture extension)
- [ ] New tests from Step 5 pass; `permit2Allowances` empty on uninvolved paths
- [ ] Minor changeset present; bytecode regenerated in the diff
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The drift check shows in-scope changes beyond this plan's own edits (053/054 must not have run first — this plan is the wave's base).
- `cast sig` disagrees with `0x927da105`.
- Any pinned RPC-count or amount test fails on a Permit2-uninvolved path (the feature gate is leaking).
- Wiring the grid requires changing `probeRow` or the existing allowance/balance grid semantics.
- The measurement in test 5.1 reports an amount ≠ 500n (off-by-one in grant exclusion or clamp — report the observed row values, don't fudge the assertion).

## Maintenance notes

- Plans 053 and 054 also extend the contract and `txSimulatorAbi`; they are written to land AFTER this plan and expect its two extra `simulate` params and struct field to exist. Execute 052 → 053 → 054.
- `PermitBatch`/`permitTransferFrom` (SignatureTransfer) flows are undetected for in-batch-grant exclusion — a conservative direction (over-reports the requirement); revisit on a consumer report.
- A real-chain check against canonical Permit2 + Universal Router belongs in `test/mainnet.test.ts` eventually; out of scope here.
