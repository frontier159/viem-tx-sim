# Plan 040: Guard the hand-written simulator ABI against silent drift from the compiled contract

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop,
> revert the code changes, mark this plan BLOCKED with what you found, and
> report — do not adapt the implementation to make the guard pass. When
> done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8931d7e..HEAD -- src/internal/simulator.ts contracts/TxSimulator.sol test/helpers/artifacts.ts`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW — additive test only; no production code changes.
- **Depends on**: none
- **Category**: tech-debt (lockstep guard)
- **Planned at**: commit `8931d7e`, 2026-07-10

## Why this matters

The ghost contract's result shape exists in three hand-maintained copies
that nothing verifies against each other: the Solidity struct
(`contracts/TxSimulator.sol:28-38`), the `parseAbi` string in
`src/internal/simulator.ts:60-67`, and the fixture-defaults struct type in
`test/helpers/fakeClient.ts:33-43`. A field added, renamed, or reordered in
one place but not the others surfaces only as a runtime decode failure
wrapped in `StateOverrideUnsupportedError` — which reads as "your RPC is
broken", not "the ABI drifted". Plan 038 performed exactly this multi-file
lockstep edit by hand three days ago; the next such edit gets a machine
check. The forge artifact (`out/TxSimulator.sol/TxSimulator.json`) already
contains the authoritative ABI and a test helper already parses artifacts —
one fixture-style test closes the gap.

Per ADR-0001's scope note (`docs/adr/0001-debug-step-literals-in-tests.md`),
this is a *mirror guard*, not a pin: the artifact ABI is ground truth
produced by the compiler, and the test keeps the hand-written mirror in
lockstep with it.

## Current state

- `src/internal/simulator.ts:59-67` — the hand-written ABI:

```ts
/** @internal Also imported by test helpers to encode node-shaped simulator returndata. */
export const txSimulatorAbi = parseAbi([
  "struct SimulatedCall { address to; uint256 value; bytes data; }",
  "struct AllowanceProbe { address token; address spender; }",
  "struct BalanceProbe { address token; address account; }",
  "struct SimulationResult { bool success; uint256 failingCallIndex; bytes revertData; address[] observedTokens; uint256[] maxTokenOutflows; uint256 maxNativeOutflow; uint256[] allowanceCheckpoints; uint256[] balanceCheckpoints; bool[] balanceProbeOk; }",
  "function simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes, BalanceProbe[] balanceProbes) returns (SimulationResult)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
```

- `test/helpers/artifacts.ts` — existing artifact loader (use it as-is):

```ts
export function artifact(contractFile: string, contractName: string): ContractArtifact {
  const path = resolve("out", contractFile, `${contractName}.json`);
  ...
  return { abi: json.abi, bytecode: ... };
}
```

- The forge artifact's ABI entries carry `internalType` fields on every
  input/output/component (e.g.
  `{"name":"calls","type":"tuple[]","internalType":"struct TxSimulator.SimulatedCall[]","components":[...]}`),
  which viem's `parseAbi` output does not have. A comparison must strip
  `internalType` recursively from the artifact side.
- The artifact ABI also contains entries `txSimulatorAbi` deliberately omits
  (`onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`,
  `receive`). The guard asserts the **subset direction**: every function in
  `txSimulatorAbi` must match its artifact counterpart exactly.
- Precedent for chain-free fixture tests on internal modules:
  `test/checkpoints.test.ts` (fixture arrays in, results out, no Anvil).
- `pnpm test` runs `pnpm build:contracts && vitest run`, so `out/` always
  exists when tests run.

## Commands you will need

| Purpose         | Command                                | Expected on success |
|-----------------|----------------------------------------|---------------------|
| Install         | `pnpm install`                         | exit 0              |
| Build contracts | `pnpm build:contracts`                 | exit 0; `out/TxSimulator.sol/TxSimulator.json` exists |
| Typecheck       | `pnpm typecheck`                       | exit 0              |
| One suite       | `pnpm exec vitest run test/abi.test.ts`| all pass            |
| Full gate       | `pnpm verify`                          | exit 0              |

## Scope

**In scope**:
- `test/abi.test.ts` (create)

**Out of scope** (do NOT touch):
- `src/internal/simulator.ts`, `contracts/TxSimulator.sol`,
  `src/generated/txSimulatorBytecode.ts` — if the guard reveals a mismatch,
  that is a STOP condition, not something to fix here.
- `scripts/generate-txsim-bytecode.mjs` — generating the ABI into
  `src/generated/` was considered and rejected for this plan (heavier
  change touching the generated-file policy); the guard test suffices.
- `test/helpers/fakeClient.ts` — its `SimulationResultStruct` is indirectly
  guarded because `encodeSimulationResult` encodes through `txSimulatorAbi`,
  which this test verifies.

## Git workflow

- Branch: `plan-040-abi-drift-guard`
- One commit; message style matches `git log` (e.g. "Guard txSimulatorAbi
  against forge artifact drift (plan 040)").
- No changeset (test-only; no published behavior change).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the guard test

Create `test/abi.test.ts` (no Anvil; model file structure on
`test/checkpoints.test.ts`):

```ts
import { describe, expect, it } from "vitest";

import { txSimulatorAbi } from "../src/internal/simulator.js";
import { artifact } from "./helpers/artifacts.js";

/** Strips forge-only `internalType` annotations so shapes compare against parseAbi output. */
function stripInternalType(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalType);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "internalType")
        .map(([key, entry]) => [key, stripInternalType(entry)]),
    );
  }
  return value;
}

