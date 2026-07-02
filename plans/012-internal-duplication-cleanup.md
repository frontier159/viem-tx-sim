# Plan 012: Consolidate duplicated internals (call building, slot discovery, block-option threading, dead members)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7f94c6f..HEAD -- src`
> Plans 009 and 011 are expected to land before this one and touch
> `src/requirements.ts` / `src/internal/simulator.ts`. That is anticipated
> drift: re-locate the excerpts below by symbol name rather than line number.
> STOP only if a named symbol no longer exists.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW-MED (wide mechanical refactor; fully covered by existing suite)
- **Depends on**: plans/009, plans/011 (same files — land them first to avoid conflicts)
- **Category**: tech-debt
- **Planned at**: commit `7f94c6f`, 2026-07-02

## Why this matters

Three growth spurts (plans 001–007) left the internals with parallel
implementations of the same plumbing: two `buildCallParameters` with subtly
different optional-handling, a private re-implementation of the public
`discoverBalanceSlots`, hand-rolled block-option threading in two competing
styles across ~13 call sites, and a few dead/over-exported members. None is a
bug today; together they are how the next bug happens (fix one copy, miss the
other). One consolidation pass while the suite is green and exhaustive.

## Current state

(All at `7f94c6f`; symbols may have moved slightly after plans 009/011.)

1. **`buildCallParameters` twice**: `src/internal/simulator.ts:163-184`
   (stateOverride required, no conditional spread for it) and
   `src/internal/probes.ts:237-258` (stateOverride optional, conditional
   spread). Identical block-number/tag ternary in both:

```ts
return (
  args.blockNumber !== undefined
    ? { ...base, blockNumber: args.blockNumber }
    : { ...base, ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}) }
) satisfies CallParameters;
```

2. **Private duplicate of public slot discovery**: `src/requirements.ts:113-137`
   defines a private `discoverBalanceSlots` (arg named `from`, `gas`
   required) that loops `discoverBalanceSlot` exactly as the public
   `discoverBalanceSlots` in `src/slots.ts:9-35` does (arg named `owner`,
   `gas` optional).
3. **Two block-option threading styles**: `src/simulate.ts:26-27,49-50` and
   `src/slots.ts:28-29,61-62` use conditional spreads
   (`...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {})`),
   while `src/requirements.ts` passes `blockNumber: args.blockNumber`
   directly (possibly-undefined property). Both typecheck today; they diverge
   if `exactOptionalPropertyTypes` is ever enabled.
4. **Dead union member**: `src/types.ts:11` —
   `method: "eth_call" | "eth_createAccessList" | "eth_getCode"`; grep shows
   no `eth_getCode` event is ever emitted anywhere in `src/` or `test/`.
5. **Over-wide exports**: `src/internal/simulator.ts:20` exports `ProbeData`
   (no other module imports the *type* — `requirements.ts` only reads the
   `probeData` property); `src/internal/probes.ts:11` exports `readBalanceOf`
   (used only within `probes.ts`; `readAllowance` IS imported by
   `requirements.ts` and must stay exported).

Conventions: ESM `.js` specifiers; internals in `src/internal/`; public types
in `src/types.ts`; `BlockOptions` type lives in `src/internal/rpc.ts:8-11`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint/format | `pnpm lint` / `pnpm lint:fix` | exit 0 |
| Tests | `pnpm test` | all pass (needs anvil/forge) |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:

