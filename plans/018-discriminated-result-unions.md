# Plan 018: Make SimulationResult and DiscoveredRequirements discriminated unions on `status`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0031a..HEAD -- src/types.ts src/internal/simulator.ts src/requirements.ts test README.md`
> Plans 016 (renames) and 017 (allowance discovery) are expected DONE first —
> check `plans/README.md`; treat their renames/moves as anticipated drift and
> locate excerpts by symbol name.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (breaking type shape; pre-prod, no compatibility required)
- **Depends on**: plans/016 (names); land before plans/019 (which extends the same types)
- **Category**: dx
- **Planned at**: commit `ed0031a`, 2026-07-02

## Why this matters

Both public result types model reverts with optional fields:

```ts
// src/types.ts:81-87
export type SimulationResult = {
  status: "success" | "reverted";
  assetBalanceDeltas: AssetBalanceDelta[];
  revertData?: Hex;
  revertReason?: string;
  failingCallIndex?: number;
};
```

The implementation *guarantees* more than the type says: when
`status === "reverted"`, `revertData` is always set (bytes from the contract,
possibly `"0x"`) and `failingCallIndex` is always a number (the contract
records the failing index whenever a call fails); when `status === "success"`
all three are always `undefined`. But TypeScript can't see that:
`if (result.status === "reverted")` leaves `revertData` as `Hex | undefined`,
forcing consumers into `!` assertions or redundant guards. A discriminated
union makes the compiler enforce what the code already promises. Same story
for `DiscoveredRequirements` (`src/types.ts:62-74`).

## Current state

### Guarantee evidence — `src/internal/simulator.ts` (~lines 140-160)

```ts
const status = result.success ? "success" : "reverted";
const failingCallIndex =
  result.failingCallIndex === (1n << 256n) - 1n ? undefined : Number(result.failingCallIndex);
const revertData = status === "reverted" ? result.revertData : undefined;

return {
  status,
  assetBalanceDeltas,
  revertData,
  revertReason: revertData === undefined ? undefined : decodeRevertReason(revertData),
  failingCallIndex,
  probeData: { ... },
};
```

Contract side (`contracts/TxSimulator.sol`, `_executeCalls`): `success=false`
always sets `failingCallIndex = i` before breaking, and
`failingCallIndex = type(uint256).max` only when success — so
`reverted ⟹ failingCallIndex` is a real number. `revertData` is whatever the
failing call returned (may be empty bytes, still defined).
`revertReason` stays optional in the reverted variant (decode can fail).

### `DiscoveredRequirements` assembly — `src/requirements.ts` (~lines 103-123)

Spreads `measurement.revertData/revertReason/failingCallIndex` into the
result unconditionally (undefined on success).

### Consumers in-repo

