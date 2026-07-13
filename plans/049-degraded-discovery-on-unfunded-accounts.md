# Plan 049: Degrade balance-query discovery gracefully for unfunded accounts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3bce89e..HEAD -- src/internal/rpc.ts src/internal/requirements.ts src/internal/queryDiscovery.ts src/txSimulator.ts test/errors.test.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Exception: plans 045/046's expected
> edits to `rpc.ts` (normalizeAddress, access-list gas clamp) are anticipated
> drift — proceed if those are the only differences there.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (deliberately relaxes a typed-error path for one classified cause)
- **Depends on**: execute AFTER plans 045 and 046 (all three touch `src/internal/rpc.ts`)
- **Category**: bug
- **Planned at**: commit `3bce89e`, 2026-07-12

## Why this matters

Some providers reject `eth_createAccessList` outright when `from` has zero ETH (walletchan observed this on Alchemy; see `docs/walletchan-learnings-2026-07-12.md` item 6). Today that rejection makes `balanceQueries.forUser` and `discoverErc20s` throw `AccessListUnsupportedError` and produce **nothing** — even though a candidate set of just the call targets would still catch direct token transfers. This hits the flagship view-only/unfunded-account use case. `estimateRequirements` already degrades on exactly this signal (`requirements.ts:52-55`, falling back to direct call targets); this plan extends the same classified, deliberate fallback to the discovery helpers — it does NOT copy walletchan's catch-everything-and-warn behavior. The invariant "infrastructure failures throw typed errors" is preserved for every other rejection cause; insufficient-funds is reclassified as a recoverable, expected condition (the account's state, not the infrastructure), consistent with the estimator's precedent.

Not silent: the failing access-list request already emits a `phase: "error"` debug event through `withRpcDebug` before the fallback engages, and the JSDoc/README will document the degradation explicitly.

## Current state

- `src/internal/requirements.ts:42-55` — the existing precedent:

```ts
let candidateAddresses: Address[];
try {
  candidateAddresses = await discoverCandidateAddresses({ ... });
} catch (cause) {
  if (!isInsufficientFunds(cause)) throw cause;
  candidateAddresses = uniqueAddresses(calls.map((call) => call.to));
}
```

and the private predicate at `requirements.ts:152-154`:

```ts
function isInsufficientFunds(cause: unknown): boolean {
  return cause instanceof Error && /insufficient (funds|balance)/i.test(cause.message);
}
```

