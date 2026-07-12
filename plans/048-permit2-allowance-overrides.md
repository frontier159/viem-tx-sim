# Plan 048: Permit2 allowance overrides (nonce-preserving)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3bce89e..HEAD -- src/internal/slots.ts src/internal/probes.ts src/constants.ts src/types.ts src/txSimulator.ts src/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (new public helper, new sentinel constant, packed-slot math)
- **Depends on**: none (TS-only; no contract or bytecode change)
- **Category**: direction
- **Planned at**: commit `3bce89e`, 2026-07-12

## Why this matters

Modern swap paths (Uniswap Universal Router, 0x) draw funds through the canonical Permit2 singleton, whose internal allowance lives in `allowance(owner, token, spender)` — a triple-nested mapping our ERC-20-selector probing (`allowance(owner, spender)`) can never discover or forge. Today, simulating or estimating a Permit2-routed path fails at the Permit2 leg even after the ERC-20 balance and the ERC-20→Permit2 approval are forged. walletchan solves this by computing Permit2's packed slot, then overriding expiration+amount **while preserving the on-chain 48-bit nonce**, because `permit()` verifies the signed nonce against storage (see `docs/walletchan-learnings-2026-07-12.md` item 5).

Two constraints shape the design:
- Permit2 packs `{uint160 amount; uint48 expiration; uint48 nonce}` into one slot, and Permit2 (like ERC-20) **skips the amount decrement at exactly `type(uint160).max`** — so the sentinel doctrine applies, but `OVERRIDE_TOKEN_AMOUNT = 10^50` does not fit (`2^160 − 1 ≈ 1.46 × 10^48`). A second, Permit2-specific sub-`2^160` non-max sentinel is required.
- Everything stays RPC-only and viem-only, with sentinel-verified writes like all other forging (`unresolved` on verification failure), per the repo's "unverified slot discovery is unsafe" posture.

## Current state

- `src/internal/slots.ts` — the existing override preparers. The mapping-slot math to mirror:

```ts
// src/internal/slots.ts:189-200
function mappingSlot(key: Address, baseSlot: Hex | bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [key, typeof baseSlot === "bigint" ? baseSlot : BigInt(baseSlot)],
    ),
  );
}

function allowanceSlotFor(owner: Address, spender: Address, base: bigint): Hex {
  return mappingSlot(spender, mappingSlot(owner, base));
}
```