- `src/internal/simulator.ts`, `src/internal/probes.ts`,
  `src/internal/rpc.ts` (new helper's home), `src/requirements.ts`,
  `src/simulate.ts`, `src/slots.ts`, `src/types.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/index.ts` public export list — the public API surface must not change.
- `contracts/`, `src/generated/`, all of `test/` — this refactor must be
  invisible to every existing test (that's the point).
- Debug step names and RPC call counts — tests pin them.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: One `blockOptionsSpread` helper

In `src/internal/rpc.ts` (next to `BlockOptions`), add:

```ts
export function blockOptionsSpread(args: BlockOptions): BlockOptions {
  return args.blockNumber !== undefined
    ? { blockNumber: args.blockNumber }
    : args.blockTag !== undefined
      ? { blockTag: args.blockTag }
      : {};
}
```

Replace every hand-rolled conditional spread AND every direct
possibly-undefined pass-through of blockNumber/blockTag with
`...blockOptionsSpread(args)` — in `src/simulate.ts`, `src/slots.ts`,
`src/requirements.ts`, and inside both `buildCallParameters` ternaries (which
Step 2 merges anyway). Semantics note: blockNumber wins over blockTag when
both are set — identical to today's ternary.

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "blockNumber !== undefined" src/ | grep -v rpc.ts` → no matches.

### Step 2: One `buildCallParameters`

Move a single implementation into `src/internal/rpc.ts` (exported), with
`stateOverride` optional and conditionally spread (the probes variant is the
general case; the simulator call site always passes one, which still
satisfies the optional signature):

```ts
export function buildCallParameters(
  args: {
    account: Address;
    to: Address;
    data: Hex;
    gas?: bigint;
    stateOverride?: StateOverride;
  } & BlockOptions,
): CallParameters { /* base + conditional spreads + blockOptionsSpread */ }
```

Delete both local copies; import from `rpc.js` in `simulator.ts` and
`probes.ts`.

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "function buildCallParameters" src/` → exactly one match, in
`src/internal/rpc.ts`. `pnpm test` → all pass.

### Step 3: Delete the private `discoverBalanceSlots` in requirements.ts

Replace the private function (and its call at the `balanceSlots = await ...`
site) with the public `discoverBalanceSlots` from `./slots.js`, mapping the
arg names (`owner: args.from`, pass `tokens` and `gas` through). Confirm the
public version's behavior is identical: same sentinel
(`OVERRIDE_TOKEN_AMOUNT`), same omit-on-undefined.

**Verify**: `pnpm typecheck` → exit 0;
`grep -c "discoverBalanceSlot(" src/requirements.ts` → 0 (only the plural
public call remains). `pnpm test` → all pass, including requirements tests'
probe-count assertions (call counts are unchanged by this swap).

### Step 4: Dead/over-wide members

1. `src/types.ts`: remove `| "eth_getCode"` from
   `SimulationDebugEvent["method"]`.
2. `src/internal/simulator.ts`: remove `export` from `ProbeData` (keep the
   type; `SimulatorResult` still references it and remains exported).
3. `src/internal/probes.ts`: remove `export` from `readBalanceOf` (keep
   `readAllowance` exported — `requirements.ts` imports it).

**Verify**: `pnpm typecheck` → exit 0 (any error here means a usage the greps
missed — restore that specific export and note it). `pnpm build` → exit 0.

### Step 5: Full gate

**Verify**: `pnpm lint:fix && pnpm verify` (or `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
if plan 008 hasn't landed) → all green.

## Test plan

No new tests — the deliverable is that ALL existing tests pass unchanged,
including the debug-event count assertions in `test/requirements.test.ts`
(they pin RPC call counts, which this refactor must not alter).

## Done criteria

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` all exit 0
- [ ] `grep -rn "function buildCallParameters" src/` → 1 match (rpc.ts)
- [ ] `grep -rn "blockNumber !== undefined" src/ | grep -v rpc.ts` → no matches
- [ ] `grep -n "eth_getCode" src/` → no matches
- [ ] `git diff --stat -- test/` → empty (no test file touched)
- [ ] Public exports unchanged: `git diff -- src/index.ts` → empty
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any existing test fails after a step — revert that step's change and
  report; do not adjust tests to fit.
- Unexporting a member in Step 4 breaks compilation somewhere greps missed —
  restore that one export, note it, continue.
- `src/index.ts` would need to change — the public surface is frozen here.

## Maintenance notes

- After this, adding a new optional call parameter means touching one
  function (`buildCallParameters`) instead of two.
- Deferred deliberately: replacing the `as unknown`/manual-tuple cast on
  `decodeFunctionResult` in `simulator.ts` with viem's inferred typing — it's
  behind a `parseAbi` const so inference *may* work, but plan 011 wraps that
  code in error handling first; investigate in a later pass, not this
  mechanical one.