- `src/internal/queryDiscovery.ts:22-50` — `discoverErc20s` calls `discoverCandidateAddresses` with no fallback (lines 30-37), then the token-filter `runSimulator` call; `forUserBalanceQueries` (lines 10-19) delegates to `discoverErc20s`, so one fix covers both.
- `src/internal/rpc.ts` — home of shared RPC classification (`isExecutionRevert`, `hasRevertCode` at lines 130-146); the file header says new RPC classification belongs here.
- Negative-control precedent: `test/errors.test.ts` already has tests asserting that a "connection refused" access-list failure throws `AccessListUnsupportedError` from both `forUser` and `estimateRequirements`, and a test asserting the estimator's lowercase insufficient-funds fallback runs (added by plan 039) — find them by grepping the file for `insufficient` and `connection refused`.
- README has a Known-limitations section documenting discovery behavior (grep for "Known limitations").

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Focused tests | `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts` | all pass |
| Full gate | `pnpm verify` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `src/internal/rpc.ts` (shared predicate moves here)
- `src/internal/requirements.ts` (imports the shared predicate; local copy deleted)
- `src/internal/queryDiscovery.ts` (the fallback)
- `src/txSimulator.ts` (JSDoc on `forUser`/`discoverErc20s` only)
- `README.md` (one Known-limitations line)
- `test/errors.test.ts`
- `.changeset/<new-file>.md` (create)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- Any broader catch (provider rejections other than the insufficient-funds classification must keep throwing `AccessListUnsupportedError`) — widening the predicate is a maintainer decision, not an executor improvisation.
- Return-shape changes (`discoverErc20s` stays `Promise<Address[]>`; `forUser` stays `Promise<BalanceQuery[]>`); no "degraded" marker field — the debug event + docs are the surfacing mechanism, per the maintainer decision recorded here.
- `src/internal/simulator.ts` (`discoverCandidateAddresses` itself stays throw-on-failure; the fallback lives in its callers, keeping slot discovery's behavior unchanged).

## Git workflow

- Branch: `advisor/049-degraded-discovery-unfunded`
- Message style: `fix: degrade discovery to call targets on insufficient-funds access-list rejections`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Share the predicate

Move `isInsufficientFunds` from `src/internal/requirements.ts:152-154` to `src/internal/rpc.ts` (exported, verbatim body, placed near the other classifiers around line 130, with a one-line comment noting it classifies account state rather than infrastructure). Update `requirements.ts` to import it; delete the local copy.

**Verify**: `pnpm typecheck` → exit 0; `grep -n "isInsufficientFunds" src/internal/requirements.ts` → import + 1 use, no function definition.

### Step 2: Add the fallback to discovery

In `src/internal/queryDiscovery.ts`, wrap the `discoverCandidateAddresses` call in `discoverErc20s` with the same try/catch shape as `requirements.ts:42-55`: on `isInsufficientFunds(cause)`, fall back to `uniqueAddresses(calls.map((call) => call.to))` (import `uniqueAddresses` from `./data.js`); rethrow anything else. Do not touch the subsequent token-filter call.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Document

- `src/txSimulator.ts`: extend the `forUser` and `discoverErc20s` JSDoc (lines 63-85) with one sentence each: when the provider rejects access lists because `from` cannot fund the calls, discovery degrades to the direct call targets (direct transfers still discovered; intermediary tokens may be missed).
- `README.md`: add one matching line to the Known-limitations discovery bullet.

**Verify**: `pnpm lint` → exit 0.

### Step 4: Tests

In `test/errors.test.ts` (model on the plan-039 tests found in "Current state"):

1. **Degradation**: `eth_createAccessList` responder throws `new Error("insufficient funds for gas * price + value")`; `eth_call` responder returns `encodeSimulationResult({ observedTokens: [<the call target>] })`. `discoverErc20s({ from, calls: [{ to: target, data: "0x" }] })` resolves to `[target]` (checksummed). Assert also that a debug callback captured a `phase: "error"` event for the access-list step (the not-silent guarantee).
2. **forUser inherits**: same scripting; `forUser` resolves to `[native query, token query]`.
3. **Negative control intact**: confirm the existing "connection refused" → `AccessListUnsupportedError` tests still pass unchanged (do not weaken them; if one asserts `forUser` throws on insufficient-funds specifically, that expectation flips — see STOP conditions).

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts` → all pass.

### Step 5: Changeset and index

Patch changeset (`.changeset/degraded-discovery-unfunded.md`):

```markdown
---
"viem-tx-sim": patch
---

`balanceQueries.forUser`/`discoverErc20s` now degrade to direct call-target candidates when the provider rejects eth_createAccessList for an unfunded `from` (matching `estimateRequirements`'s existing fallback) instead of throwing `AccessListUnsupportedError`.
```

Update this plan's row in `plans/README.md`.

**Verify**: `pnpm verify` → exit 0.

## Test plan

- New: degradation resolves with call-target tokens + debug error event observed (Test 1); `forUser` composes on top (Test 2).
- Existing negative controls ("connection refused" throws typed) pass unchanged.
- Existing estimator fallback tests pass unchanged (the predicate move is behavior-neutral).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "isInsufficientFunds" src/internal/rpc.ts src/internal/requirements.ts src/internal/queryDiscovery.ts` → one exported definition (rpc.ts), two importing users
- [ ] `pnpm verify` exits 0; 2 new tests pass; no existing test weakened
- [ ] README + JSDoc lines present (`grep -in "degrade" src/txSimulator.ts README.md` → ≥1 each)
- [ ] Patch changeset present
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- An existing test explicitly asserts that `forUser`/`discoverErc20s` throw on an insufficient-funds message (the expectation this plan flips) — surface it for maintainer confirmation before editing a pinned expectation.
- The `requirements.ts` fallback excerpt no longer matches (plan 039's shape changed).
- Making Test 1 pass requires widening the predicate beyond `/insufficient (funds|balance)/i` — provider-prose drift is plan-039 territory; report the observed message instead of editing the regex.

## Maintenance notes

- The predicate is now the single classification point for "account can't fund it" across estimator and discovery; future provider-wording drift gets fixed once in `rpc.ts`.
- If a partial-result marker is ever wanted (API change), the seam is `discoverErc20s`'s return type; the deliberate decision here was debug-event + docs over an API change — revisit only with consumer demand.
- Candidates from the fallback are call targets only: tokens touched *indirectly* (router pulls) are missed. That's inherent to the degraded mode and documented; the fix for those callers is funding the account or supplying explicit `balanceQueries`.
