# Plan 019: Report unresolved tokens/pairs from slot discovery instead of silently omitting them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0031a..HEAD -- src/slots.ts src/requirements.ts src/types.ts src/internal/allowanceDiscovery.ts test README.md`
> Plans 016, 017, and 018 must be DONE (check `plans/README.md`) — this plan
> is written against their output: renamed fields, the internal
> `allowanceDiscovery.ts` module with its per-pair `(AllowanceSlot |
> undefined)[]` return, and the discriminated `DiscoveredRequirements`.
> STOP if any of those are missing.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (breaking return-shape change for the two slots functions; pre-prod)
- **Depends on**: plans/016, plans/017, plans/018
- **Category**: dx
- **Planned at**: commit `ed0031a`, 2026-07-02

## Why this matters

Discovery failures are currently invisible. `discoverBalanceSlots()` /
`discoverAllowanceSlots()` drop unverifiable entries from their returned
arrays — a caller who passed 3 tokens and got 2 slots must diff inputs
against outputs to learn *which* token failed (rebasing tokens like stETH
legitimately fail — README documents the omission but the API gives no
handle). Worse, `discoverRequirements()` probes pairs the caller never
enumerated, then silently drops both undiscoverable pairs and pairs whose
measurement was discarded by the gross-outflow corruption clamp — an empty
`allowances` array is indistinguishable from "no approvals needed". A wallet
cannot warn "we could not verify token X; its preview may be incomplete."

After this plan: the slots functions return `{ slots, unresolved }`, and
`DiscoveredRequirements` gains an `unresolved` field distinguishing
undiscoverable slots from unreliable (clamp-discarded) measurements.

## Current state

(Post-017 shapes; symbol names authoritative over line numbers.)

- `src/slots.ts` — both functions end with
  `results.filter((slot): slot is X => slot !== undefined)`. Per plan 017,
  `discoverAllowanceSlots` delegates to
  `src/internal/allowanceDiscovery.ts`'s
  `discoverAllowanceSlotsWithInference(...): Promise<(AllowanceSlot | undefined)[]>`
  — a result per input pair, so the failed pairs are already known at that
  seam; `discoverBalanceSlots` maps tokens via `discoverBalanceSlot` the same
  way (undefined per failed token).
- `src/requirements.ts` — builds pairs = tokens × spenders internally; calls
  the public discovery functions; separately, `requiredAllowances(...)`
  (post-plan-009) **discards** a pair when its summed decrease exceeds the
  token's gross outflow (overwrite corruption) — that discard is a `continue`
  with no record.
- `src/types.ts` — post-018: `DiscoveredRequirements` is a discriminated
  union over a shared base carrying `native/balances/allowances/slots`.
- README "Known limitations" documents the silent omission for
  rebasing/share-based tokens; "Discovering requirements" documents the
  clamp. Both get one-line updates pointing at the new fields.

## Target shape

```ts
// types.ts
export type BalanceSlotDiscovery = {
  slots: BalanceSlot[];
  /** Tokens whose balance slot could not be found and sentinel-verified. */
  unresolved: Address[];
};

export type AllowanceSlotDiscovery = {
  slots: AllowanceSlot[];
  /** Pairs whose allowance slot could not be found and sentinel-verified. */
  unresolved: { token: Address; spender: Address }[];
};

// DiscoveredRequirements shared base gains:
unresolved: {
  /** Tokens/pairs discovery could not verify — their state was NOT forged. */
  balanceSlots: Address[];
  allowanceSlots: { token: Address; spender: Address }[];
  /** Pairs measured but discarded as unreliable (in-batch allowance overwrite detected via the gross-outflow bound). */
  allowances: { token: Address; spender: Address }[];
};
```

`discoverBalanceSlots` returns `Promise<BalanceSlotDiscovery>`;
`discoverAllowanceSlots` returns `Promise<AllowanceSlotDiscovery>`. Order
within each array follows input order. Export the two new type names.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |

