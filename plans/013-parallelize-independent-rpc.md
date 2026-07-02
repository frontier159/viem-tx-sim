# Plan 013: Parallelize independent RPC calls in discovery and slot probing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7f94c6f..HEAD -- src/internal/discovery.ts src/slots.ts src/requirements.ts`
> Plans 009 and 012 are expected to land first and touch
> `src/requirements.ts`. Re-locate excerpts by symbol name; STOP only if a
> named symbol no longer exists.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (concurrency semantics; result ORDER must stay deterministic)
- **Depends on**: plans/012 (parallelize the consolidated code, not the duplicate it deletes); plans/009 (same file)
- **Category**: perf
- **Planned at**: commit `7f94c6f`, 2026-07-02

## Why this matters

The unit of cost in this library is the RPC round-trip, and today every
independent round-trip runs serially: one access list per batch call
(`discoverCandidateAddresses`), one balance-slot probe per token
(`discoverBalanceSlots`), one allowance-slot chain per token
(`discoverAllAllowanceSlots`). For a wallet previewing a 3-call batch touching
4 tokens, wall-clock latency is the *sum* of a dozen network round-trips when
most could overlap. Parallelizing the independent ones cuts preview latency
roughly by the width of the widest loop, with no change in the number of
calls (the RPC-count debug assertions in tests must still pass exactly).

**What is and is not independent** (this is the plan's core correctness
content):

- Per-call access lists in `discoverCandidateAddresses` — independent.
- Per-token `discoverBalanceSlot` — independent across tokens.
- Per-pair `discoverAllowanceSlot` in the public `discoverAllowanceSlots`
  (`src/slots.ts`) — independent across pairs.
- In `discoverAllAllowanceSlots` (`src/requirements.ts`): **tokens are
  independent of each other**, but WITHIN a token there is a sequential
  dependency — the first spender's probed slot seeds base-slot inference for
  the remaining spenders. Keep the first probe serial per token; the
  remaining spenders' computed-verify calls are then independent of each
  other. Parallelize across tokens, and across the non-first spenders within
  a token.
- Inside `discoverBalanceSlot`/`discoverAllowanceSlot` (probes.ts), the
  verify loop over candidate storage keys usually has 1 key — leave it
  serial (out of scope).

## Current state

(At `7f94c6f`; function bodies may have moved after 009/012.)

`src/internal/discovery.ts:20-35` — serial per-call loop:

```ts
for (const call of args.calls) {
  candidates.push(call.to);
  const accessList = await createAccessList({ /* per-call */ });
  for (const entry of accessList) candidates.push(entry.address);
}
return uniqueAddresses(candidates);
```

`src/slots.ts` — `discoverBalanceSlots` and `discoverAllowanceSlots` each
`await` inside a `for` loop, pushing non-undefined results in input order.

`src/requirements.ts` — `discoverAllAllowanceSlots`:

```ts
for (const token of args.tokens) {
  let baseSlot: bigint | undefined;
  let triedBaseInference = false;
  for (const spender of args.spenders) {
    if (addressKey(token) === addressKey(spender)) continue;
    const slot =
      triedBaseInference && baseSlot !== undefined
        ? await discoverComputedAllowanceSlot({ ...args, token, spender, baseSlot })
        : await discoverProbedAllowanceSlot({ ...args, token, spender });
    if (!triedBaseInference) {
      triedBaseInference = true;
      if (slot !== undefined) {
        baseSlot = inferAllowanceBaseSlot({ probedSlot: slot.slot, owner: args.from, spender });
      }
    }
    if (slot !== undefined) slots.push(slot);
  }
}
```

**Determinism requirement**: callers receive arrays; tests assert with
`arrayContaining` but exactness elsewhere relies on input ordering (e.g.
`probeData.candidates` ordering feeds checkpoint strides). All parallelized
collectors must preserve **input order** in their output (map to promises,
`Promise.all`, then filter) — never push-on-settle.

**Failure semantics**: today a thrown error from one iteration aborts the
whole loop; `Promise.all` preserves that (first rejection wins). Probes
swallow their own errors and resolve `undefined`, so rejections are already
rare. Do NOT switch to `Promise.allSettled` — that would silently change
error semantics.

