# Plan 025: viem-style restructure — top level is the public surface, internal/ consolidated to six domain files

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> 1. `grep -n "| 024 |" plans/README.md` → status must be `DONE`. If not,
>    STOP — plan 024 edits `src/internal/revert.ts`, `src/requirements.ts`,
>    and the `defaults()` merge in `src/txSimulator.ts`, all of which this
>    plan moves or rewrites.
> 2. `git diff --stat 82a79a1..HEAD -- src` → drift from 024 is expected;
>    locate everything below by SYMBOL name, not line number. STOP only if a
>    named symbol no longer exists.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (many files move at once; zero behavior change is the contract, the suite is the net)
- **Depends on**: plans/024 (must be DONE)
- **Category**: tech-debt
- **Planned at**: commit `82a79a1`, 2026-07-03 (before 024 executed — see drift check)

## Why this matters

The public entry point is exactly one thing — the `TxSimulator` interface —
but the source tree doesn't say so: `src/` mixes the five public modules
with an implementation module (`requirements.ts`, top-level by inertia from
when it was exported), and `src/internal/` has accreted twelve files, five
of them under 40 lines, split along historical plan boundaries rather than
domains. Using viem's organizing principle at this scale (group by role —
client/actions/utils/types/errors — not file-per-helper), the tree becomes:
**top level = the public surface exactly; `internal/` = six domain files.**

Three "two representations of one thing" simplifications ride along because
the merges make them cheaper than preserving the seams (all
behavior-invariant):

- **(A)** Delete the intermediate `StorageOverride` representation — the
  public `TokenSlotOverride` flows directly to viem `StateOverride`, with
  the `amount ?? OVERRIDE_TOKEN_AMOUNT` default applied at one point.
- **(B)** Centralize the gas default in `create()` — today
  `args.gas ?? DEFAULT_SIMULATION_GAS_LIMIT` is applied independently in
  `runSimulate` AND `discoverRequirements` (two sync points).
- **(C)** Kill the `internal/hex.ts` re-export of `OVERRIDE_TOKEN_AMOUNT`
  (plan-022 churn-avoidance indirection) — consumers import
  `constants.js` directly.

CLAUDE.md's "Key modules" section is already stale (it still lists
`src/simulate.ts` and `src/slots.ts`, deleted by plan 023) — this plan
refreshes it to the new tree.

## Current state

(At `82a79a1`; 024 will have modified revert.ts/requirements.ts/txSimulator.ts.)

```
src/                         lines   fate
  index.ts                      35   unchanged (barrel; exports untouched)
  txSimulator.ts               184   stays; simplifications B applied
  requirements.ts              260   MOVE → internal/requirements.ts
  types.ts                     236   stays (public types)
  errors.ts                     45   stays
  constants.ts                  15   stays
  generated/                     -   stays (CI + generator reference the path)
  internal/
    rpc.ts                     151   absorbs debug.ts            → internal/rpc.ts    (~210)
    debug.ts                    58   → into rpc.ts
    simulator.ts               164   absorbs stateOverride, revert, discovery
                                                                 → internal/simulator.ts (~300, less after A)
    stateOverride.ts            69   → into simulator.ts (minus deletions from A)
    revert.ts                   30*  → into simulator.ts (*bigger post-024)
    discovery.ts                35   → into simulator.ts
    slotDiscovery.ts            55   absorbs allowanceDiscovery, layout
                                                                 → internal/slots.ts  (~200)
    allowanceDiscovery.ts      118   → into slots.ts
    layout.ts                   27   → into slots.ts
    probes.ts                  213   unchanged                   → internal/probes.ts
    address.ts                  19   absorbs hex.ts              → internal/data.ts   (~40)
    hex.ts                      19   → into data.ts (minus the constants re-export, C)
```

Result: 17 files → 11 (+generated). Rationale for the two kept seams:
`probes.ts` merged into `slots.ts` would be ~460 lines (past the size cap)
and the primitive/orchestration boundary is clean; `requirements.ts` stays
its own internal file (distinct domain, ~260 lines).

### Facts the simplifications rely on (verified at `82a79a1`)

- **(A)** `StorageOverride` (`src/internal/stateOverride.ts:6`) is consumed
  by `storageOverridesToStateDiff` (`:57`), `runSimulator`'s
  `storageOverrides` arg (`src/internal/simulator.ts`), and mapping helpers
  in BOTH callers: `runSimulate` (txSimulator.ts) and `slotOverride` +
  `tokenSlotOverride` (requirements.ts) convert
  `TokenSlotOverride`-shaped data to `{address, slot, value: Hex}` before
  `runSimulator` converts again to viem `StateOverride`.
  `buildStateOverride` (`stateOverride.ts:24` — merges the bytecode-injection
  entry with slot diffs, deduping by address/slot) is real logic and MOVES
  into simulator.ts unchanged.
