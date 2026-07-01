# Plan 003: Remove public diagnostics from simulation results

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in "STOP conditions" occurs, stop and report; do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: this repo has no `HEAD` commit at plan time. Run `git status --short -- src/types.ts src/index.ts src/simulate.ts src/internal/simulator.ts test/simulate.test.ts README.md` and compare the "Current state" excerpts below against the live files before editing. On mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-collapse-public-entrypoint.md`, `plans/002-remove-required-allowance-field.md`
- **Category**: tech-debt
- **Planned at**: initial uncommitted tree, 2026-07-01

## Why this matters

`diagnostics` exposes candidate discovery and override internals as required public API. The user-visible result should be status, deltas, revert details, and optional spender attribution. RPC-call visibility already exists through debug events, so mandatory diagnostics can be deleted instead of stabilized.

## Current state

- `src/types.ts` makes diagnostics mandatory:

```ts
export type SimulationDiagnostics = {
  candidateAddresses: Address[];
  candidateTokens: Address[];
  usedBalanceOverrides: Address[];
  usedAllowanceOverrides: {
    token: Address;
    spender: Address;
  }[];
  warnings: string[];
};

export type SimulationResult = {
  status: 'success' | 'reverted';
  assetBalanceDeltas: AssetBalanceDelta[];
  revertData?: Hex;
  revertReason?: string;
  failingCallIndex?: number;
  diagnostics: SimulationDiagnostics;
};
```

- `src/internal/simulator.ts` constructs empty diagnostics even though it mainly returns simulator results:

```ts
diagnostics: {
  candidateAddresses: [],
  candidateTokens: uniqueAddresses(result.observedTokens),
  usedBalanceOverrides: [],
  usedAllowanceOverrides: [],
  warnings: [],
},
observedTokens: uniqueAddresses(result.observedTokens),
```

- `src/simulate.ts` carries diagnostics through orchestration:

```ts
const base = await runWithDiagnostics(args, calls, candidateAddresses, [], [], []);
```

```ts
result.diagnostics = mergeDiagnostics(result.diagnostics, {
  candidateAddresses: [...candidateAddresses],
  candidateTokens: result.observedTokens,
  usedBalanceOverrides: [...usedBalanceOverrides],
  usedAllowanceOverrides: [...usedAllowanceOverrides],
  warnings: [],
});
```

```ts
withAllowances.diagnostics.warnings.push('Simulation still reverted after verified balance and allowance overrides.');
```

- `test/simulate.test.ts` asserts `result.diagnostics.candidateTokens` and `result.diagnostics.usedBalanceOverrides`.

Repo conventions: debug logging is structured through `SimulationDebugEvent` and tested in `test/simulate.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, no TypeScript errors |
| Tests | `pnpm test` | exit 0, all Vitest tests pass |
| Build | `pnpm build` | exit 0, Forge and TypeScript build pass |

## Scope

**In scope**:
- `src/types.ts`
- `src/index.ts`
- `src/simulate.ts`
- `src/internal/simulator.ts`
- `test/simulate.test.ts`
- `README.md`
- `plans/README.md`

**Out of scope**:
- Removing or weakening `debug` events.
- Changing candidate discovery, balance overrides, allowance overrides, or simulator bytecode.
- Adding a replacement diagnostics option.
- Contract changes.

## Git workflow

- Branch suggestion: `codex/003-remove-public-diagnostics`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Remove diagnostics from public types and exports

In `src/types.ts`, delete `SimulationDiagnostics` and remove `diagnostics` from `SimulationResult`.

In `src/index.ts`, stop exporting `SimulationDiagnostics`.

**Verify**: `rg -n "SimulationDiagnostics|diagnostics:" src/types.ts src/index.ts` -> no matches.

### Step 2: Remove internal diagnostics plumbing

In `src/internal/simulator.ts`, stop returning the `diagnostics` object. `InternalSimulationResult` should still include `observedTokens` for retry logic.

In `src/simulate.ts`:

- Remove the `SimulationDiagnostics` import.
- Rename `runWithDiagnostics` to a smaller helper such as `run` or inline calls to `runSimulator`.
- Remove `usedBalanceOverrides` and `usedAllowanceOverrides` parameters from that helper.
- Remove `mergeDiagnostics` and `uniqueAllowanceOverrides`.
- Remove warning pushes. If a simulation still reverts after retries, return the reverted `SimulationResult` without a warning.
- Keep `observedTokens`, candidate discovery, balance-slot discovery, allowance-slot discovery, and spender attribution behavior.

**Verify**: `rg -n "diagnostics|usedBalanceOverrides|usedAllowanceOverrides|warnings|mergeDiagnostics|uniqueAllowanceOverrides" src` -> no matches, except comments in plan files are irrelevant because this command is scoped to `src`.

### Step 3: Update tests and README

In `test/simulate.test.ts`, delete assertions that inspect `result.diagnostics`.

Keep behavior assertions:

- ERC-20 delta tests should still assert the token delta.
- Balance override tests should still assert success and the expected negative token delta.
- Debug test should still assert `eth_createAccessList` and `eth_call` debug events.

In `README.md`, do not document diagnostics as public result data. If setup examples mention only debug logging, leave them.

**Verify**: `rg -n "diagnostics|candidateTokens|usedBalanceOverrides|usedAllowanceOverrides" README.md test src` -> no matches.

### Step 4: Run the full checks

Run:

```sh
pnpm typecheck
pnpm test
pnpm build
```

**Verify**: all three exit 0.

## Test plan

- No new tests are needed; this is API deletion.
- Preserve the existing debug-events test because it is now the supported way to inspect RPC-call activity.
- Existing integration tests must still cover native deltas, ERC-20 deltas, balance retry, batch state, Permit2/ERC-1271, proxy storage-slot verification, and unresolved reverts.

## Done criteria

- [ ] `SimulationResult` no longer includes `diagnostics`.
- [ ] `SimulationDiagnostics` is no longer exported.
- [ ] `rg -n "diagnostics|candidateTokens|usedBalanceOverrides|usedAllowanceOverrides" README.md src test` returns no matches.
- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm build` exits 0.
- [ ] No files outside the in-scope list are modified.
- [ ] `plans/README.md` status row for plan 003 is updated.

## STOP conditions

Stop and report if:

- A test can only prove balance retry or token discovery by reading diagnostics. In that case, propose the smallest behavioral assertion instead of adding new diagnostics.
- Removing diagnostics requires changing `TxSimulator.sol`.
- A public consumer has been added in the repo that depends on diagnostics.

## Maintenance notes

If users later need diagnostics for UI/debugging, prefer adding an opt-in debug callback event over making internals part of every `SimulationResult`.
