# Plan 024: Decode Solidity custom errors in revert results (optional errorAbi, selector fallback)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 82a79a1..HEAD -- src test README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (additive result fields + one decoder rewrite; existing revert formatting must not change)
- **Depends on**: none (016-023 all DONE)
- **Category**: dx
- **Planned at**: commit `82a79a1`, 2026-07-03

## Why this matters

Custom errors have been the default Solidity revert style since ~0.8.4, and
the library cannot say anything about them. `decodeRevertReason`
(`src/internal/revert.ts`) hardcodes exactly two selectors —
`Error(string)` and `Panic(uint256)` — so a modern protocol revert like
`InsufficientBalance(uint256,uint256)` produces `revertReason: undefined`.
The raw bytes ARE guaranteed (`revertData` is required on the reverted
variants since plan 018), but asking every wallet to slice hex is poor DX
for the most common revert shape.

Maintainer-specified design (2026-07-03):

1. **Optional `errorAbi`** — accepted both bound at `TxSimulator.create()`
   (app-wide known protocol errors) and per-call, merged. A flat ABI, not
   per-target: the revert can originate anywhere in the call stack (a nested
   token, not the batch's `to`). Decoding uses viem's `decodeErrorResult`,
   which already handles `Error`/`Panic` as built-ins and decodes any custom
   error present in the supplied ABI — no hand-maintained selector tables.
2. **Selector fallback** — even without an ABI, an undecodable revert
   reports its 4-byte selector in a new structured field, so a wallet can
   display "reverted with `0x82b42900`" and a developer can look it up.
   `revertReason` keeps its meaning (human-readable decoded string only);
   the selector does NOT get smuggled into it.

## Current state

(All at `82a79a1`.)

### The decoder — `src/internal/revert.ts` (complete file, 21 lines)

```ts
import type { Hex } from "viem";
import { decodeAbiParameters, hexToNumber, slice } from "viem";

export function decodeRevertReason(data: Hex | undefined): string | undefined {
  if (!data || data === "0x") return undefined;

  try {
    const selector = slice(data, 0, 4);
    if (selector === "0x08c379a0") {
      const [reason] = decodeAbiParameters([{ type: "string" }], slice(data, 4));
      return reason;
    }
    if (selector === "0x4e487b71") {
      return `Panic(${hexToNumber(slice(data, 4))})`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
```

Sole call site: `src/internal/simulator.ts:141` inside `runSimulator`'s
reverted branch —

```ts
const revertReason = decodeRevertReason(result.revertData);
// ...
...(revertReason !== undefined ? { revertReason } : {}),
```

### Result types — `src/types.ts`

`SimulationReverted` has required `revertData: Hex`, optional
`revertReason?: string` ("Present when revertData decodes as a standard
Error(string)/Panic"), required `failingCallIndex: number`.
`DiscoveredRequirementsReverted` mirrors it. Both gain the new fields.

### Where args flow — post-023 layout

- `src/txSimulator.ts`: `create(bound: TxSimulatorConfig)` builds a
  `defaults(args)` merge for `gas`/`debug` (per-call wins) and calls the
  implementations with `{ ...args, ...defaults(args), client: bound.client }`.
  `runSimulate(args: SimulateArgs & ClientArgs)` is a module-private
  function in this file; it calls `runSimulator` (internal).
- `src/requirements.ts`: `discoverRequirements(args: DiscoverRequirementsArgs & ClientArgs)`
  calls `runSimulator` twice (recon + measurement); the measurement result's
  revert fields flow into `DiscoveredRequirementsReverted`.
- `src/types.ts` has `TxSimulatorConfig = { client; gas?; debug? }` and a
  shared `SimulationOptions` base used by arg types. **Placement rule**: add
  `errorAbi` to `SimulateArgs` and `DiscoverRequirementsArgs` individually —
  NOT to `SimulationOptions` if that base is shared with the slot-discovery
  arg types (slot discovery never produces revert results; check the live
  file and keep it off those args).
- Slot-discovery methods do not decode reverts — out of this plan entirely.

### viem facts the executor relies on

`decodeErrorResult({ abi, data })` (import from `viem`): returns
`{ abiItem, errorName, args }`; throws on an unknown selector; handles
`Error(string)` and `Panic(uint256)` even when `abi` is empty/omitted
(built-in solidity errors). Verify this built-in behavior with a quick unit
assertion in Step 2's tests — if a viem version quirk means built-ins are
NOT handled, keep the two existing hardcoded branches ahead of the
`decodeErrorResult` attempt and note it.

### Existing tests touching reverts

`test/simulate.test.ts:377` asserts `revertData` defined on a reverted
result; the compile-time narrowing check at `:412` reads `revertData`. No
test asserts a specific `revertReason` string today, but preserve current
formatting anyway: `Error(string)` → the bare message; `Panic` →
`Panic(<n>)`.

## Target design

### `src/internal/revert.ts` — rewrite

```ts
import type { Abi, Hex } from "viem";
import { decodeErrorResult, slice, size } from "viem";

export type DecodedRevert = {
  revertReason?: string;
  revertError?: { name: string; args: readonly unknown[] };
  revertSelector?: Hex;
};

export function decodeRevert(data: Hex | undefined, errorAbi?: Abi): DecodedRevert {
  if (!data || data === "0x") return {};
  const revertSelector = size(data) >= 4 ? slice(data, 0, 4) : undefined;
  try {
    const decoded = decodeErrorResult({ abi: errorAbi ?? [], data });
    return {
      revertReason: formatReason(decoded),   // Error -> message; Panic -> `Panic(n)`; custom -> `Name(arg, ...)`
      revertError: { name: decoded.errorName, args: decoded.args ?? [] },
      ...(revertSelector !== undefined ? { revertSelector } : {}),
    };
  } catch {
    return revertSelector !== undefined ? { revertSelector } : {};
  }
}
```

`formatReason`: `errorName === "Error"` → `String(args[0])` (bare message,
current behavior); `errorName === "Panic"` → `` `Panic(${args[0]})` ``
(current behavior); otherwise `` `Name(arg1, arg2)` `` with bigint-safe
stringification (`String(v)` per arg is sufficient; no JSON.stringify —
bigints throw).

Delete `decodeRevertReason`.

### Types (`src/types.ts`)

- New exported type:

```ts
/** ABI-decoded revert error, present when revertData matches `errorAbi` or a built-in Error/Panic. */
export type RevertError = { name: string; args: readonly unknown[] };
```

- `SimulationReverted` and `DiscoveredRequirementsReverted` each gain:

```ts
/** Decoded error when revertData matches `errorAbi` or built-in Error/Panic. */
revertError?: RevertError;
/** First 4 bytes of revertData; present whenever revertData carries a selector. */
revertSelector?: Hex;
```

  Update `revertReason`'s JSDoc: "Human-readable decoded revert; present
  when revertData decodes via `errorAbi` or as built-in Error/Panic."
- `TxSimulatorConfig` gains
  `/** Error definitions used to decode custom-error reverts; merged with per-call errorAbi. */ errorAbi?: Abi;`
- `SimulateArgs` and `DiscoverRequirementsArgs` gain
  `/** Additional error definitions for decoding this call's reverts; merged after the bound errorAbi. */ errorAbi?: Abi;`
- Export `RevertError` from `src/index.ts`. (`Abi` comes from viem — no
  re-export.)

### Threading

- `runSimulator` (`src/internal/simulator.ts`) gains `errorAbi?: Abi` in its
  args; the reverted branch calls `decodeRevert(result.revertData, args.errorAbi)`
  and spreads all three optional fields with the existing
  conditional-spread idiom.
- `runSimulate` (`src/txSimulator.ts`) and `discoverRequirements`
  (`src/requirements.ts`) pass `errorAbi` through (both `runSimulator` calls
  in requirements get it; only the measurement result's fields surface, as
  today).
- `create()` merge: extend `defaults(args)` (or a sibling) so the effective
  per-call value is `[...(bound.errorAbi ?? []), ...(args.errorAbi ?? [])]`,
  passed only when non-empty (avoid introducing `errorAbi: []` where it was
  absent — match the existing conditional-spread style). Per-call entries
  come AFTER bound ones; note that viem's decode takes the first matching
  ABI item, so duplicate selectors resolve to the bound definition — fine,
  they'd decode identically.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (lint, typecheck, build, test; needs forge/anvil) |
| Focused | `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts` | all pass |

## Scope

**In scope**: `src/internal/revert.ts`, `src/internal/simulator.ts`,
`src/types.ts`, `src/txSimulator.ts`, `src/requirements.ts`,
`src/index.ts`, `contracts/test/CustomErrorTarget.sol` (create — test
fixture only), `test/simulate.test.ts`, `README.md` (short subsection),
`plans/README.md` (status row). `dist/` via `pnpm build` only.

**Out of scope**: `contracts/TxSimulator.sol` (revert bytes already pass
through unchanged — no contract work); slot-discovery args/results
(`errorAbi` does not belong on them); `src/errors.ts` (typed *library*
errors are unrelated to *simulated transaction* reverts); probes'
swallow-errors contract.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Rewrite the decoder

Implement `decodeRevert` + `formatReason` per Target design in
`src/internal/revert.ts`; delete `decodeRevertReason`.

**Verify**: `pnpm typecheck` → fails only at the old call site in
`simulator.ts` (expected).

### Step 2: Types + threading

Apply the Types section; thread `errorAbi` per the Threading section
(simulator → runSimulate/requirements → create merge).

**Verify**: `pnpm typecheck` → exit 0;
`grep -n "decodeRevertReason" src/` → no matches;
`grep -c "errorAbi" src/txSimulator.ts src/requirements.ts src/internal/simulator.ts` → ≥1 each.

### Step 3: Fixture + tests

`contracts/test/CustomErrorTarget.sol` (match existing fixture style,
0.8.24):

```solidity
error Unauthorized();
error InsufficientBalance(uint256 have, uint256 want);

contract CustomErrorTarget {
    function failPlain() external pure { revert Unauthorized(); }
    function failWithArgs(uint256 have, uint256 want) external pure {
        revert InsufficientBalance(have, want);
    }
}
```

New tests in `test/simulate.test.ts` (existing deploy helper + instance
style):

1. **decoded with per-call ABI**: simulate a call to `failWithArgs(1, 2)`
   passing `errorAbi: parseAbi(["error InsufficientBalance(uint256 have, uint256 want)"])`
   → status reverted; `revertError` equals
   `{ name: "InsufficientBalance", args: [1n, 2n] }`;
   `revertReason === "InsufficientBalance(1, 2)"`; `revertSelector` defined.
2. **selector-only without ABI**: same call, no `errorAbi` →
   `revertError` undefined, `revertReason` undefined, `revertSelector`
   equals the first 4 bytes of `revertData` (compute via `slice`, don't
   hardcode).
3. **bound ABI + per-call merge**: `TxSimulator.create({ client, errorAbi: <Unauthorized def> })`;
   call `failPlain()` with NO per-call abi → decoded
   `{ name: "Unauthorized", args: [] }`; then call `failWithArgs` with the
   per-call `InsufficientBalance` def → decoded (proves merge keeps both).
4. **built-ins still work**: the existing `RevertingTarget` revert test
   stays green; extend it (or add one assertion) that an `Error(string)`
   revert yields the bare message in `revertReason` AND
   `revertError.name === "Error"` — this also pins viem's built-in handling
   (the Step "viem facts" verification).

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts`
→ all pass including 3-4 new tests.

### Step 4: Docs + full gate

README: add 3-5 lines (in or near "Debugging", or a small "Decoding
reverts" subsection): reverts return raw `revertData` and a `revertSelector`
always; pass `errorAbi` (bound on `create` or per call) to decode custom
errors into `revertError`/`revertReason`. One compact example line.

**Verify**: `pnpm verify` → exit 0;
`grep -n "errorAbi" README.md` → ≥1.

## Test plan

Step 3's four cases: ABI-decoded with args, selector-only fallback,
bound/per-call merge, built-in Error regression. Pattern: existing
revert test in `test/simulate.test.ts`.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `grep -rn "decodeRevertReason" src/` → no matches; `decodeRevert` used by `simulator.ts`
- [ ] `RevertError` exported from package root; `SimulationReverted` has `revertError?`/`revertSelector?`
- [ ] `TxSimulatorConfig`, `SimulateArgs`, `DiscoverRequirementsArgs` accept `errorAbi`; slot-discovery args do NOT (`grep -n "errorAbi" src/types.ts` shows exactly those three)
- [ ] Four new/extended tests passing; existing assertions untouched
- [ ] `plans/README.md` status row updated

## STOP conditions

- viem's `decodeErrorResult` does NOT handle built-in Error/Panic with an
  empty ABI (Step 3 test 4 fails) AND restoring the two hardcoded branches
  ahead of it doesn't restore behavior — report the viem version and
  observed behavior.
- Any existing test assertion needs changing beyond the deliberate
  extension in test 4.
- Threading `errorAbi` seems to require touching slot-discovery signatures
  — it doesn't belong there; report what pushed you that way.

## Maintenance notes

- `revertReason` is for humans, `revertError` for programs, `revertSelector`
  for diagnostics — keep that separation when extending; never put raw
  selectors into `revertReason`.
- If per-target ABIs are ever wanted (decode differently per call), that's
  a new feature — the flat merge is deliberate because reverts bubble from
  nested contracts.
- The bound `errorAbi` lives in `create()`'s closure alongside the future
  slot cache (deferred finding) — both are instance-level configuration.
