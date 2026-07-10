# Plan 039: Classify provider reverts and insufficient-funds errors on structured signals, not exact English substrings

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop,
> revert the code changes, mark this plan BLOCKED with what you found, and
> report — do not adapt tests to make them pass. When done, update the status
> row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8931d7e..HEAD -- src/internal/rpc.ts src/internal/requirements.ts test/errors.test.ts`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — the classifier gates whether a reverting call yields an
  empty access list (benign) or a thrown `AccessListUnsupportedError`
  (feature-disabling). Over-widening could swallow real infrastructure
  failures as "reverts" and silently under-report discovered tokens.
  Mitigation: widen only with a positive revert signal (JSON-RPC code 3 or a
  message containing "revert"), and pin both directions with tests.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8931d7e`, 2026-07-10

## Why this matters

Two behavior-gating decisions currently hinge on exact English strings from
the RPC provider. First, `createAccessList` treats an error as a benign
execution revert (returning an empty access list) only when the message
matches `execution reverted`; any provider that words reverts differently
(Erigon/Besu/Nethermind phrasings, proxies that rephrase, "transaction
reverted") turns a plain revert into a thrown `AccessListUnsupportedError`,
which aborts `balanceQueries.forUser`, `balanceQueries.discoverErc20s`, and
`tokenOverrides.estimateRequirements` entirely. Second,
`estimateRequirements`'s unfunded-wallet fallback matches the exact
capital-I substring `"Insufficient funds"`; geth-style lowercase
"insufficient funds for gas * price + value" misses it and the whole
estimate throws instead of degrading to call-target candidates. This library
is embedded by wallets across arbitrary RPC providers, so provider wording
drift is a first-class bug source, not an edge case.

## Current state

- `src/internal/rpc.ts` — RPC wrappers and error normalization. The two
  classifiers, lines 129–137:

```ts
function isExecutionRevert(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return /execution reverted|Execution reverted/i.test(cause.message);
}

function isRpcExecutionRevert(error: AccessListRpcResult["error"]): boolean {
  const message = typeof error === "string" ? error : error?.message;
  return message !== undefined && /execution reverted|Execution reverted/i.test(message);
}
```

  (Note the two regex alternatives are redundant under the `i` flag.) Their
  call sites are inside `createAccessList`, lines 115–121:

```ts
    if (result.accessList !== undefined) return result.accessList;
    if (isRpcExecutionRevert(result.error)) return [];
    throw new Error(formatRpcError("eth_createAccessList returned no access list", result.error));
  } catch (cause) {
    if (isExecutionRevert(cause)) return [];
    throw new AccessListUnsupportedError(formatRpcError("eth_createAccessList failed", cause));
  }
```

- `src/internal/requirements.ts` — asset-requirement estimation. The
  fallback predicate, lines 152–154:

```ts
function isInsufficientFunds(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("Insufficient funds");
}
```

  and its call site, lines 43–55: `discoverCandidateAddresses` is wrapped in
  try/catch; on `isInsufficientFunds(cause)` the candidates fall back to
  `uniqueAddresses(calls.map((call) => call.to))`, otherwise the error
  rethrows. The error reaching this catch is the `AccessListUnsupportedError`
  built by `formatRpcError`, whose message embeds the original provider
  message (`"eth_createAccessList failed: <provider message>"`), so
  substring matching on the wrapped message still sees the provider text.

- `test/errors.test.ts` — chain-free error-path tests driven through the
  public interface over the scripted-transport `fakeClient`
  (`test/helpers/fakeClient.ts`). Existing pins that must stay green:
  - "treats access-list execution reverts as empty candidate discovery"
    (thrown `Error("execution reverted")` → `forUser` resolves).
  - "treats a result-shaped execution revert as empty candidate discovery"
    (`{ error: { message: "execution reverted" } }` → resolves).
  - "rejects unsupported access-list RPCs with a typed error" (thrown
    "method does not exist" → `AccessListUnsupportedError`).

Repo conventions that apply:
- Tests pin debug-step names and RPC counts as string literals (ADR-0001,
  `docs/adr/0001-debug-step-literals-in-tests.md`). This plan must not add,
  remove, or rename any RPC call or debug step.
- Error-path tests use `fakeClient` responders that return or throw per RPC
  method — model new tests on `test/errors.test.ts:44-55` and `:92-101`.
- `oxlint` forbids `any` (`typescript/no-explicit-any`); use `unknown` plus
  narrowing for the cause-chain walk.

## Commands you will need

| Purpose   | Command                                   | Expected on success |
|-----------|-------------------------------------------|---------------------|
| Install   | `pnpm install`                            | exit 0              |
| Typecheck | `pnpm typecheck`                          | exit 0, no errors   |
| Lint      | `pnpm lint`                               | exit 0              |
| One suite | `pnpm exec vitest run test/errors.test.ts`| all pass            |
| Full gate | `pnpm verify`                             | exit 0 (lint, typecheck, build, tests; requires Foundry + Anvil) |

## Scope

**In scope** (the only files you should modify):
- `src/internal/rpc.ts`
- `src/internal/requirements.ts`
- `test/errors.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `src/internal/simulator.ts` — its `StateOverrideUnsupportedError` wrapping
  is not string-classified; leave it alone.
- `src/errors.ts` — no new error types.
- Debug-step vocabulary (`src/internal/debugSteps.ts`) and any pinned RPC
  count or step name in any test.
- Public exports in `src/index.ts` / `src/types.ts`.

## Git workflow

- Branch: `plan-039-provider-error-classification`
- Commit per step; message style matches `git log` (imperative summary line,
  e.g. "Classify access-list reverts on code-3/revert signals (plan 039)").
- Include a patch changeset (`pnpm changeset`) — this changes behavior for
  consumers on non-geth-worded providers.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the two revert regexes with one structured-first classifier

In `src/internal/rpc.ts`, replace `isExecutionRevert` and
`isRpcExecutionRevert` with logic that classifies an execution revert when
ANY of these hold:

1. Any object in the error's `cause` chain carries JSON-RPC error code `3`
   (the standard `execution reverted` code geth-family nodes return; viem
   preserves it on `RpcRequestError.code`). Walk the chain defensively:

```ts
function hasRevertCode(cause: unknown): boolean {
  for (let c = cause; typeof c === "object" && c !== null; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === 3) return true;
  }
  return false;
}
```

2. The error message (for thrown `Error`s) matches `/revert/i`.
3. For the result-shaped `{ error }` object path (`isRpcExecutionRevert`'s
   role): the string-or-object message matches `/revert/i`, or the error
   object carries `code === 3`.

Keep the two call sites in `createAccessList` (lines 115–121) semantically
identical: classified-revert → `return []`, otherwise the existing throw
paths. Do not add new RPC calls or debug events.

**Verify**: `pnpm typecheck` → exit 0; `pnpm exec vitest run test/errors.test.ts` → all existing tests pass.

### Step 2: Widen the insufficient-funds predicate

In `src/internal/requirements.ts`, change `isInsufficientFunds` to a
case-insensitive match that covers geth and Anvil wordings:

```ts
function isInsufficientFunds(cause: unknown): boolean {
  return cause instanceof Error && /insufficient (funds|balance)/i.test(cause.message);
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Pin the new classification with fakeClient tests

Add to `test/errors.test.ts` (model on the existing fakeClient tests there):

1. **Alternate revert wording**: `eth_createAccessList` throws
   `new Error("transaction reverted")`; `sim.balanceQueries.forUser(...)`
   resolves to `[{ asset: "native", account: from }]` (with `eth_call`
   scripted as `encodeSimulationResult()`).
2. **Structured code-3 signal, non-matching prose**: `eth_createAccessList`
   throws an `Error` whose `cause` chain (or own property) has `code: 3`
   and a message without the word "revert" (e.g.
   `Object.assign(new Error("VM execution error"), { code: 3 })`);
   `forUser` resolves the same way.
3. **Negative control**: `eth_createAccessList` throws
   `new Error("connection refused")` (no code, no "revert");
   `forUser` rejects with `AccessListUnsupportedError`.
4. **Lowercase insufficient funds**: `eth_createAccessList` throws
   `new Error("insufficient funds for gas * price + value")`, `eth_call`
   returns `encodeSimulationResult()`;
   `sim.tokenOverrides.estimateRequirements({ from, calls: [{ to, data: "0x" }] })`
   resolves with `status: "success"`. Additionally assert the fallback
   actually ran: collect debug events via
   `debug: (event) => events.push(event)` and assert some
   `event.step === "txSimulator.simulate"` start event has
   `event.details?.candidates === 1` (the single `call.to` fallback
   candidate).
5. **Unrelated error still rethrows from the estimator**:
   `eth_createAccessList` throws `new Error("connection refused")`;
   `estimateRequirements` rejects with `AccessListUnsupportedError`.

Keep step names as string literals per ADR-0001 — do not import
`DEBUG_STEPS` in tests.

**Verify**: `pnpm exec vitest run test/errors.test.ts` → all pass, including 5 new tests.

### Step 4: Full gate and changeset

Run the full suite and add the changeset.

**Verify**: `pnpm verify` → exit 0. `ls .changeset/*.md` shows a new patch changeset describing the classifier widening.

## Test plan

- New tests: the five listed in Step 3, all in `test/errors.test.ts`, all
  chain-free via `fakeClient`, all driven through the public interface.
- Pattern to follow: `test/errors.test.ts:44-55` ("treats access-list
  execution reverts as empty candidate discovery") and `:92-101`
  (result-shaped variant).
- Verification: `pnpm exec vitest run test/errors.test.ts` → all pass;
  `pnpm verify` → exit 0 with zero changes to any pinned RPC count or
  debug-step assertion in other suites.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm verify` exits 0
- [ ] `grep -n "execution reverted|Execution reverted" src/internal/rpc.ts` returns no matches (the redundant double-alternative regex is gone)
- [ ] `grep -n 'includes("Insufficient funds")' src/internal/requirements.ts` returns no matches
- [ ] `test/errors.test.ts` contains the 5 new tests and they pass
- [ ] A new `.changeset/*.md` patch changeset exists
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts.
- viem's transport/error wrapping strips the `code` property such that test
  2 in Step 3 cannot observe `code: 3` anywhere on the cause chain — report
  the actual error shape you observed instead of loosening the prose match
  further.
- Any pre-existing test (especially the pinned RPC-count/step assertions in
  `test/simulate.test.ts` / `test/requirements.test.ts`) fails after your
  change.
- The fix appears to require touching `src/internal/simulator.ts` or
  `src/errors.ts`.

## Maintenance notes

- Any future RPC method wrapper added to `rpc.ts` should reuse this
  classifier rather than growing its own string match (the module header
  comment already says new RPC methods go here for consistent error
  behavior).
- Reviewer should scrutinize the negative control: an infrastructure error
  must still throw `AccessListUnsupportedError` — the danger of this change
  is silent over-classification, which under-reports discovered assets in
  wallet previews.
- Deliberately deferred: sanitizing/length-capping provider text embedded in
  thrown error messages (audit finding SECURITY-04) — a docs note ships in
  plan 041 instead.
