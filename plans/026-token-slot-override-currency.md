# Plan 026: Make TokenSlotOverride the explicit currency of the discovery→simulate pipeline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9b598c5..HEAD -- src test README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S-M
- **Risk**: MED (public type-shape change; discovery outputs gain a field, so some object-equality test expectations legitimately change — amounts and RPC counts stay frozen)
- **Depends on**: none (001-025 all DONE)
- **Category**: dx
- **Planned at**: commit `9b598c5`, 2026-07-03

## Why this matters

Three maintainer findings (2026-07-03) about the discovery→simulate wiring:

1. **The pipeline works by structural coincidence, not declaration.** The
   three discover methods return three different slot element types
   (`BalanceSlot {token, slot}`, `AllowanceSlot {token, spender, slot}`,
   `TokenSlotOverride[]` from requirements), and feeding
   `simulate({ tokenSlotOverrides })` relies on the reader noticing they
   happen to be assignable. Nothing in the interface says "this output is
   that input."
2. **Optional `amount` hides an instruction inside a behavior.** Overrides
   silently default to 10^50 deep in the simulator. Decision: `amount`
   becomes **required**, discovery populates it with
   `OVERRIDE_TOKEN_AMOUNT`, and a handcrafted `amount === maxUint256`
   throws — max is a real footgun twice over (standard ERC-20s skip the
   allowance decrement at exactly max, blinding `discoverRequirements`
   measurement; a max *balance* makes any incoming transfer revert on
   checked overflow, diverging from reality).
3. **`unresolved` docs don't land.** "Was not forged" confused the
   maintainer into thinking rebasing-token *deltas* are lost (they aren't —
   deltas come from `balanceOf` before/after calls, which work for stETH;
   only conjuring hypothetical state fails). Reframe the docs in Foundry
   `deal` vocabulary — the failing operation is exactly forge-std's
   `deal(token, account, amount)`. (NOT `prank`/`impersonate`: sender
   spoofing is what code injection already does, and it never fails.)

## Current state

(All at `9b598c5` — the post-025 tree: public `src/{index,txSimulator,types,errors,constants}.ts`, internal `src/internal/{data,probes,requirements,rpc,simulator,slots}.ts`.)

### The three slot types — `src/types.ts` (locate by name)

```ts
/** Verified ERC-20 balance mapping slot for one token and owner. */
export type BalanceSlot = { token: Address; slot: Hex };

/** Verified ERC-20 allowance mapping slot for one token, owner, and spender. */
export type AllowanceSlot = { token: Address; spender: Address; slot: Hex };

/** Storage slot value to forge before running a simulation. */
export type TokenSlotOverride = {
  token: Address;
  slot: Hex;
  /** Value written to the slot before simulating. Defaults to `OVERRIDE_TOKEN_AMOUNT`. */
  amount?: bigint;
};
```

`BalanceSlotDiscovery.slots: BalanceSlot[]`,
`AllowanceSlotDiscovery.slots: AllowanceSlot[]`,
`DiscoveredRequirements`' base has `slots: TokenSlotOverride[]` and the
three-list `unresolved` (`balanceSlots`, `allowanceSlots`, `allowances`).
`unresolved` field JSDoc currently uses the "was not forged" phrasing.

### Where the default and the shapes flow

- `src/internal/simulator.ts` — post-025 simplification A: `runSimulator`
  accepts `tokenSlotOverrides` and applies
  `uint256Hex(o.amount ?? OVERRIDE_TOKEN_AMOUNT)` when building the viem
  `StateOverride`. That `??` fallback becomes dead once `amount` is
  required; the max-guard goes here (the single choke point both
  `runSimulate` and `internal/requirements.ts` pass through).
- `src/internal/slots.ts` — discovery orchestration returns
  `{slots, unresolved}` with fact-shaped elements (no `amount`).
- `src/internal/probes.ts` — `discoverBalanceSlot`/`discoverAllowanceSlot`
  return `BalanceSlot | undefined` / `AllowanceSlot | undefined`; these are
  internal *facts* and should NOT carry `amount` (keep probes fact-level;
  `slots.ts` attaches the amount).
- `src/internal/requirements.ts` — builds its public `slots` via a
  `tokenSlotOverride(...)`-style mapper stripping to `{token, slot}`; with
  discovery outputs conforming by construction this mapper should be
  deletable (plain concat).
- `src/internal/data.ts` — `MAX_UINT256 = (1n << 256n) - 1n` and
  `uint256Hex` (throws `RangeError` for values ABOVE max, so `=== max` is
  the only reachable footgun to guard).
- `src/errors.ts` — `InvalidSimulationInputError` is the established class
  for caller-input problems.
