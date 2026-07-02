# Plan 009: Stop in-batch permit/approve overwrites from corrupting discoverRequirements allowance amounts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7f94c6f..HEAD -- src/requirements.ts test/requirements.test.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the flagship measurement math; mitigated by exact-amount tests)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7f94c6f`, 2026-07-02

## Why this matters

`discoverRequirements()` measures required allowances by forging every
discovered allowance slot to a sentinel (10^50) and summing per-call
**decreases** of `allowance(owner, spender)`. Any batch call that *sets* the
allowance rather than decrementing it destroys the measurement: the overwrite
from 10^50 down to the set value is counted as a gigantic "decrease". The code
guards exactly one such case — a direct top-level `approve(address,uint256)`
call on the token — via selector decoding. It misses **ERC-2612
`permit(...)`**, which any batch can legitimately contain (permit is designed
to be submitted by anyone carrying the owner's signature) and which sets the
owner's allowance the same way. A `[permit, pull]` batch today reports a
required allowance of roughly 10^50 minus the permitted value — garbage that a
wallet would render to a user. There is additionally no test covering
measurement when a batch **reverts mid-way** (the contract's checkpoint
fill-forward path), which this plan also closes since it uses the same
fixtures.

Two-layer fix: (1) extend in-batch detection to `permit`; (2) add a
physical-invariant clamp as defense in depth — an allowance decrease that
funds a real `transferFrom` moves tokens out of the owner's balance, so a
pair's measured requirement can never exceed that token's measured gross
outflow (`maxTokenOutflows`); anything above it is overwrite corruption and
must be discarded.

## Current state

All in `src/requirements.ts` (at `7f94c6f`).

The ledger rule — sums decreases per probe row before the first detected
in-batch approve (`src/requirements.ts:246-270`):

```ts
function requiredAllowances(
  calls: readonly SimulatedCall[],
  probes: readonly AllowanceProbe[],
  checkpoints: readonly bigint[],
): DiscoveredRequirements["allowances"] {
  const allowances: DiscoveredRequirements["allowances"] = [];
  const stride = calls.length + 1;

  for (let probeIndex = 0; probeIndex < probes.length; ++probeIndex) {
    const probe = probes[probeIndex];
    if (probe === undefined) continue;

    const firstApproveIndex = firstInBatchApproveIndex(calls, probe);
    const limit = firstApproveIndex ?? calls.length;
    let amount = 0n;
    for (let callIndex = 0; callIndex < limit; ++callIndex) {
      const before = checkpoints[probeIndex * stride + callIndex] ?? 0n;
      const after = checkpoints[probeIndex * stride + callIndex + 1] ?? 0n;
      if (before > after) amount += before - after;
    }
    if (amount > 0n) allowances.push({ token: probe.token, spender: probe.spender, amount });
  }

  return allowances;
}
```

Detection only decodes `approve` from viem's `erc20Abi`
(`src/requirements.ts:272-293`):

```ts
function firstInBatchApproveIndex(
  calls: readonly SimulatedCall[],
  probe: AllowanceProbe,
): number | undefined {
  for (let i = 0; i < calls.length; ++i) {
    const call = calls[i];
    if (call === undefined || addressKey(call.to) !== addressKey(probe.token)) continue;
    if (isApproveForSpender(call.calldata, probe.spender)) return i;
  }
  return undefined;
}

function isApproveForSpender(calldata: Hex, spender: Address): boolean {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata });
    return (
      decoded.functionName === "approve" && addressKey(decoded.args[0]) === addressKey(spender)
    );
  } catch {
    return false;
  }
}
```

The caller assembles the result at `src/requirements.ts:93-110`;
`measurement.probeData.maxTokenOutflows` (parallel to
`measurement.probeData.candidates`) is already in scope there and feeds
`requiredBalances(...)` — the clamp needs the same two arrays passed into
`requiredAllowances`.

Why only `approve`/`permit` matter: `allowance[owner][spender]` on the token
can only be changed by a call where the owner authorizes it — a top-level
`approve` (the simulator IS the owner, so `msg.sender` is the owner only for
top-level calls to the token) or a `permit` carrying the owner's signature
(submittable by anyone, including nested inside another contract's call — the
top-level-call scan does NOT catch a router-relayed permit, which is exactly
why the clamp layer exists). `increaseAllowance` produces an increase, which
the ledger already ignores.

The ERC-2612 permit signature to decode:
`permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)`
— selector `0xd505accf`; the probe-relevant check is `args[1]` (spender), and
`args[0]` should equal the simulated owner for it to affect this probe.

Contract-side context for the revert tests (do not modify the contract): on a
failing call `i`, `TxSimulator.sol` breaks out and fills every remaining
checkpoint offset with the value recorded at offset `i`
(`contracts/TxSimulator.sol:145-163` and `_fillRemainingCheckpoints` at
`:195-207`), so decreases after the failure point contribute zero. The TS
side reports `status: "reverted"` with `failingCallIndex`.

Existing test conventions: `test/requirements.test.ts` — anvil per test
(`startAnvil`), local `deploy` helper, exact-amount assertions like
`toContainEqual({ token, spender, amount: 100n })`. Test contracts live in
`contracts/test/` (e.g. `Spender.sol` pulls via `transferFrom`;
`RevertingTarget.sol` reverts on any call). `TestToken.sol` is a plain
mintable ERC-20 **without permit** — a permit-capable test token must be
added.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Build contracts + TS | `pnpm build` | exit 0 (needs `forge`) |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | all pass (needs `anvil`) |
| One file | `pnpm build:contracts && pnpm exec vitest run test/requirements.test.ts` | all pass |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):

