# Plan 002: Remove redundant `requiredAllowance` from deltas

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: this repo has no `HEAD` commit at plan time. Run `git status --short -- README.md src/simulate.ts src/types.ts test/simulate.test.ts` and compare the "Current state" excerpts below against the live files before editing. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-collapse-public-entrypoint.md`
- **Category**: tech-debt
- **Planned at**: initial uncommitted tree, 2026-07-01

## Why this matters

`requiredAllowance` duplicates information already present in the negative token delta: if a spender is attributed, the required total allowance for this simulated spend is `-delta`. Keeping both fields creates an unnecessary invariant and another place for bugs. The simpler public shape is: asset, delta, optional spender, optional currentAllowance.

## Current state

- `src/types.ts` exposes redundant approval data on every delta:

```ts
export type AssetBalanceDelta = {
  asset: 'native' | Address;
  delta: bigint;
  /** Present for negative ERC-20 deltas when one spender can be isolated. */
  spender?: Address;
  /** Total allowance required for the spender to cover the observed token outflow. */
  requiredAllowance?: bigint;
  /** Allowance currently available before simulation. */
  currentAllowance?: bigint;
};
```

- `src/simulate.ts` stores and attaches the redundant field:

```ts
type ApprovalAttribution = {
  token: Address;
  spender: Address;
  requiredAllowance: bigint;
  currentAllowance: bigint;
};
```

```ts
attributions.push({
  token: slot.token,
  spender: slot.spender,
  requiredAllowance: amount,
  currentAllowance: slot.currentAllowance,
});
```

```ts
return {
  ...delta,
  spender: tokenAttributions[0]!.spender,
  requiredAllowance: tokenAttributions[0]!.requiredAllowance,
  currentAllowance: tokenAttributions[0]!.currentAllowance,
};
```

- `test/simulate.test.ts` asserts `requiredAllowance: 321n` in the allowance-gap test.
- `README.md` says the observed outflow is attached as `spender`, `requiredAllowance`, and `currentAllowance`.

Repo conventions: tests use direct object containment on `assetBalanceDeltas`; keep that style.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Tests | `pnpm test` | exit 0, all Vitest tests pass |
| Build | `pnpm build` | exit 0, Forge and TypeScript build pass |

## Scope

**In scope**:
- `src/types.ts`
- `src/simulate.ts`
- `test/simulate.test.ts`
- `README.md`
- `plans/README.md`

**Out of scope**:
- Changing how allowance slots are discovered.
- Changing the high-allowance retry amount.
- Adding a separate approvals array.
- Contract changes.

## Git workflow

- Branch suggestion: `codex/002-remove-required-allowance-field`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Remove the field from the public type

In `src/types.ts`, delete `requiredAllowance?: bigint` and its comment from `AssetBalanceDelta`.

**Verify**: `rg -n "requiredAllowance" src/types.ts` -> no matches.

### Step 2: Remove the field from attribution internals

In `src/simulate.ts`:

- Delete `requiredAllowance` from `ApprovalAttribution`.
- Keep the local `amount` calculation because it still decides whether the current allowance is insufficient.
- When pushing an attribution, store only `{ token, spender, currentAllowance }`.
- In `withSpenderAttribution`, attach only `spender` and `currentAllowance`.

Do not change the retry logic in this plan.

**Verify**: `pnpm typecheck` -> expected errors only where tests/README still mention `requiredAllowance`, if those have not been updated yet.

### Step 3: Update tests and README

In `test/simulate.test.ts`, update the allowance-gap expected delta to:

```ts
expect(result.assetBalanceDeltas).toContainEqual({
  asset: token.address,
  delta: -321n,
  spender: spender.address,
  currentAllowance: 0n,
});
```

If plan 001 has landed, use `simulate`; otherwise keep the live function name and do not reintroduce the old API.

In `README.md`, replace the sentence about `requiredAllowance` with: "When a high-allowance retry is needed, the negative ERC-20 delta may include `spender` and `currentAllowance`; the required allowance is the absolute value of that negative delta."

**Verify**: `rg -n "requiredAllowance" README.md src test` -> no matches.

### Step 4: Run the full checks

Run:

```sh
pnpm typecheck
pnpm test
pnpm build
```

**Verify**: all three exit 0.

## Test plan

- Update the existing "discovers allowance gaps from token outflow and attributes the spender" test.
- Keep the current assertion that batch approve-then-pull does not need an allowance-gap attribution; after this plan, assert no negative ERC-20 delta has `spender` for that batch case.

## Done criteria

- [ ] `rg -n "requiredAllowance" README.md src test` returns no matches.
- [ ] Allowance-gap test still proves `spender` and `currentAllowance` are attached.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for plan 002 is updated.

## STOP conditions

Stop and report if:

- `requiredAllowance` is already absent and the current API has a different approval shape.
- Removing the field requires changing the simulator contract ABI.
- Tests reveal a case where `-delta` is not the required total allowance for the attributed spender.

## Maintenance notes

Reviewers should check that no replacement approval array is added in this plan. The point is deletion: callers can compute `requiredAllowance = -delta.delta` when `delta.asset !== 'native'`, `delta.delta < 0n`, and `delta.spender` is present.