`test/simulate.test.ts` ("returns unresolved transaction reverts instead of
throwing") reads `result.revertData` and `result.failingCallIndex` after
asserting `status === "reverted"` — works unchanged under the union.
README's Getting-started text mentions `status: "reverted"` prose only.

## Target shape

In `src/types.ts`:

```ts
export type SimulationSuccess = {
  status: "success";
  assetBalanceDeltas: AssetBalanceDelta[];
};

export type SimulationReverted = {
  status: "reverted";
  assetBalanceDeltas: AssetBalanceDelta[];
  revertData: Hex;
  /** Present when revertData decodes as a standard Error(string)/Panic. */
  revertReason?: string;
  failingCallIndex: number;
};

export type SimulationResult = SimulationSuccess | SimulationReverted;
```

`DiscoveredRequirements` analogously: a shared base
(`native`, `balances`, `allowances`, `slots`) intersected with
`{ status: "success" } | { status: "reverted"; revertData: Hex; revertReason?: string; failingCallIndex: number }`.
Export the variant type names (`SimulationSuccess`, `SimulationReverted`) —
consumers will want them for function signatures.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |

## Scope

**In scope**: `src/types.ts`, `src/index.ts` (export new variant type
names), `src/internal/simulator.ts` (construct the variant explicitly),
`src/requirements.ts` (same), `test/simulate.test.ts` +
`test/requirements.test.ts` (narrowing adjustments + one new compile-time
check), `README.md` (one sentence), `plans/README.md` (status row). `dist/`
via build.

**Out of scope**: `contracts/**`; `src/errors.ts`; runtime behavior of any
kind — this is a types + construction-site change; `AssetBalanceDelta`
(explicitly rejected as a union in the 2026-07-02 audit — do not touch).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Rewrite the types

Apply the Target shape in `src/types.ts`; export `SimulationSuccess`,
`SimulationReverted` (and the two `DiscoveredRequirements` variants, e.g.
`DiscoveredRequirementsSuccess/Reverted`) from `src/index.ts`.

**Verify**: `pnpm typecheck` → fails only inside `simulator.ts` /
`requirements.ts` construction sites (expected; next steps).

### Step 2: Construct variants explicitly in `runSimulator`

Replace the single return object with an explicit branch:

```ts
if (!result.success) {
  return {
    status: "reverted",
    assetBalanceDeltas,
    revertData: result.revertData,
    ...(reason !== undefined ? { revertReason: reason } : {}),
    failingCallIndex: Number(result.failingCallIndex),
    probeData,
  };
}
return { status: "success", assetBalanceDeltas, probeData };
```

(`SimulatorResult` remains `SimulationResult & { probeData: ProbeData }` —
the intersection distributes over the union correctly.) Note the
`(1n << 256n) - 1n` sentinel check becomes unnecessary in the reverted
branch (contract guarantees a real index on failure) — keep a defensive
`Number()` conversion only.

**Verify**: `pnpm typecheck` → errors remaining only in `requirements.ts`.

### Step 3: Construct variants in `discoverRequirements`

Branch on `measurement.status` and build the matching variant, spreading the
shared fields (`native`, `balances`, `allowances`, `slots`).

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Tests

1. Fix any narrowing fallout in existing tests (should be none or trivial —
   they assert status first).
2. Add a compile-time narrowing check (type-level, zero runtime) at the
   bottom of `test/simulate.test.ts`:

```ts
function _narrowingCheck(result: SimulationResult): Hex | "ok" {
  if (result.status === "reverted") return result.revertData; // Hex, no assertion
  return "ok";
}
```

   (Prefix `_` and reference it via `void _narrowingCheck` if the linter
   flags unused symbols.)
3. Extend the existing revert test to assert
   `typeof result.failingCallIndex === "number"` inside the narrowed branch
   without any `!`.

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass;
`grep -n "revertData!" src/ test/` → no matches.

### Step 5: README + full gate

Adjust the Getting-started sentence ("A revert is returned as
`status: "reverted"` with the revert data, never thrown") to mention the
narrowing: checking `status` gives typed access to `revertData` /
`failingCallIndex`.

**Verify**: `pnpm verify` → exit 0.

## Test plan

Existing suite (behavioral no-op) + the compile-time narrowing check + the
strengthened revert assertions. The typecheck itself is the main gate.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `src/types.ts` has no optional `revertData` — `grep -n "revertData?" src/types.ts` → no matches
- [ ] `SimulationSuccess`/`SimulationReverted` exported from the package root
- [ ] Narrowing check present in tests; no `!` assertions on revert fields anywhere (`grep -rn "revertData!\|failingCallIndex!" src test` → none)
- [ ] `plans/README.md` status row updated

## STOP conditions

- You find a real code path where `status === "reverted"` but the contract
  did NOT provide `revertData`/`failingCallIndex` — the guarantee this plan
  encodes would be false; report the path instead of widening the type back.
- Plan 019 landed first and already reshaped these types — reconcile with its
  changes rather than overwriting.

## Maintenance notes

- Any future result field must be placed deliberately in the shared base or
  one variant — the union makes that choice visible in review.
- Plan 019 (unresolved-discovery reporting) adds fields to
  `DiscoveredRequirements`' shared base; it depends on this plan's shape.
