# Plan 004: Cut allowance attribution re-simulation

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: this repo has no `HEAD` commit at plan time. Run `git status --short -- src/simulate.ts test/simulate.test.ts README.md` and compare the "Current state" excerpts below against the live files before editing. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/001-collapse-public-entrypoint.md`, `plans/002-remove-required-allowance-field.md`, `plans/003-remove-public-diagnostics.md`
- **Category**: perf
- **Planned at**: initial uncommitted tree, 2026-07-01

## Why this matters

The current allowance attribution path does one extra simulator `eth_call` for each discovered allowance slot. That makes the worst case scale with token-spender pairs, just to decide which spender to label on a negative token delta. The cheaper version is to use the successful high-allowance retry result: if exactly one allowance slot for a token was below the observed outflow, attach that spender; otherwise leave the delta unattributed.

## Current state

- `src/simulate.ts` performs a successful high-allowance retry, then calls `inferApprovalAttributions`:

```ts
const withAllowances = await runWithDiagnostics(
  args,
  calls,
  candidateAddresses,
  highOverrides,
  balanceSlots.map((slot) => slot.token),
  allowanceSlots.map((slot) => ({ token: slot.token, spender: slot.spender })),
);
```

```ts
const approvalAttribution = await inferApprovalAttributions({
  args,
  calls,
  candidateAddresses,
  balanceOverrides,
  balanceSlots,
  allowanceSlots,
  successTemplate: withAllowances,
});
withAllowances.assetBalanceDeltas = withSpenderAttribution(withAllowances.assetBalanceDeltas, approvalAttribution.attributions);
```

- `inferApprovalAttributions` loops over every allowance slot and re-runs the simulator:

```ts
for (const slot of input.allowanceSlots) {
  const amount = inferTokenOutflow(input.successTemplate, slot.token);
  if (amount === undefined || amount <= slot.currentAllowance) continue;

  const otherHighAllowances = input.allowanceSlots
    .filter((other) => other !== slot)
    .map((other) => storageOverride(other.token, other.slot, OVERRIDE_TOKEN_AMOUNT));
  const currentOverrides = [
    ...input.balanceOverrides,
    ...otherHighAllowances,
    storageOverride(slot.token, slot.slot, slot.currentAllowance),
  ];
  const withCurrent = await runWithDiagnostics(/* ... */);

  if (withCurrent.status === 'success') continue;

  attributions.push({ /* ... */ });
}
```

- After plans 001-003, names may be different: `simulateCalls` may be `simulate`, `requiredAllowance` may be gone, and `diagnostics` may be gone. Match live code, but preserve this plan's behavior goal.

Repo conventions: use `addressKey` for address comparison, keep local helpers in `src/simulate.ts`, and prefer simple loops over new abstractions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Tests | `pnpm test` | exit 0, all Vitest tests pass |
| Build | `pnpm build` | exit 0, Forge and TypeScript build pass |

## Scope

**In scope**:
- `src/simulate.ts`
- `test/simulate.test.ts`
- `README.md`
- `plans/README.md`

**Out of scope**:
- `contracts/TxSimulator.sol`
- `src/internal/probes.ts`
- Changing the high allowance value `10^50`
- Reintroducing `approvalsRequired` or `requiredAllowance`
- Adding centralized APIs, traces, token lists, or indexers

## Git workflow

- Branch suggestion: `codex/004-cut-allowance-attribution-resimulation`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Replace re-simulation attribution with direct attribution

In `src/simulate.ts`, remove `inferApprovalAttributions` and `tokensWithMultipleApprovalAttributions`.

Add a small synchronous helper near `withSpenderAttribution`, for example:

```ts
function inferApprovalAttributionsFromDeltas(
  result: InternalSimulationResult,
  allowanceSlots: readonly AllowanceSlot[],
): ApprovalAttribution[] {
  const attributions: ApprovalAttribution[] = [];
  for (const delta of result.assetBalanceDeltas) {
    if (delta.asset === 'native' || delta.delta >= 0n) continue;
    const outflow = -delta.delta;
    const matches = allowanceSlots.filter(
      (slot) => addressKey(slot.token) === addressKey(delta.asset) && slot.currentAllowance < outflow,
    );
    if (matches.length === 1) {
      attributions.push({
        token: matches[0]!.token,
        spender: matches[0]!.spender,
        currentAllowance: matches[0]!.currentAllowance,
      });
    }
  }
  return attributions;
}
```

If plan 002 has not landed, STOP; do not preserve `requiredAllowance` in this new helper.

**Verify**: `rg -n "inferApprovalAttributions\\(|withCurrent|otherHighAllowances|tokensWithMultipleApprovalAttributions" src/simulate.ts` -> no matches.

### Step 2: Wire the helper after the successful high-allowance retry

Replace the async attribution call with:

```ts
withAllowances.assetBalanceDeltas = withSpenderAttribution(
  withAllowances.assetBalanceDeltas,
  inferApprovalAttributionsFromDeltas(withAllowances, allowanceSlots),
);
return publicResult(withAllowances);
```

If plan 003 has landed, no warnings are needed. If diagnostics still exist, STOP instead of adding new warning behavior.

**Verify**: `pnpm typecheck` -> exit 0.

### Step 3: Add one regression check for RPC count shape

In `test/simulate.test.ts`, update the allowance-gap test or add a small adjacent test that passes a debug callback and runs the allowance-gap scenario.

Assert:

- the result is `success`
- the negative token delta includes the isolated `spender` and `currentAllowance`
- debug events for `step === 'txSimulator.simulate'` are not more than 3

This allows the normal base attempt, balance retry if needed, and high-allowance retry, but catches the removed per-slot attribution re-simulation.

Use the existing debug-events test as the style pattern.

**Verify**: `pnpm test -- test/simulate.test.ts` -> exit 0.

### Step 4: Run the full checks

Run:

```sh
pnpm typecheck
pnpm test
pnpm build
```

**Verify**: all three exit 0.

## Test plan

- Add or update exactly one test around the allowance-gap scenario.
- Do not add broad RPC-count assertions for every test; they will be brittle.
- Existing allowance, balance retry, batch, Permit2, proxy, and revert tests must still pass.

## Done criteria

- [ ] `rg -n "inferApprovalAttributions\\(|withCurrent|otherHighAllowances|tokensWithMultipleApprovalAttributions" src/simulate.ts` returns no matches.
- [ ] Allowance-gap test still proves spender attribution.
- [ ] Allowance-gap debug test proves no more than 3 `txSimulator.simulate` calls.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for plan 004 is updated.

## STOP conditions

Stop and report if:

- Plan 002 has not removed `requiredAllowance`.
- Plan 003 has not removed public diagnostics.
- Direct attribution cannot preserve the existing single-spender allowance-gap test.
- Fixing tests requires modifying `TxSimulator.sol` or probe discovery.

## Maintenance notes

This deliberately accepts ambiguity: multiple possible spender slots for one token means no spender label. If callers later need exact multi-spender attribution, add an explicit output shape and tests first; do not bring back hidden N-extra simulator calls.
