# Plan 001: Collapse the public API to one simulation function

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: this repo has no `HEAD` commit at plan time. Run `git status --short -- README.md src/index.ts src/simulate.ts src/types.ts test/simulate.test.ts` and compare the "Current state" excerpts below against the live files before editing. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: initial uncommitted tree, 2026-07-01

## Why this matters

The package currently exposes `simulateCall` and `simulateCalls`, but `simulateCall` only wraps `simulateCalls` and duplicates every option. This is pre-prod, so compatibility is not a constraint. One function keeps the API smaller and prevents future options from being threaded through two public argument types.

## Current state

- `src/types.ts` defines both single-call and batch args:

```ts
export type SimulateCallArgs = {
  client: PublicClient;
  from: Address;
  to: Address;
  calldata: Hex;
  value?: bigint;
  blockNumber?: bigint;
  blockTag?: BlockTag;
  gas?: bigint;
  debug?: SimulationDebug;
};

export type SimulateCallsArgs = {
  client: PublicClient;
  from: Address;
  calls: readonly SimulatedCall[];
  blockNumber?: bigint;
  blockTag?: BlockTag;
  gas?: bigint;
  debug?: SimulationDebug;
};
```

- `src/simulate.ts` has a wrapper:

```ts
export async function simulateCall(args: SimulateCallArgs): Promise<SimulationResult> {
  const { client, from, to, calldata, value, blockNumber, blockTag, gas } = args;
  return simulateCalls({
    client,
    from,
    calls: [{ to, calldata, ...(value !== undefined ? { value } : {}) }],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
    ...(blockTag !== undefined ? { blockTag } : {}),
    ...(gas !== undefined ? { gas } : {}),
    ...(args.debug !== undefined ? { debug: args.debug } : {}),
  });
}
```

- `src/index.ts` exports both functions and both arg types:

```ts
export { simulateCall, simulateCalls } from './simulate.js';
export type {
  SimulateCallArgs,
  SimulateCallsArgs,
  SimulatedCall,
} from './types.js';
```

Repo conventions: TypeScript uses strict `NodeNext`, ESM imports with `.js` suffixes, and tests import from `../src/index.js`.

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
- `src/index.ts`
- `test/simulate.test.ts`
- `README.md`
- `plans/README.md`

**Out of scope**:
- `contracts/TxSimulator.sol`
- `src/internal/*` behavior, except type references needed by `src/simulate.ts`
- Simulation algorithm, retry behavior, debug logging semantics

## Git workflow

- Branch suggestion: `codex/001-collapse-public-entrypoint`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Replace the public argument types with one batch-first type

In `src/types.ts`, remove `SimulateCallArgs` and `SimulateCallsArgs`. Add one exported type:

```ts
export type SimulateArgs = {
  client: PublicClient;
  from: Address;
  calls: readonly SimulatedCall[];
  blockNumber?: bigint;
  blockTag?: BlockTag;
  gas?: bigint;
  debug?: SimulationDebug;
};
```

Keep `SimulatedCall`, `SimulationDebug*`, `AssetBalanceDelta`, and `SimulationResult`.

**Verify**: `rg -n "SimulateCallArgs|SimulateCallsArgs" src/types.ts` -> no matches.

### Step 2: Export only `simulate`

In `src/simulate.ts`, delete `simulateCall`. Rename `simulateCalls(args: SimulateCallsArgs)` to `simulate(args: SimulateArgs)`. Keep the empty-call guard, but update the message to `simulate requires at least one call.`.

Update imports in `src/simulate.ts` to use `SimulateArgs`. Any internal helper currently typed as `SimulateCallsArgs` should use `SimulateArgs`.

In `src/index.ts`, export only:

```ts
export { simulate } from './simulate.js';
```

and export `SimulateArgs` instead of the two old arg types.

**Verify**: `pnpm typecheck` -> expected errors only in tests/README consumers if those have not been updated yet; no syntax errors in `src`.

### Step 3: Update tests and README examples

In `test/simulate.test.ts`, replace imports and calls:

- `simulateCall({ client, from, to, calldata, value })` becomes `simulate({ client, from, calls: [{ to, calldata, value }] })`.
- `simulateCalls({ client, from, calls })` becomes `simulate({ client, from, calls })`.

In `README.md`, show:

```ts
import { simulate } from 'viem-tx-sim';

const result = await simulate({
  client,
  from,
  calls: [{ to, calldata, value: 0n }],
  debug: true,
});
```

**Verify**: `rg -n "simulateCall|simulateCalls|SimulateCallArgs|SimulateCallsArgs" README.md src test` -> no matches.

### Step 4: Run the full checks

Run:

```sh
pnpm typecheck
pnpm test
pnpm build
```

**Verify**: all three exit 0.

## Test plan

- Update existing tests only; no new behavior is being added.
- The existing tests in `test/simulate.test.ts` remain the coverage for one-call and batch simulations.
- At least one single-call test and one batch test must call the new `simulate` API.

## Done criteria

- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] `rg -n "simulateCall|simulateCalls|SimulateCallArgs|SimulateCallsArgs" README.md src test` returns no matches.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for plan 001 is updated.

## STOP conditions

Stop and report if:

- The current public API has already been changed away from the excerpts above.
- Removing `simulateCall` would require changing contract code or generated bytecode.
- `pnpm typecheck` reports errors unrelated to the API rename.

## Maintenance notes

Future public options should be added only to `SimulateArgs`. If a convenience single-call helper is wanted later, keep it out of the first stable API until real callers prove the need.