- `src/index.ts` — exports `BalanceSlot`, `AllowanceSlot`,
  `TokenSlotOverride` (among others); `BalanceSlot` export is removed by
  this plan.

### Tests that will see the shape change

Tests assert discovery outputs with `toContainEqual` (deep equality — an
added `amount` field on actual objects makes old expectations fail). Those
expectations are LEGITIMATE updates: add `amount: OVERRIDE_TOKEN_AMOUNT` to
the expected objects (import the constant from `../src/index.js`). Every
numeric amount, delta, and RPC-count assertion stays byte-identical.
Affected files: `test/simulate.test.ts` (slot-discovery and fast-path
assertions), `test/txSimulator.test.ts` (discovery-method test),
`test/requirements.test.ts` (only if any assertion inspects `slots` — check).

## Target design

```ts
/**
 * Storage-slot override — the unit that flows from the discovery methods into
 * `simulate({ tokenSlotOverrides })`. Discovery populates `amount` with
 * OVERRIDE_TOKEN_AMOUNT: huge, but deliberately below uint256 max so ERC-20
 * allowance decrements stay observable and incoming transfers cannot overflow.
 */
export type TokenSlotOverride = {
  token: Address;
  slot: Hex;
  /** Value written to the slot. Must be below uint256 max (exactly max throws — see docs). */
  amount: bigint;
};

/** A discovered allowance slot: a TokenSlotOverride plus the spender it belongs to. */
export type AllowanceSlot = TokenSlotOverride & { spender: Address };
```

- `BalanceSlot` is **deleted** (it named "TokenSlotOverride with less");
  `BalanceSlotDiscovery.slots: TokenSlotOverride[]`.
- `AllowanceSlotDiscovery.slots: AllowanceSlot[]` — assignable to
  `readonly TokenSlotOverride[]` *by construction* (the intersection is the
  declaration of the pipeline), `spender` retained for the per-pair caching
  use case.
- Validation in `runSimulator`: any override with
  `amount === MAX_UINT256` → `throw new InvalidSimulationInputError(...)`
  with a message naming both footguns and pointing at
  `OVERRIDE_TOKEN_AMOUNT`. The `?? OVERRIDE_TOKEN_AMOUNT` fallback is
  deleted (nothing left to default).
- `unresolved` JSDoc reframed in `deal` vocabulary on all three sites
  (both discovery types + the requirements `unresolved` object), along the
  lines of: *"Tokens the simulator could not `deal` (in the Foundry sense):
  no storage slot could be found and sentinel-verified to hold their
  balance, so hypothetical balances were not written. Deltas for the
  account's real holdings are unaffected — they come from balanceOf calls,
  which work even for rebasing tokens like stETH."* (Adapt per site: the
  requirements `allowances` list is a *discarded measurement*, not a failed
  deal — keep its existing distinct wording, adding the deal framing only
  where dealing is the failing operation.)

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (lint, typecheck, build, test; needs forge/anvil) |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |

## Scope

**In scope**: `src/types.ts`, `src/index.ts` (remove `BalanceSlot` export),
`src/internal/simulator.ts` (guard + dead-fallback removal),
`src/internal/slots.ts` (attach `amount`), `src/internal/probes.ts`
(fact-level return types replacing the deleted `BalanceSlot` name),
`src/internal/requirements.ts` (delete the slots re-mapper; concat),
`src/txSimulator.ts` (JSDoc only, if its method docs mention the old
shapes), `test/simulate.test.ts`, `test/txSimulator.test.ts`,
`test/requirements.test.ts` (shape expectations + new guard test),
`README.md` (forging section), `plans/README.md` (status row). `dist/` via
`pnpm build` only.

**Out of scope — hard rules**: RPC call counts, debug step names, all
numeric amounts/deltas in assertions (only object *shapes* may gain the
`amount` field); `contracts/**`; error classes; the `unresolved` FIELD NAME
(docs only — renaming was considered and declined); `simulate`'s
`tokenSlotOverrides` arg name (rename to `slots` considered and declined:
the type unification already makes the wiring self-evident).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Types

Apply Target design in `src/types.ts` (required `amount` with the new JSDoc;
delete `BalanceSlot`; redefine `AllowanceSlot` as the intersection; retype
the two discovery `slots` fields; rewrite the `unresolved` JSDoc at all
three sites with the deal framing). Remove `BalanceSlot` from
`src/index.ts`.

**Verify**: `pnpm typecheck` → fails only in internal files + tests
(expected). `grep -n "export type BalanceSlot =" src/types.ts` → no match
(`BalanceSlotDiscovery` remains); `grep -c "TokenSlotOverride &" src/types.ts` → ≥1;
`grep -c "deal" src/types.ts` → ≥2.