- `src/internal/probes.ts:142-181` — `readUint256Call` (private): eth_call returning the first 32-byte word, with optional `stateOverride`, `undefined` on failure. The Permit2 reads in this plan need the same shape but decode a 3-tuple; see Step 2.
- `src/constants.ts` — `OVERRIDE_TOKEN_AMOUNT = 10n ** 50n` with the non-max rationale docblock (lines 9-15). The new sentinel goes next to it.
- `src/types.ts:83+` — `TokenSlotOverride = { token, slot, amount }`; `tokenSlotOverridesToStateDiff` (`src/internal/simulator.ts:293-313`) writes `uint256Hex(amount)` to `slot` on account `token` and throws on `amount === MAX_UINT256`. A Permit2 override is expressible as a `TokenSlotOverride` whose `token` is the Permit2 contract address and whose `amount` is the full **packed** slot value.
- `src/types.ts:116-120` — `PreparedAllowanceOverrides = { slots: AllowanceSlot[]; unresolved: AllowanceSlotPair[] }`; `AllowanceSlotPair = { token, spender }`. The new helper mirrors this shape.
- `src/txSimulator.ts:87-125` — the `tokenOverrides` namespace on the public interface; `forAllowances` (line 108) is the exemplar the new method sits beside. Bound defaults plumbing at lines 142-182.
- Canonical Permit2 address (same on all chains): `0x000000000022D473030F116dDEE9F6B43aC78BA3`. In canonical Permit2 source, `SignatureTransfer.nonceBitmap` occupies slot 0 and `AllowanceTransfer.allowance` slot 1 — but this plan does NOT hard-trust that: the base slot is confirmed by sentinel verification (Step 2), trying base 1 first, then 0–8.
- `contracts/test/Permit2Like.sol` exists but is an ERC-1271 fixture, NOT a storage-layout Permit2 clone — do not reuse it; Step 4 creates `MockPermit2.sol`.
- Existing conventions: preparers run per-item probes in `Promise.all` with deterministic result ordering (`slots.ts:32-48`); every override is sentinel-verified before being returned; failures land in `unresolved`, never throw.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Focused tests | `pnpm test -- test/requirements.test.ts test/simulate.test.ts` | all pass |
| Full gate | `pnpm verify` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `src/constants.ts` (new sentinel), `src/index.ts` (exports)
- `src/internal/slots.ts` (or a new `src/internal/permit2.ts` if slots.ts would exceed ~350 lines — executor's call, note it in the commit)
- `src/types.ts` (args/result types for the new helper)
- `src/txSimulator.ts` (wire `tokenOverrides.forPermit2Allowances`)
- `contracts/test/MockPermit2.sol` (create)
- `test/requirements.test.ts` or a new `test/permit2.test.ts` (new tests)
- `.changeset/<new-file>.md` (create)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `contracts/TxSimulator.sol` / `src/generated/` — **no contract change**. Permit2-allowance *measurement* inside `estimateRequirements` (an `allowance(owner,token,spender)` probe variant in the ghost) is explicitly deferred; this plan only makes Permit2-routed paths *simulatable* under forged approval.
- `src/internal/requirements.ts` — no estimator integration in this plan.
- `OVERRIDE_TOKEN_AMOUNT` and existing ERC-20 forging behavior.

## Design (decided — do not re-litigate)

- **Public surface**: `tokenOverrides.forPermit2Allowances(args)` where `args = SimulationOptions & { from: Address; pairs: readonly AllowanceSlotPair[]; permit2Address?: Address }` (default the canonical address). Returns `PreparedPermit2Overrides = { slots: TokenSlotOverride[]; pairs: AllowanceSlotPair[]; unresolved: AllowanceSlotPair[] }` where `slots[i]` corresponds to `pairs[i]`. In each override, `token` = **the Permit2 address** (the account whose storage is overridden — the pair's ERC-20 lives in `pairs[i].token`; a `TokenSlotOverride & AllowanceSlotPair` intersection would collide on the `token` field, which is why the arrays are parallel instead), `slot` = the composed packed slot, `amount` = the full packed value. Callers spread `slots` into `simulate({ tokenSlotOverrides })` unchanged — the existing pipeline currency.
- **New sentinel**: `OVERRIDE_PERMIT2_AMOUNT = 10n ** 45n` in `src/constants.ts`, docblock stating both constraints: must fit `uint160` (`10^45 < 2^160 − 1`) and must be non-max so Permit2's amount decrement stays observable. Export from the barrel next to `OVERRIDE_TOKEN_AMOUNT`.
- **Packed value**: `packed = (nonce << 208n) | (EXPIRATION_MAX << 160n) | OVERRIDE_PERMIT2_AMOUNT` with `EXPIRATION_MAX = 2n ** 48n - 1n` and `nonce` = the current on-chain nonce (preserved so `permit()` signatures still verify).
- **Per-pair flow** (all reads via `client.call`, debug-wrapped like every other RPC):
  1. Read `allowance(owner, token, spender)` on the Permit2 address → decode `(uint160 amount, uint48 expiration, uint48 nonce)`; failure → `unresolved`.
  2. For candidate base slots in order `[1n, 0n, 2n, 3n, ..., 8n]`: compose `slot = mappingSlot(spender, mappingSlot(token, mappingSlot(owner, base)))`, then verify by re-reading `allowance(...)` under `stateOverride: [{ address: permit2, stateDiff: [{ slot, value: uint256Hex(packedSentinel) }] }]` where `packedSentinel` uses the nonce read in (1). Accept the first base where the re-read returns `amount === OVERRIDE_PERMIT2_AMOUNT` **and** `nonce` unchanged; stop probing further bases.
  3. Verified → emit the `TokenSlotOverride`; no base verifies → `unresolved`.
  Cache the discovered base slot per Permit2 address within one invocation so N pairs cost 1 discovery + (N−1) single verifications (mirroring the ERC-20 inference structure at `slots.ts:88-126`).
- **Debug steps**: add `permit2AllowanceRead: "permit2Allowance.read"` and `permit2AllowanceVerify: "permit2Allowance.verify"` to `DEBUG_STEPS` (`src/internal/debugSteps.ts`) — additions to the vocabulary are allowed with plan authorization (this sentence is that authorization); never rename existing entries.

## Steps

### Step 1: Constants and types

Add `OVERRIDE_PERMIT2_AMOUNT` (+ docblock) to `src/constants.ts`, export from `src/index.ts`. Add `ForPermit2AllowancesArgs` and `PreparedPermit2Overrides` to `src/types.ts` mirroring the naming/JSDoc style of `PrepareAllowanceOverridesArgs`/`PreparedAllowanceOverrides` (`src/types.ts:116-120, 168-173`), including the "slots target the Permit2 contract's storage" warning.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Implementation

Implement the flow from Design in `src/internal/slots.ts` (or `src/internal/permit2.ts`). The Permit2 `allowance` getter ABI: `function allowance(address, address, address) view returns (uint160 amount, uint48 expiration, uint48 nonce)` — use viem `parseAbi` + `decodeFunctionResult` (do not reuse `readUint256Call`, which decodes a single word; a plain-word read would mask ABI mismatches the verification depends on). Route the eth_calls through `buildCallParameters` + `withRpcDebug` exactly like `readUint256Call` does (`src/internal/probes.ts:151-174`) with the new debug steps.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 3: Wire the public method

Add `forPermit2Allowances` to the `tokenOverrides` namespace in `src/txSimulator.ts` (interface JSDoc modeled on `forAllowances` at line 100-108; wiring with `defaults(args)` like line 172-173).

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: MockPermit2 fixture

Create `contracts/test/MockPermit2.sol` reproducing canonical Permit2's storage shape and decrement semantics (only what the tests need):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// Storage-layout-faithful slice of canonical Permit2's AllowanceTransfer:
/// slot 0 mirrors SignatureTransfer.nonceBitmap, so `allowance` lands at slot 1 like the real thing.
contract MockPermit2 {
    error AllowanceExpired();
    error InsufficientAllowance();

    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(uint256 => uint256)) public nonceBitmap; // slot 0 filler
    mapping(address => mapping(address => mapping(address => PackedAllowance))) public allowance; // slot 1

    function setNonce(address owner, address token, address spender, uint48 nonce) external {
        allowance[owner][token][spender].nonce = nonce;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        if (block.timestamp > allowed.expiration) revert AllowanceExpired();
        if (allowed.amount != type(uint160).max) {
            if (allowed.amount < amount) revert InsufficientAllowance();
            allowed.amount -= amount;
        }
        require(IERC20(token).transferFrom(from, to, amount), "pull failed");
    }
}
```

**Verify**: `pnpm build:contracts` → exit 0.

### Step 5: Tests

Anvil tests (new `test/permit2.test.ts`, harness modeled on `test/requirements.test.ts` setup):

1. **Forged Permit2 approval makes the path simulate**: deploy `TestToken` + `MockPermit2`; mint tokens to `from`; approve MockPermit2 from `from` on the ERC-20 (real approval via `write`, or forge it with `tokenOverrides.forAllowances` — either is fine, say which in the test name); do NOT set any Permit2-internal allowance. Prepare `forPermit2Allowances({ from, pairs: [{ token: testToken, spender: spenderContract }], permit2Address: mockPermit2 })` → expect 1 slot, 0 unresolved. Simulate a call where `spenderContract` (a small fixture or a direct `transferFrom` call encoded with `from` as msg.sender... simplest: `calls: [{ to: mockPermit2, data: transferFrom(from, recipient, X, testToken) }]` — the ghost at `from` is `msg.sender`, i.e. the spender, so use `pairs: [{ token: testToken, spender: from }]`) with the returned overrides in `tokenSlotOverrides` and a balance query on `testToken` for `from` → `status: "success"` and delta `-X`. Without the overrides, the same simulate must report `status: "reverted"` (control assertion in the same test).
2. **Nonce preservation**: `setNonce(from, testToken, from, 7)` via `write`; prepare overrides; re-read `allowance(from, testToken, from)` via `client.call` under the returned override applied as stateOverride → assert `amount === OVERRIDE_PERMIT2_AMOUNT`, `nonce === 7`, `expiration === 2^48 − 1`.
3. **Unresolved on a non-Permit2 target**: run `forPermit2Allowances` with `permit2Address` pointing at `TestToken` → the pair lands in `unresolved`, nothing throws.

**Verify**: `pnpm test -- test/permit2.test.ts` → all pass (3 tests, plus the in-test control).

### Step 6: Changeset and index

Minor changeset (`.changeset/permit2-allowance-overrides.md`):

```markdown
---
"viem-tx-sim": minor
---

Add `tokenOverrides.forPermit2Allowances`: sentinel-verified, nonce-preserving Permit2 internal-allowance overrides (new `OVERRIDE_PERMIT2_AMOUNT` sentinel, sized for Permit2's uint160 amount field), so Permit2-routed paths can be simulated under forged approvals.
```

Update this plan's row in `plans/README.md`.

**Verify**: `pnpm verify` → exit 0.

## Test plan

See Step 5: forged-approval simulation (with in-test negative control), nonce preservation under override, graceful `unresolved`. Plus: existing suite green unchanged (no RPC-count or debug-step changes on existing paths — the new debug steps fire only in the new helper).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "OVERRIDE_PERMIT2_AMOUNT" src/constants.ts src/index.ts` → declaration + export; value `10n ** 45n`
- [ ] `grep -n "forPermit2Allowances" src/txSimulator.ts` → interface + wiring
- [ ] `pnpm verify` exits 0; 3 new tests pass
- [ ] `git diff --stat contracts/TxSimulator.sol src/generated/` → empty (no contract change)
- [ ] Minor changeset present
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Sentinel verification never succeeds against `MockPermit2` at any base slot 0–8 (the packed-value math or the fixture layout is wrong — report the observed re-read values rather than widening the search).
- The `amount === MAX_UINT256` guard in `tokenSlotOverridesToStateDiff` rejects a legitimate packed value (it shouldn't — packed values with nonce < 2^48−1 or amount < 2^160−1 are below max — but if it fires, the composition is wrong).
- Implementing the helper appears to require a ghost-contract change (that is the explicitly deferred estimator half).
- `slots.ts` restructuring beyond adding the new code seems necessary.

## Maintenance notes

- **Deferred, deliberately**: Permit2-allowance *measurement* in `estimateRequirements` (requires an `allowance(owner,token,spender)` probe variant in the ghost + bytecode regen + checkpoint plumbing). If consumer demand appears, plan it separately; the checkpoint-grid stride math in `src/internal/checkpoints.ts` generalizes.
- The base-slot search order `[1, 0, 2..8]` is a determinism guarantee — keep it ordered, never parallel-race the verification reads (same reasoning as the rejected parallel slot verification in `plans/README.md`).
- Real-chain verification: once released, a `pnpm test:mainnet` case against canonical Permit2 + USDC + Universal Router would confirm the layout end-to-end; noted as a follow-up, not required here.
- Document next to `OVERRIDE_TOKEN_AMOUNT` that the two sentinels differ and why (uint160 packing) — done via the constants docblock in Step 1.