- `src/requirements.ts`
- `contracts/test/PermitToken.sol` (create — test fixture only)
- `test/requirements.test.ts`
- `README.md` (one caveat sentence in "Discovering requirements")
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `contracts/TxSimulator.sol`, `src/generated/` — the measurement contract is
  correct; this is a TS-side interpretation bug. (`pnpm test` rebuilds
  contracts; the new test fixture compiles alongside without touching the
  simulator.)
- `src/internal/*`, `src/simulate.ts`, `src/slots.ts`, `src/types.ts` — the
  public types don't change.
- Permit2's *internal* allowance system — out of scope entirely; this plan is
  about token-level ERC-2612 permit.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend in-batch detection to ERC-2612 permit

In `src/requirements.ts`:

1. Add a module-level ABI next to the imports (viem's `erc20Abi` lacks permit):

```ts
const allowanceSettingAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);
```

   (import `parseAbi` from viem; the existing `erc20Abi` import becomes unused
   by `isApproveForSpender` — remove it if nothing else uses it.)
2. Rename `isApproveForSpender` → `isAllowanceSetForSpender(calldata, owner, spender)`
   and decode against `allowanceSettingAbi`: return true for `approve` when
   `args[0]` matches the spender, and for `permit` when `args[1]` matches the
   spender AND `args[0]` matches the owner. Keep the try/catch-false shape.
3. Thread `owner` (the `from` address) through `firstInBatchApproveIndex` —
   rename to `firstInBatchAllowanceSetIndex` — and from `requiredAllowances`'
   caller. Keep the "first index wins" semantics unchanged.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Add the gross-outflow clamp

1. Pass `measurement.probeData.candidates` and
   `measurement.probeData.maxTokenOutflows` into `requiredAllowances` (they're
   already used two lines up for `requiredBalances`).
2. Inside the probe loop, compute the token's gross outflow: find the probe
   token's index in `candidates` (compare via `addressKey`) and read
   `maxTokenOutflows[index] ?? 0n`.
3. After summing `amount`: if `amount > outflow`, the excess can only come
   from an undetected allowance overwrite (a real `transferFrom` moves tokens,
   so legitimate decreases are bounded by outflow) — **discard the pair**
   (`continue`) rather than clamping to `outflow`, because an overwrite makes
   the whole measurement for that pair untrustworthy, and a nested permit
   normally means the batch self-provisions (true requirement ≈ 0). Keep the
   existing `amount > 0n` emit condition for the untainted case.

**Verify**: `pnpm typecheck` → exit 0;
`grep -n "maxTokenOutflows" src/requirements.ts` → appears in both
`requiredBalances` and `requiredAllowances` call sites.

### Step 3: Add the permit-capable test token

Create `contracts/test/PermitToken.sol`: a minimal ERC-20 (mirror
`TestToken.sol`'s style — mintable, standard mappings) plus a **simplified**
permit for testing the measurement path only:

```solidity
function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
    external
{
    // Test fixture: accept without signature verification; measurement only
    // cares that the allowance is overwritten mid-batch.
    deadline; v; r; s;
    allowance[owner][spender] = value;
}
```

Real signature verification is deliberately absent — the fixture exercises the
allowance-overwrite data flow, not cryptography. Match the repo's Solidity
style (0.8.24, explicit selectors not needed here).

**Verify**: `pnpm build:contracts` → exit 0.

### Step 4: New tests in `test/requirements.test.ts`

Follow the file's existing patterns (deploy helper, exact amounts). Add:

1. **`[permit, pull]` reports no bogus allowance requirement**: PermitToken,
   `Spender`; mint 1_000n to the owner; batch =
   `[token.permit(owner, spender, 400n, 0, 0, 0x0, 0x0), spender.pull(token, 400n)]`.
   Expect: `status === "success"`, `balances` contains `{ token, amount: 400n }`,
   and `allowances` contains **no** entry for `(token, spender)` (detection
   stops the ledger at the permit; this mirrors the existing
   "does not require allowance when the batch approves before pulling" test).
2. **Nested overwrite is caught by the clamp**: deploy a tiny wrapper contract
   OR simpler — call `permit` for a spender pair where the permit is emitted
   from a helper contract so it is NOT a top-level token call. If writing a
   wrapper contract is needed, add `contracts/test/PermitRelayer.sol` with
   `relay(token, owner, spender, value)` that calls `token.permit(...)`
   (extend the in-scope list accordingly and note it in your report). Batch =
   `[relayer.relay(token, owner, spender, 400n), spender.pull(token, 400n)]`.
   Expect: no allowance entry with an absurd amount — specifically, every
   reported allowance amount for that token is `<= 400n` (the pull amount);
   with the discard rule the pair should be absent entirely.
3. **Reverted mid-batch measurement**: TestToken + `Spender` +
   `RevertingTarget`; mint; batch =
   `[spender.pull(token, 100n), revertingTarget.<any calldata>]`. Expect:
   `status === "reverted"`, `failingCallIndex === 1`, `allowances` contains
   `{ token, spender, amount: 100n }` and `balances` contains
   `{ token, amount: 100n }` — the executed prefix is still measured, and the
   contract's checkpoint fill-forward contributes nothing after the failure.

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/requirements.test.ts`
→ all pass, including 3 new tests. Then `pnpm test` → full suite passes.

### Step 5: README caveat

In README's "Discovering requirements (optional)" paragraph, replace the
existing caveat sentence tail with one that also covers this: amounts are
measured under forged state and should be padded; pairs whose allowance is set
inside the batch (approve or permit) are excluded from requirements; measured
allowance decreases are sanity-bounded by the token's gross outflow.

**Verify**: `pnpm lint` → exit 0.

## Test plan

Covered in Step 4 (three new anvil tests, exact amounts, modeled on the
existing approve-before-pull test). Plus the full suite as regression:
`pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0
- [ ] `grep -n "permit" src/requirements.ts` → detection ABI includes permit
- [ ] `grep -n "maxTokenOutflows" src/requirements.ts` → used by the allowance path (not only balances)
- [ ] `test/requirements.test.ts` contains the three new tests (permit, nested/relayed overwrite, reverted mid-batch) and they pass
- [ ] `git status --porcelain` shows changes only to in-scope files (plus `PermitRelayer.sol` if step 4.2 needed it, noted in the report)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The clamp (step 2) makes any *existing* test fail — that would mean a
  legitimate measurement exceeds gross outflow, i.e. the invariant is wrong;
  report the failing case rather than weakening the clamp.
- The reverted-mid-batch test shows the contract fill-forward misbehaving
  (nonzero decreases attributed after `failingCallIndex`) — that is a
  contract bug, out of scope here; report it.
- Fixing this appears to require modifying `contracts/TxSimulator.sol`.

## Maintenance notes

- The detection list is deliberately small (approve + ERC-2612 permit). DAI's
  non-standard permit and other exotics fall through to the clamp layer,
  which discards rather than mis-reports — acceptable degradation. If a
  discarded-pair signal is ever needed in the API, add a field rather than
  guessing amounts.
- Reviewer should scrutinize: the owner-match on permit `args[0]` (a permit
  for a *different* owner must NOT stop the ledger), and that the clamp uses
  the measurement sim's own `candidates` ordering for outflow lookup.
- Deferred: Permit2's internal allowance ledger is a separate storage system
  and untouched by this plan.
