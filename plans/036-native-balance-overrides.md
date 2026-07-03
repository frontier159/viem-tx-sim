# Plan 036: Native balance overrides — forge ETH for any account, and make estimateRequirements survive broke wallets

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat f7ad02a..HEAD -- src test README.md`
> Plan 035 (README orientation, TODO) also edits README.md — that overlap
> is expected in either order; rebase the docs edit, don't duplicate
> sections. For src/test drift, compare the "Current state" excerpts below
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 (active consumer blocker — Origami native zap-in routes fail instead of falling back)
- **Effort**: S-M
- **Risk**: LOW (TS-only, additive; the state-override mechanism is protocol-level and already plumbed internally)
- **Depends on**: none (001-034 DONE; independent of 035 apart from the README overlap note above)
- **Category**: dx + direction (consumer request, Origami 2026-07-04)
- **Planned at**: commit `f7ad02a`, 2026-07-04

## Why this matters

Origami's report: *"Native inputs cannot be forged. viem-tx-sim@0.2.0 has
no public native balance override helper. Native zap-in simulation depends
on the connected wallet actually having enough native balance. That should
be a fallback, not a route failure."*

They're right, and the fix is the cheapest forge in the library: unlike
ERC-20 balances (storage slots, discovery, sentinel verification), native
balances are a **first-class field of viem's `StateOverride`** — you
declare `{ address, balance }` in the same override set that already
injects the simulator bytecode. The internal merge logic has supported
`balance` entries since the original design; it was simply never exposed
publicly. Two consumer-visible gaps close:

1. `simulate()` gains optional `nativeBalanceOverrides` — forge ETH for
   `from` OR any other account (plugins, routers), consistent with the
   arbitrary-account observation model.
2. `tokenOverrides.estimateRequirements()` currently cannot even MEASURE a
   native zap-in from a broke wallet (the value-bearing call reverts before
   anything is observed). Its measurement sim will auto-forge a generous
   native balance for `from` — exactly parallel to how it already forges
   generous token balances/allowances — so `requirements.native` reports
   the real need instead of the run collapsing.

No helper namespace entry is needed: there is nothing to discover or
verify, so this is plain data on the args (matching the mental model —
`tokenSlotOverrides` and `nativeBalanceOverrides` are both "state you
assume").

## Current state

(All at `f7ad02a`.)

### The internal mechanism already exists — `src/internal/simulator.ts`

- `runSimulator` args include `extraStateOverrides?: readonly StateOverrideEntry[]`
  (`:72`), spread into `buildStateOverride([...])` (`:99`) alongside the
  bytecode-injection entry and the tokenSlotOverride stateDiffs.
- `buildStateOverride` (`:257`) merges entries per address via
  `MutableStateOverrideEntry { address; code?; balance?: bigint; stateDiff? }`
  (`:247-255`) — `balance` handled at `:266` (merge) and `:283` (output).
  Merging `balance` onto `from` (which also carries `code`) works by
  construction. Verify whether anything currently passes
  `extraStateOverrides` (expected: nothing — it's a dormant seam; if
  something does, note it and compose rather than replace).
- The tokenSlotOverrides max-uint guard lives nearby (`:294-297`,
  `InvalidSimulationInputError`).

### Public shapes — `src/types.ts`, `src/txSimulator.ts`

- `SimulateArgs`: `from`, `calls`, `balanceQueries` (required),
  `tokenSlotOverrides?`, `errorAbi?`, `gas?`, `debug?`, block options.
  `runSimulate` (module-private in `src/txSimulator.ts`) maps args →
  `runSimulator`.
- `src/internal/requirements.ts`: `discoverRequirements` runs a recon sim
  then a measurement sim (`runSimulator` twice); the measurement sim
  passes `tokenSlotOverrides` forging discovered slots to
  `OVERRIDE_TOKEN_AMOUNT`; `requirements.native` is
  `measurement.probeData.maxNativeOutflow` (relative tracking — works
  identically under a forged-high starting balance).
- `OVERRIDE_TOKEN_AMOUNT = 10n ** 50n` (`src/constants.ts`) — also a
  sensible native forge sentinel (10^50 wei ≪ 2^256).
- Native balance queries (`asset: "native"`) read post-override state, so
  a forged account's `before` reflects the forged amount — consistent
  with the documented "before = state after overrides" semantics.

### Docs anchors

README "Preparing balance and allowance overrides" section documents the
token forge path and the "query the tokens you forge" line; Known
limitations has the "Results are estimates" and asset-coverage entries.
Neither mentions native forging (it didn't exist publicly).

## Target design

### Types (`src/types.ts`)

```ts
/** Protocol-level native (ETH) balance to set before simulating. No slot discovery needed and it cannot fail — never appears in `unresolved`. */
export type NativeBalanceOverride = {
  /** Account to fund — `from` or any other address (plugin, router, ...). */
  account: Address;
  /** Balance in wei to set. */
  amount: bigint;
};
```

- `SimulateArgs` gains `nativeBalanceOverrides?: readonly NativeBalanceOverride[]`.
- Export `NativeBalanceOverride` from `src/index.ts`.
- NOT added to `DiscoverRequirementsArgs` — estimation forges its own
  (below); keep the surface minimal until a consumer asks.

### Plumbing

- `runSimulate` maps each override to a `StateOverrideEntry`
  `{ address: o.account, balance: o.amount }` passed via the existing
  `extraStateOverrides` seam. Duplicate accounts: last wins via the
  existing merge — add one JSDoc line rather than validation.
- Native overrides intentionally do not mirror the token max-uint guard:
  the ERC-20 allowance decrement issue does not apply to native balances.
- `discoverRequirements` (`src/internal/requirements.ts`): the
  **measurement sim only** additionally passes
  `extraStateOverrides: [{ address: from, balance: OVERRIDE_TOKEN_AMOUNT }]`.
  The recon sim stays unforged (its job is `observedTokens`, which a
  revert still returns). `requiredBalances`/`requiredAllowances` math is
  unaffected; `native` continues to come from `maxNativeOutflow`.

### Docs

- README forging section: a short "Forging native balances" paragraph +
  3-line snippet (no preparation step — plain data), extend the
  "query the tokens you forge" sentence to cover native, and note that
  `estimateRequirements` measures native zap-ins even from unfunded
  wallets (fallback, not route failure — Origami's phrasing is fine to
  echo).
- JSDoc per plan-022 standards on the new type/field.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (needs forge/anvil) |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |
| Changeset | `pnpm changeset` | interactive; pick **patch** |

## Scope

**In scope**: `src/types.ts`, `src/txSimulator.ts`,
`src/internal/simulator.ts` (guard only, if placed there),
`src/internal/requirements.ts`, `src/index.ts`, `test/simulate.test.ts` +
`test/requirements.test.ts` (new tests), `README.md`, `.changeset/*.md`
(one patch changeset), `plans/README.md` (status row). `dist/` via
`pnpm build` only.

**Out of scope**: `contracts/**` and `src/generated/` (protocol-level
override — the contract never sees it); helper namespaces (nothing to
discover); `DiscoverRequirementsArgs` surface; `unresolved` shapes (native
dealing cannot fail); CLAUDE.md (035's at-a-glance rule will pick the
field up when that plan runs — note the interaction in your report if 035
already landed).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.
  Branch protection is active on `master` — the operator merges.

## Steps

### Step 1: Type + arg + plumbing + guard

Per Target design. Verify first whether `extraStateOverrides` has existing
callers (`grep -rn "extraStateOverrides" src/`) — compose if so.

**Verify**: `pnpm typecheck` → exit 0;
`grep -n "NativeBalanceOverride" src/index.ts` → exported.

### Step 2: estimateRequirements native forging

Add the measurement-sim `extraStateOverrides` entry per Target design.

**Verify**: `pnpm typecheck` → exit 0; existing requirements tests still
pass unchanged (`pnpm build:contracts && pnpm exec vitest run test/requirements.test.ts`)
— token amounts/counts must be byte-identical (native forging must not
disturb token measurement).

### Step 3: Tests

In `test/simulate.test.ts` (instance style, exact values):

1. **The Origami case**: a value-bearing call from an account with ZERO
   native balance (use a fresh random address as `from` — anvil accounts
   are pre-funded; e.g. `privateKeyToAccount(<fresh key>).address` or any
   unfunded address literal): without `nativeBalanceOverrides` →
   `status: "reverted"`; with
   `nativeBalanceOverrides: [{ account: from, amount: parseEther("10") }]`
   → `status: "success"`, and a native balance query shows
   `before === parseEther("10")` with the correct negative `delta` and
   `byCall`.
2. **Arbitrary-account funding**: fund an address that is NOT `from`,
   query it → `before` reflects the forged amount.
3. **Max native balance**: `amount: (1n << 256n) - 1n` is accepted for a
   no-op native observation. Native max is not an approval-style
   decrement footgun.

In `test/requirements.test.ts`:

4. **Broke-wallet native estimation**: `estimateRequirements` on a
   value-bearing call from an unfunded `from` → `status: "success"` and
   `native === <the call's value>` (this test FAILS on pre-036 code —
   state that expectation in a comment).

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass,
three consecutive runs (concurrency-adjacent change to override assembly).

### Step 4: Docs + changeset + full gate

README edits per Target design (coordinate with plan 035 if it landed —
additive paragraph, don't disturb its sections). `pnpm changeset` →
**patch**: "Add nativeBalanceOverrides to simulate(); estimateRequirements
now measures native requirements for unfunded accounts."

**Verify**: `grep -c "nativeBalanceOverrides" README.md` → ≥2;
`ls .changeset/*.md | grep -v README | wc -l` → ≥1 new;
`pnpm verify` → exit 0.

## Test plan

Step 3's four tests — the first is the consumer-reported scenario verbatim
(route failure → fallback), the fourth pins the estimation fix with an
explicit "fails pre-036" marker.

## Done criteria

- [ ] `pnpm verify` exits 0; suite green 3 consecutive runs
- [ ] `NativeBalanceOverride` exported; `SimulateArgs.nativeBalanceOverrides` optional
- [ ] Origami-case test passes both directions (reverted without, success with)
- [ ] Arbitrary-account funding test passes; max-uint native override test passes
- [ ] Broke-wallet `estimateRequirements` test passes with exact `native` value
- [ ] Existing token-measurement assertions byte-identical
- [ ] `contracts/` and `src/generated/` untouched (`git diff --stat -- contracts src/generated` → empty)
- [ ] README documents native forging; patch changeset present
- [ ] `plans/README.md` status row updated

## STOP conditions

- `extraStateOverrides` turns out to have an existing caller whose entries
  would conflict with native funding at the same address — report the
  composition question rather than picking a precedence.
- The RPC/anvil rejects a `balance` state override (it shouldn't — it's
  standard) — report provider/version.
- Anything suggests the contract needs changes — it must not; the override
  is invisible to it.

## Maintenance notes

- `nativeBalanceOverrides` is the third "assume" input alongside
  `tokenSlotOverrides` — plan 035's at-a-glance block and mental-model
  paragraph must include it (if 035 runs after this plan, its
  derive-from-live-interface rule covers it automatically; if 035 ran
  first, update the block in this PR per the same-PR rule).
- If a consumer ever asks to forge native inside `estimateRequirements`
  for accounts other than `from`, expose `nativeBalanceOverrides` on
  `DiscoverRequirementsArgs` then — deliberately not done now.
- Code-override interaction: funding `from` merges into the same
  StateOverride entry as the bytecode injection — covered by
  `buildStateOverride`'s per-address merge; a regression there would
  surface as test 1 failing.