- **(B)** Gas default applied at `txSimulator.ts:148` (inside `runSimulate`)
  and `requirements.ts:42`. `create()`'s `defaults()` already merges
  per-call-over-bound `gas`/`debug` (and post-024 `errorAbi`); adding
  `?? DEFAULT_SIMULATION_GAS_LIMIT` there makes `gas` always-present
  downstream. The internal implementations' `gas?: bigint` optionals can
  stay optional (probes are also called with explicit gas everywhere) — the
  ONLY change is deleting the two `?? DEFAULT` fallbacks and adding one in
  `defaults()`.
- **(C)** `src/internal/hex.ts:3` is
  `export { OVERRIDE_TOKEN_AMOUNT } from "../constants.js";` — grep its
  importers and point them at `constants.js`.
- Tests import ONLY from `../src/index.js` (verified) — no test-file changes
  of any kind are permitted.
- `index.ts` re-exports from `./txSimulator.js`, `./types.js`,
  `./errors.js`, `./constants.js` — none of those move, so `index.ts` is
  untouched.
- Layering invariant (CLAUDE.md): internal modules import only `types.ts`,
  `errors.ts`, `constants.ts`, `generated/`, and internal siblings — the
  `requirements.ts` move respects it (verified: it imports exactly those).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (lint, typecheck, build, test; needs forge/anvil) |
| Typecheck only | `pnpm typecheck` | exit 0 |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |

## Scope

**In scope**: everything under `src/` EXCEPT `src/index.ts`,
`src/errors.ts`, `src/constants.ts`, `src/generated/**` (all four
untouched); `CLAUDE.md` ("Key modules" section refresh); `plans/README.md`
(status row). `dist/` via `pnpm build` only. Use `git mv` for the
file-level moves (`requirements.ts`) so history follows; content merges are
ordinary edits.

**Out of scope — hard rules**:

- `test/**` — zero edits. Every assertion, RPC count, and amount is frozen.
- `src/index.ts` — the public surface must be byte-identical.
- `src/types.ts` public shapes — EXCEPT deleting nothing; if simplification
  A tempts you to change `TokenSlotOverride`, stop (it already has the
  right shape).
- `contracts/**`, `scripts/**`, `.github/**` — the generated-artifact paths
  are deliberately NOT moving (the CI freshness gate and the generator
  script reference `src/generated` literally).
- Debug step names, RPC call order/counts, error classes/messages.

## Steps

Ordered so the tree compiles after every step.

### Step 1: `internal/data.ts` (+ simplification C)

Create `src/internal/data.ts` = contents of `address.ts` + `hex.ts`, MINUS
the `OVERRIDE_TOKEN_AMOUNT` re-export line. Update all importers of
`./address.js` / `./hex.js` to `./data.js`; importers of
`OVERRIDE_TOKEN_AMOUNT`-via-hex switch to `../constants.js` (internal
files) / `./constants.js` (top-level files). Delete `address.ts`, `hex.ts`.

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "hex.js\|address.js" src/` → no matches;
`grep -rn "OVERRIDE_TOKEN_AMOUNT" src/ | grep -v constants` → all importers
reference `constants.js` directly.

### Step 2: `internal/rpc.ts` absorbs `debug.ts`

Append `debug.ts`'s contents (`emitDebug`, `withRpcDebug`, formatting
helpers) into `rpc.ts`; update importers of `./debug.js`; delete `debug.ts`.

**Verify**: `pnpm typecheck` → exit 0; `ls src/internal/debug.ts` → gone.

### Step 3: `internal/slots.ts`

Create `src/internal/slots.ts` = `slotDiscovery.ts` + `allowanceDiscovery.ts`
+ `layout.ts` contents (three sections, keep a one-line banner comment per
section: orchestration / inference internals / layout math). Update
importers (`txSimulator.ts`, `requirements.ts`, tests import nothing here);
delete the three source files.

**Verify**: `pnpm typecheck` → exit 0;
`pnpm build:contracts && pnpm exec vitest run test/requirements.test.ts` →
all pass (RPC-count assertions pin the inference behavior).

### Step 4: `internal/simulator.ts` absorbs stateOverride + revert + discovery (+ simplification A)

1. Move `discovery.ts`'s `discoverCandidateAddresses`, `revert.ts`'s
   decoder (post-024: `decodeRevert` + helpers), and `stateOverride.ts`'s
   `buildStateOverride` + `StateOverrideEntry` into `simulator.ts`. Delete
   the three files.
2. Simplification A: change `runSimulator`'s `storageOverrides` arg to
   `tokenSlotOverrides?: readonly TokenSlotOverride[]`; inside, build the
   viem `StateOverride` directly —
   `{ address: o.token, stateDiff: [{ slot: o.slot, value: uint256Hex(o.amount ?? OVERRIDE_TOKEN_AMOUNT) }] }`
   grouped per address (reuse/adapt the grouping from
   `storageOverridesToStateDiff`, then delete that function and the
   `StorageOverride` type). Update both callers: `runSimulate`
   (txSimulator.ts) passes `args.tokenSlotOverrides` straight through
   (deleting its mapping); `requirements.ts` passes
   `[...balanceSlots, ...allowanceSlots].map(tokenSlotOverride)`-style
   plain `{token, slot}` objects (its forge amount is the default, so no
   `amount` needed — delete its `slotOverride` helper; keep
   `tokenSlotOverride` only if still used for the public `slots` result
   field).

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "StorageOverride" src/` → no matches;
`pnpm exec vitest run` → all pass.

