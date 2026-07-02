# Plan 017: Move base-slot inference into the public discoverAllowanceSlots and delete its private twin

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0031a..HEAD -- src/slots.ts src/requirements.ts src/internal/layout.ts test`
> Plan 016 (field renames: `calldata`→`data`, public `owner`→`from`) must be
> DONE — check `plans/README.md`. Its renames are anticipated drift; locate
> excerpts below by symbol name. STOP if a named symbol no longer exists.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches RPC-count-pinned code paths; the pinned tests are the safety net)
- **Depends on**: plans/016
- **Category**: tech-debt + perf
- **Planned at**: commit `ed0031a`, 2026-07-02

## Why this matters

There are two implementations of allowance-slot discovery. The **public**
`discoverAllowanceSlots()` (`src/slots.ts`) probes every (token, spender)
pair with a full `eth_createAccessList` + sentinel-verify round-trip. The
**private** `discoverAllAllowanceSlots()` (`src/requirements.ts`) is smarter:
it groups pairs by token, probes the first spender, inverts the probed slot
to the mapping's base slot (`src/internal/layout.ts`), then *computes* every
other spender's slot locally and verifies each with a single `eth_call` —
falling back to the full probe when inference misses. For one token with N
spenders that is 1 access list + N verifies instead of N access lists + N
verifies. Public callers silently pay the slow path, and two divergent
implementations of the same discovery invite drift (they already diverge in
parallelization structure). After this plan the public function owns the
fast path and `discoverRequirements()` consumes it; the private twin and its
helpers are deleted.

## Current state

(All at `ed0031a`, pre-016 names; apply 016's renames when reading.)

### Public slow path — `src/slots.ts`, `discoverAllowanceSlots`

```ts
const slots = await Promise.all(
  args.pairs.map((pair) =>
    discoverAllowanceSlot({
      client: args.client,
      token: pair.token,
      owner: args.owner,          // `from` after plan 016
      spender: pair.spender,
      sentinel: OVERRIDE_TOKEN_AMOUNT,
      gas: args.gas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    }),
  ),
);
return slots.filter((slot): slot is AllowanceSlot => slot !== undefined);
```

### Private fast path — `src/requirements.ts`

`discoverAllAllowanceSlots({ tokens, spenders, ... })` (~lines 126-169 as of
plan 013's parallelization): per token — filter out `spender === token`,
probe the FIRST spender via `discoverProbedAllowanceSlot` (thin wrapper over
`discoverAllowanceSlot`), call
`inferAllowanceBaseSlot({ probedSlot, owner, spender })`, then for remaining
spenders either `discoverComputedAllowanceSlot` (compute via
`allowanceSlotFor(owner, spender, baseSlot)`, verify with `readAllowance` +
sentinel `stateDiff` override under debug step
`"allowanceSlot.computedVerify"`, falling back to the full probe on
mismatch) or the full probe when inference failed. Tokens run in parallel;
within a token the first probe is serial (it seeds inference) and the rest
run in parallel. Called at `discoverRequirements` (~line 85) with
`tokens × spenders`.

### Inference helpers — `src/internal/layout.ts` (27 lines, complete)

`mappingSlot(key, base)`, `allowanceSlotFor(owner, spender, base)`,
`inferAllowanceBaseSlot({probedSlot, owner, spender})` → base 0..64 or
undefined.

### Tests pinning the behavior — `test/requirements.test.ts`

- "infers standard allowance slots after one probe": exactly **1** debug
  event `step === "allowanceSlot.accessList" && phase === "start"` for one
  token × two spenders, and ≥1 `"allowanceSlot.computedVerify"` event.
- "falls back for non-standard allowance slots": exactly **2**
  `allowanceSlot.accessList` start events (NonStandardSlotToken defeats
  inference), amounts still exact.

These counts must hold identically when the logic moves.

## Design (read before implementing)

- **Public input shape stays flat `pairs`** — group by token internally
  (`addressKey`) so no caller changes. Output must preserve **input pair
  order** (map results back by pair index, not push-on-settle) — plan 013's
  determinism rule.
- The per-token orchestration (probe-first → infer → compute+verify rest →
  fallback) moves into a new internal module
  `src/internal/allowanceDiscovery.ts` exporting one function
  `discoverAllowanceSlotsWithInference(args: { client; from; pairs; sentinel; gas?; debug? } & BlockOptions): Promise<(AllowanceSlot | undefined)[]>`
  returning a result per input pair (undefined = undiscoverable). This keeps
  `slots.ts` thin and gives plan 019 a single seam for unresolved reporting.
- `src/slots.ts` `discoverAllowanceSlots` = call it, filter undefined.
- `src/requirements.ts`: replace `discoverAllAllowanceSlots` with a call to
  the **public** `discoverAllowanceSlots` (import from `./slots.js` — the
  public-consumes-public precedent already exists for balance slots there),
  building `pairs` as tokens × spenders minus `token === spender` pairs
  (preserve the existing exclusion). Delete `discoverAllAllowanceSlots`,
  `discoverProbedAllowanceSlot`, `discoverComputedAllowanceSlot`; the
  `readAllowance`/`allowanceSlotFor`/`inferAllowanceBaseSlot` imports move to
  `internal/allowanceDiscovery.ts`.
- Keep ALL debug step names: `allowanceSlot.accessList`,
  `allowanceSlot.verify`, `allowanceSlot.computedVerify`.
- Parallelism contract: tokens parallel; first pair per token serial; rest
  parallel. Identical to today's private path.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 |
| Focused | `pnpm build:contracts && pnpm exec vitest run test/requirements.test.ts test/simulate.test.ts` | all pass |

## Scope

**In scope**: `src/slots.ts`, `src/requirements.ts`,
`src/internal/allowanceDiscovery.ts` (create), `test/simulate.test.ts` (one
new test), `plans/README.md` (status row). `dist/` via `pnpm build` only.

**Out of scope**: `src/internal/probes.ts` and `src/internal/layout.ts`
(consumed as-is), `src/types.ts`, public signatures (input/output shapes
unchanged), `contracts/**`, all existing test assertions.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Create `src/internal/allowanceDiscovery.ts`

Move the per-token orchestration out of `requirements.ts` verbatim-in-spirit
(reuse its current code as the starting point), reshaped to take flat pairs
and return `(AllowanceSlot | undefined)[]` parallel to input. Group pairs by
`addressKey(token)`; within a group, order = input order.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Rewire `src/slots.ts`

`discoverAllowanceSlots` delegates to the new module (sentinel =
`OVERRIDE_TOKEN_AMOUNT`), filters undefined. Signature unchanged.

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts`
→ all pass (the combined balance+allowance override test exercises this).

### Step 3: Rewire `src/requirements.ts` and delete the twin

Build pairs (tokens × spenders, minus token===spender, minus `from` — the
spenders list already excludes `from`), call public
`discoverAllowanceSlots`, delete the three private functions and now-unused
imports.

**Verify**: `pnpm exec vitest run test/requirements.test.ts` → all pass,
**including the two RPC-count assertions unchanged** (1 access list for the
standard token, 2 for the non-standard one).

### Step 4: New test pinning the public fast path

In `test/simulate.test.ts` (or a small new describe there): deploy TestToken
+ two Spenders, call `discoverAllowanceSlots({ client, from, pairs: [{token, spenderA}, {token, spenderB}] })`
directly with a debug collector → expect exactly **1**
`allowanceSlot.accessList` start event, ≥1 `allowanceSlot.computedVerify`,
and 2 returned slots whose computed slot for spenderB equals
`allowanceSlotFor(from, spenderB, base)` implicitly via the sentinel verify
(asserting the 2 slots exist with correct token/spender fields is
sufficient).

**Verify**: focused vitest run → new test passes.

### Step 5: Full gate

**Verify**: `pnpm verify` → exit 0, three consecutive `pnpm exec vitest run`
green (concurrency-touching change; flake bar from plan 013 applies).

## Test plan

Existing RPC-count assertions are the primary regression net (they encode
the exact optimization this plan relocates); one new test (Step 4) pins that
the PUBLIC surface now gets the fast path.

## Done criteria

- [ ] `pnpm verify` exits 0; vitest green 3 consecutive runs
- [ ] `grep -n "discoverAllAllowanceSlots\|discoverProbedAllowanceSlot\|discoverComputedAllowanceSlot" src/` → no matches
- [ ] `grep -n "inferAllowanceBaseSlot" src/requirements.ts` → no matches (lives only behind the internal module now)
- [ ] Existing RPC-count assertions unchanged in `test/requirements.test.ts` (`git diff` shows no edits to those expects)
- [ ] New public fast-path test present and passing
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any RPC-count assertion needs its expected number changed — call counts
  moved; revert and re-read the Design section.
- Preserving input-pair output order conflicts with the grouping — report
  rather than switching to grouped output order.
- Plan 016 not DONE (names in this plan won't match).

## Maintenance notes

- Plan 019 (unresolved-discovery reporting) builds on the
  `(AllowanceSlot | undefined)[]` per-pair return of the new internal module
  — keep that shape.
- The inference window (base 0..64, Solidity layout only) is unchanged;
  extending to Vyper/Solady layouts happens inside
  `internal/allowanceDiscovery.ts` + `layout.ts` only.