## Scope

**In scope**: `src/types.ts`, `src/slots.ts`, `src/requirements.ts`,
`src/index.ts` (type exports), `test/simulate.test.ts`,
`test/requirements.test.ts`, `test/mainnet.test.ts` (call sites destructure
`slots` now), `README.md` (two one-line updates), `plans/README.md` (status
row). `dist/` via build.

**Out of scope**: `src/internal/allowanceDiscovery.ts` and
`src/internal/probes.ts` — their per-item `undefined` contract already
carries the information; no internal changes. `simulate()` — unchanged;
`tokenSlotOverrides` consumers now pass `discovery.slots`.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Types

Add `BalanceSlotDiscovery` / `AllowanceSlotDiscovery` to `src/types.ts`,
extend the `DiscoveredRequirements` shared base with `unresolved`, export
the new names from `src/index.ts`.

**Verify**: `pnpm typecheck` → fails only at the function implementations.

### Step 2: `src/slots.ts` return shapes

Both functions zip their per-item results against inputs:
defined → `slots`, undefined → `unresolved` (the input token/pair). Preserve
input order in both arrays.

**Verify**: `pnpm typecheck` → errors now only at call sites (tests,
requirements.ts).

### Step 3: `src/requirements.ts`

- Destructure the discovery results; forge only `slots`; carry both
  `unresolved` lists through.
- In `requiredAllowances`, replace the clamp's silent `continue` with
  recording the pair into a third list returned alongside (change the
  helper's return to `{ allowances, discarded }` or pass a collector — keep
  it explicit, matching the file's existing plain-function style).
- Assemble `unresolved: { balanceSlots, allowanceSlots, allowances }` into
  the shared base of both result variants.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Update call sites and tests

- Fix existing tests/mainnet test to destructure `.slots`.
- New assertions:
  1. `discoverBalanceSlots` with one good token + one EOA address (not a
     token) → `slots.length === 1`, `unresolved` equals `[eoaAddress]`.
  2. In the existing NonStandardSlotToken requirements test: `unresolved`
     lists are empty (fallback succeeded — pins that unresolved ≠ slow-path).
  3. In the plan-009 relayed-overwrite test (`PermitRelayer`): the discarded
     pair now appears in `requirements.unresolved.allowances` with exact
     token/spender.
  4. Vault test: `unresolved` fully empty on the happy path.

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass.

### Step 5: README + full gate

Update the Known-limitations rebasing-token bullet ("...omits them — they are
reported in the `unresolved` list") and the Discovering-requirements clamp
sentence ("...are excluded and reported under `unresolved.allowances`").

**Verify**: `pnpm verify` → exit 0.

## Test plan

Four assertions in Step 4, threaded into existing tests where the fixtures
already exist (EOA-as-token is the only new fixture-free case). Pattern:
existing exact-value assertions in the same files.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `discoverBalanceSlots`/`discoverAllowanceSlots` return `{ slots, unresolved }` (`grep -n "unresolved" src/slots.ts` → ≥2)
- [ ] `grep -n "continue" src/requirements.ts` → the clamp discard no longer silently continues without recording
- [ ] `DiscoveredRequirements` base includes `unresolved` with the three lists; new type names exported
- [ ] All four new assertions present and passing
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plans 016-018 not all DONE.
- Preserving input order in `unresolved` conflicts with the internal
  module's return shape — that shape was specified per-pair in plan 017;
  report the mismatch rather than reordering.
- Any existing exact-amount assertion needs changing — behavior moved, not
  just shape; stop.

## Maintenance notes

- `unresolved` is deliberately *lists of identifiers*, not error objects —
  probes intentionally swallow causes (plan 011 pinned that contract). If
  per-item causes are ever wanted, extend the internal per-item return to a
  result object first.
- The wallet-facing intent: anything in `unresolved` means "this asset's
  preview may be incomplete — warn the user." Keep that framing in docs.