### Step 5: Move `requirements.ts` → `internal/requirements.ts`

`git mv src/requirements.ts src/internal/requirements.ts`; fix its relative
imports (`./internal/x.js` → `./x.js`, `./types.js` → `../types.js`, etc.)
and `txSimulator.ts`'s import.

**Verify**: `pnpm typecheck` → exit 0;
`ls src/*.ts` → exactly `constants.ts errors.ts index.ts txSimulator.ts types.ts`.

### Step 6: Simplification B — gas default in `create()`

In `txSimulator.ts` `defaults()`: `const gas = args.gas ?? bound.gas ?? DEFAULT_SIMULATION_GAS_LIMIT;`
(gas is now always set — its conditional spread can become unconditional).
Delete the `?? DEFAULT_SIMULATION_GAS_LIMIT` fallbacks in `runSimulate` and
`internal/requirements.ts` (and their now-unused imports if any).

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "DEFAULT_SIMULATION_GAS_LIMIT" src/ | grep -v "constants.ts\|index.ts\|types.ts"` →
exactly one code site (txSimulator.ts `defaults()`), plus JSDoc mentions.

### Step 7: CLAUDE.md + full gate

Refresh CLAUDE.md's "Key modules" list to the new tree (it currently lists
the plan-023-deleted `src/simulate.ts` / `src/slots.ts` — rewrite the whole
list from `ls src src/internal`). Keep every other section.

**Verify**: `pnpm verify` → exit 0; run `pnpm exec vitest run` twice more
(file moves shouldn't flake, but the suite is the whole safety story here);
`git diff --stat -- test` → empty.

## Test plan

None — zero behavior change is the deliverable. Gates: full suite passing
unmodified (three runs), the `StorageOverride`/gas-default/re-export greps,
and the file-inventory checks.

## Done criteria

- [ ] `pnpm verify` exits 0; suite green 3 consecutive runs; `git diff --stat -- test` → empty
- [ ] `ls src/*.ts` → exactly `constants.ts errors.ts index.ts txSimulator.ts types.ts`
- [ ] `ls src/internal/*.ts` → exactly `data.ts probes.ts requirements.ts rpc.ts simulator.ts slots.ts`
- [ ] `git diff -- src/index.ts` → empty
- [ ] `grep -rn "StorageOverride" src/` → no matches (simplification A)
- [ ] Gas default applied at exactly one code site (simplification B grep from Step 6)
- [ ] `grep -rn "from \"../constants.js\"" src/internal/` covers all internal `OVERRIDE_TOKEN_AMOUNT` uses; no re-export remains (C)
- [ ] CLAUDE.md module list matches the new tree (no `src/simulate.ts` / `src/slots.ts` references)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plan 024 is not DONE.
- Any test assertion fails after a step — revert that step and report; the
  moves must be invisible.
- Simplification A turns out to need a public type change (it must not —
  `TokenSlotOverride` already has the required shape).
- A merged file would exceed ~350 lines (recount after 024's drift) —
  report the count rather than merging anyway.
- Import-cycle: if `internal/requirements.ts` ends up importing
  `txSimulator.ts` for anything, stop — that dependency direction is
  forbidden.

## Maintenance notes

- The rule this plan establishes: **top level = the public surface, one
  file per exported domain; `internal/` = six domain files** (data, rpc,
  probes, slots, simulator, requirements). New helpers join the domain file
  they serve; a new FILE needs a new domain, not a new plan-boundary.
- Deliberately rejected (recorded in plans/README.md): moving
  `src/generated/` (CI + generator path references), merging `probes.ts`
  into `slots.ts` (size + clean primitive/orchestration seam), merging
  `errors.ts`/`constants.ts` into `types.ts` (runtime values in a types-only
  module), splitting `types.ts` into a directory (viem-scale ceremony).
- `internal/simulator.ts` (~300) and `internal/requirements.ts` (~260) are
  at the size cap — the next feature in either domain should consider a
  split along execute/interpret lines rather than growing them.