describe("txSimulatorAbi drift guard", () => {
  it("matches the compiled TxSimulator artifact for every declared function", () => {
    const compiled = artifact("TxSimulator.sol", "TxSimulator").abi;
    const declaredFunctions = txSimulatorAbi.filter((entry) => entry.type === "function");
    expect(declaredFunctions.length).toBeGreaterThan(0);

    for (const declared of declaredFunctions) {
      const counterpart = compiled.find(
        (entry) => entry.type === "function" && entry.name === declared.name,
      );
      expect(counterpart, `function ${declared.name} missing from artifact`).toBeDefined();
      expect(stripInternalType(counterpart)).toEqual(JSON.parse(JSON.stringify(declared)));
    }
  });
});
```

Adjust the normalization only if the first run shows a systematic
representational difference that is NOT a real signature difference (e.g.
absent-vs-empty `outputs` arrays, or `stateMutability` present on one side
only). Any difference in a field **name, type, order, or component tree**
is real drift → STOP condition.

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/abi.test.ts` → 1 test, passes.

### Step 2: Prove the guard bites

Temporarily rename one field inside the `SimulationResult` struct line of
`txSimulatorAbi` in `src/internal/simulator.ts` (e.g. `balanceProbeOk` →
`balanceProbeOkX`), run the suite, confirm the new test FAILS, then revert
the edit (`git checkout -- src/internal/simulator.ts`).

**Verify**: test fails with the mutation, passes after revert; `git status` shows only `test/abi.test.ts` added.

### Step 3: Full gate

**Verify**: `pnpm verify` → exit 0.

## Test plan

- One new test file, `test/abi.test.ts`, one test: subset-compare
  `txSimulatorAbi` functions against the forge artifact ABI with
  `internalType` stripped.
- Negative check performed manually in Step 2 (not committed).
- Verification: `pnpm verify` → exit 0, including the new test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `test/abi.test.ts` exists and `pnpm exec vitest run test/abi.test.ts` passes
- [ ] Step 2's mutation check was performed and the test failed under mutation (state this in your completion note)
- [ ] `pnpm verify` exits 0
- [ ] `git status` shows only `test/abi.test.ts` (plus `plans/README.md`) changed
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The guard reveals a REAL mismatch between `txSimulatorAbi` and the
  compiled artifact (field name/type/order/components) — that is a live bug,
  not a normalization issue; report the exact diff.
- `txSimulatorAbi`'s shape or location changed since `8931d7e`.
- You find yourself needing to modify anything under `src/` to make the
  test pass.

## Maintenance notes

- Future contract changes (like plan 038) now fail this test until the
  `parseAbi` string is updated in lockstep — that is the point; update the
  string, never weaken the normalization.
- If the repo later decides to generate the ABI into `src/generated/`
  alongside the bytecode, this test becomes redundant and can be deleted in
  the same change.
- Reviewer: check the normalization strips ONLY `internalType` — anything
  more aggressive quietly weakens the guard.