Debug-event note: `test/requirements.test.ts` asserts exact *counts* of
`allowanceSlot.accessList` / presence of `allowanceSlot.computedVerify`
events, not their order. Counts must not change; interleaved ordering is fine.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | all pass (needs anvil/forge) |
| Focused | `pnpm build:contracts && pnpm exec vitest run test/requirements.test.ts test/simulate.test.ts` | all pass |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope**:

- `src/internal/discovery.ts`
- `src/slots.ts`
- `src/requirements.ts` (`discoverAllAllowanceSlots` only)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/internal/probes.ts` inner verify loops.
- Any batching/JSON-RPC-batch transport work — transport is the caller's.
- Concurrency limits/chunking — deliberately deferred (see maintenance
  notes); plain `Promise.all` is the whole change.
- All test files — assertions must pass unmodified.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: `discoverCandidateAddresses`

Map calls to `createAccessList` promises, `Promise.all`, then build
`candidates` in input order (`call.to` then that call's entries, per call).

**Verify**: `pnpm typecheck`; `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts`
→ all pass (including the debug-event assertions).

### Step 2: `src/slots.ts` both functions

`args.tokens.map(...)` / `args.pairs.map(...)` → `Promise.all` → filter
`undefined`, preserving input order.

**Verify**: `pnpm exec vitest run test/simulate.test.ts` → passes (the
view-only balance-override tests exercise these).

### Step 3: `discoverAllAllowanceSlots`

Restructure per the independence analysis:

```ts
const perToken = await Promise.all(args.tokens.map(async (token) => {
  const spenders = args.spenders.filter((s) => addressKey(token) !== addressKey(s));
  const [first, ...rest] = spenders;
  if (first === undefined) return [];

  const firstSlot = await discoverProbedAllowanceSlot({ ...args, token, spender: first });
  const baseSlot = firstSlot !== undefined
    ? inferAllowanceBaseSlot({ probedSlot: firstSlot.slot, owner: args.from, spender: first })
    : undefined;

  const restSlots = await Promise.all(rest.map((spender) =>
    baseSlot !== undefined
      ? discoverComputedAllowanceSlot({ ...args, token, spender, baseSlot })
      : discoverProbedAllowanceSlot({ ...args, token, spender }),
  ));
  return [firstSlot, ...restSlots].filter((s) => s !== undefined);
}));
return perToken.flat();
```

This preserves: first-probe-seeds-inference, per-pair fallback inside
`discoverComputedAllowanceSlot` (unchanged), input ordering of the flattened
result (token-major, spender order within token) — identical to today's
serial output order.

**Verify**: `pnpm exec vitest run test/requirements.test.ts` → all pass,
including "infers standard allowance slots after one probe" (exactly 1
`allowanceSlot.accessList` start event) and "falls back for non-standard
allowance slots" (exactly 2).

### Step 4: Full gate

**Verify**: `pnpm lint && pnpm typecheck && pnpm test` → all green. Run
`pnpm test` twice more — concurrency bugs are flaky bugs; three consecutive
green runs is the bar.

## Test plan

No new tests; the existing suite pins call counts and exact amounts, which is
precisely what must survive. Triple-run for flake detection (Step 4).

## Done criteria

- [ ] `pnpm typecheck`, `pnpm lint` exit 0; `pnpm test` passes 3 consecutive runs
- [ ] `grep -c "Promise.all" src/internal/discovery.ts src/slots.ts src/requirements.ts` → ≥1 each
- [ ] No `Promise.allSettled` introduced (`grep -rn allSettled src/` → none)
- [ ] `git diff --stat -- test/` → empty
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any RPC-count debug assertion fails — you changed how many calls happen,
  not just when; revert and re-read the independence analysis.
- Tests get flaky under parallelism against anvil (intermittent failures in
  the 3-run gate) — report the failing test and revert rather than adding
  retries or serialization hacks.
- The requirements.ts structure post-009/012 no longer matches the sketch and
  the independence boundaries are unclear — report rather than guessing which
  awaits are safe to overlap.

## Maintenance notes

- Concurrency is unbounded by design (widths are small: calls per batch,
  tokens per tx). If someone feeds 100-token batches and rate-limited public
  RPCs start 429ing, add a small `mapWithConcurrency(n, ...)` helper then —
  don't pre-build it.
- Reviewer should scrutinize ordering: every `Promise.all` result must be
  consumed in input order; any push-on-settle pattern is a defect even if
  tests pass.