### Step 2: Internal plumbing

1. `src/internal/probes.ts`: replace the deleted `BalanceSlot` return type
   with a local fact type (e.g. `type ProbedSlot = { token: Address; slot: Hex }`)
   — do NOT add `amount` here; probes report facts. The allowance probe can
   keep returning `{token, spender, slot}` shaped inline.
2. `src/internal/slots.ts`: attach `amount: OVERRIDE_TOKEN_AMOUNT` when
   assembling `slots` for both discovery results.
3. `src/internal/simulator.ts`: delete the `?? OVERRIDE_TOKEN_AMOUNT`
   fallback; add the guard before building the state override —

```ts
if (override.amount === MAX_UINT256) {
  throw new InvalidSimulationInputError(
    "tokenSlotOverrides amount must be below uint256 max: max-allowance skips ERC-20 decrements and max-balance overflows incoming transfers. Use OVERRIDE_TOKEN_AMOUNT.",
  );
}
```

4. `src/internal/requirements.ts`: delete the slots re-mapper; its `slots`
   result becomes a plain concat of the two discovery outputs (allowance
   entries carry `spender` — harmless extra field on `TokenSlotOverride[]`).

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "?? OVERRIDE_TOKEN_AMOUNT" src/` → no matches;
`grep -n "MAX_UINT256" src/internal/simulator.ts` → the guard.

### Step 3: Tests

1. Update shape expectations: add `amount: OVERRIDE_TOKEN_AMOUNT` where
   discovery outputs are deep-compared. No other expectation edits.
2. New test (in `test/simulate.test.ts`, instance style): a handcrafted
   override `{ token, slot, amount: MAX_UINT256 }` (compute via
   `(1n << 256n) - 1n` or viem's `maxUint256`) →
   `await expect(sim.simulate({...})).rejects.toBeInstanceOf(InvalidSimulationInputError)`.
3. Existing pipe-through tests (`tokenSlotOverrides: discovery.slots`)
   must pass UNCHANGED — they prove the currency design.

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass;
`git diff -- test` shows only added `amount:` fields and the one new test.

### Step 4: README + full gate

In "Forging balances and allowances": state that discovery returns
ready-to-use `TokenSlotOverride[]` with `amount` pre-set to
`OVERRIDE_TOKEN_AMOUNT`; handcrafted amounts must be below uint256 max (and
why, one clause); and add the rebasing-token clarification — *deltas for
real holdings work for tokens like stETH; only dealing hypothetical
balances fails, reported in `unresolved`*. Keep it to ~4 sentences.

**Verify**: `pnpm verify` → exit 0; `grep -c "deal" README.md` → ≥1.

## Test plan

Step 3: one new guard test; shape-only updates elsewhere; the untouched
pipe-through tests are the design's own acceptance check.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `TokenSlotOverride.amount` required (`grep -n "amount?: bigint" src/types.ts` → no match)
- [ ] `BalanceSlot` gone from types and index (`grep -rn "BalanceSlot\b" src/types.ts src/index.ts | grep -v Discovery` → no matches)
- [ ] `AllowanceSlot` declared as `TokenSlotOverride & {...}`
- [ ] Max-amount guard present with a test asserting `InvalidSimulationInputError`
- [ ] `grep -rn "?? OVERRIDE_TOKEN_AMOUNT" src/` → no matches
- [ ] `unresolved` JSDoc uses the deal framing at the discovery sites; README updated
- [ ] `git diff -- test` contains only `amount:` shape additions + the new guard test
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any RPC-count or numeric-amount assertion needs changing — behavior
  moved; revert and report.
- Requiring `amount` forces a change to how `internal/requirements.ts`
  *measures* (it must not — measurement forging already uses the sentinel
  explicitly).
- The guard placement in `runSimulator` cannot see caller-supplied
  overrides distinctly from internal ones — it doesn't need to; the
  sentinel is below max, so internal paths never trip it. If they do,
  something else changed — report.

## Maintenance notes

- The invariant to review for: **every discovery output is a valid
  `simulate` input by declared type**, not by field coincidence. New
  discovery methods return `TokenSlotOverride`-derived elements.
- If a proportional-write extension for shares-based tokens (stETH) is
  ever attempted, it changes probe *verification* semantics — new plan, and
  the deal-framed docs will need a carve-out.
- `OVERRIDE_TOKEN_AMOUNT` is now data in discovery outputs (and in any
  caller caches). Changing the constant's value changes what cached slots
  replay — note that in the constant's JSDoc if it's ever revised.
