# Plan 046: Clamp eth_createAccessList gas independently of eth_call gas

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3bce89e..HEAD -- src/internal/rpc.ts src/constants.ts src/index.ts test/errors.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Exception: plan 045's expected edits
> to `createAccessList` (normalizeAddress on from/to) are anticipated drift —
> proceed if that is the only difference.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: execute AFTER plan 045 (both edit `createAccessList` in `src/internal/rpc.ts`)
- **Category**: bug
- **Planned at**: commit `3bce89e`, 2026-07-12

## Why this matters

The single gas default (`DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n`) flows into **every** `eth_createAccessList` request, but major providers cap that method far below their `eth_call` cap: walletchan's empirically documented numbers are that Alchemy mainnet rejects ~30M while accepting ≤ ~10M for `eth_createAccessList`, and they ship separate knobs (10M access-list / 50M batch call) for exactly this reason (see `docs/walletchan-learnings-2026-07-12.md` item 3). Our 16M sits above that ceiling, so `balanceQueries.forUser`, `discoverErc20s`, `estimateRequirements`, and all slot discovery may throw `AccessListUnsupportedError` against Alchemy-class providers even though the simulation `eth_call` itself would succeed. Clamping the gas sent on `eth_createAccessList` — leaving `eth_call` gas untouched — removes the failure without changing any RPC count.

## Current state

- `src/constants.ts:7` — `export const DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n;` (the only two constants in the file; both are exported from the public barrel `src/index.ts`).
- `src/internal/rpc.ts:88-94` — `createAccessList` forwards the caller's gas verbatim:

```ts
const request = {
  from: args.from,
  to: args.to,
  data: args.data,
  ...(args.value !== undefined ? { value: numberToHex(args.value) } : {}),
  ...(args.gas !== undefined ? { gas: numberToHex(args.gas) } : {}),
} satisfies AccessListRpcRequest;
```

- The 16M default is attached in `src/txSimulator.ts:144` (`args.gas ?? bound.gas ?? DEFAULT_SIMULATION_GAS_LIMIT`) and reaches `createAccessList` through `discoverCandidateAddresses` (`src/internal/simulator.ts:205`) and slot discovery (`src/internal/probes.ts:60-69`).
- Debug events on access-list requests expose only `hasGas: args.gas !== undefined` (`src/internal/rpc.ts:104-109`), not the value — tests must capture the raw request via fakeClient instead.
- fakeClient pattern: `test/helpers/fakeClient.ts` + exemplars in `test/errors.test.ts`.
- `pnpm test:mainnet` (opt-in, needs `MAINNET_RPC_URL`) is the home for real-provider verification.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Focused tests | `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts` | all pass |
| Full gate | `pnpm verify` | exit 0 |
| Optional real-provider check | `MAINNET_RPC_URL=<url> pnpm test:mainnet` | all pass |

## Scope

**In scope** (the only files you should modify/create):
- `src/constants.ts`
- `src/index.ts` (export the new constant)
- `src/internal/rpc.ts`
- `test/errors.test.ts`
- `.changeset/<new-file>.md` (create)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `src/txSimulator.ts` / `DEFAULT_SIMULATION_GAS_LIMIT` — the `eth_call` budget is correct as-is; only the access-list method gets clamped.
- Per-method gas knobs on the public API — a clamp at the boundary is the whole fix; do not add config surface.
- `test/mainnet.test.ts` — optional verification only; add nothing there in this plan.

## Git workflow

- Branch: `advisor/046-access-list-gas-clamp`
- Message style: `fix: clamp eth_createAccessList gas to provider-safe ceiling`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the constant

In `src/constants.ts`, add below the existing constants:

```ts
/**
 * Maximum gas attached to `eth_createAccessList` requests.
 *
 * Providers cap this method far below their `eth_call` cap (Alchemy mainnet rejects the default
 * simulation budget while accepting ~10M), so the simulation gas budget is clamped to this ceiling
 * for access-list requests only.
 */
export const ACCESS_LIST_GAS_LIMIT = 10_000_000n;
```

Export it from `src/index.ts` alongside the existing constants (check how `DEFAULT_SIMULATION_GAS_LIMIT` and `OVERRIDE_TOKEN_AMOUNT` are re-exported and match that form exactly).

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Clamp in createAccessList

In `src/internal/rpc.ts`, import `ACCESS_LIST_GAS_LIMIT` from `../constants.js` and clamp inside `createAccessList` before building the request:

```ts
const gas =
  args.gas === undefined ? undefined : args.gas > ACCESS_LIST_GAS_LIMIT ? ACCESS_LIST_GAS_LIMIT : args.gas;
```

Use `gas` (not `args.gas`) in both the request spread and the `hasGas` debug detail. Callers passing an explicit smaller gas keep it; absent gas stays absent (provider default).

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Tests

In `test/errors.test.ts`, add two fakeClient tests exercising `balanceQueries.discoverErc20s` (script `eth_createAccessList` to capture params and return `{ accessList: [] }`; script `eth_call` to return `encodeSimulationResult()`):

1. Default gas: create the simulator without a gas option, assert the captured access-list request has `gas === "0x989680"` (10,000,000).
2. Explicit small gas: create with `gas: 5_000_000n`, assert captured `gas === "0x4c4b40"`.

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts` → all pass, including 2 new tests.

### Step 4: Changeset and index

Patch changeset (`.changeset/access-list-gas-clamp.md`):

```markdown
---
"viem-tx-sim": patch
---

Clamp the gas attached to eth_createAccessList requests to 10M (new exported `ACCESS_LIST_GAS_LIMIT`), below the provider ceilings that rejected the 16M simulation default; eth_call gas is unchanged.
```

Update this plan's row in `plans/README.md`.

**Verify**: `pnpm verify` → exit 0.

## Test plan

- 2 new fakeClient tests pinning the clamped and pass-through gas values on the wire (Step 3).
- Existing suite green unchanged — in particular the pinned RPC-count tests, which this plan must not alter.
- Optional (recommended if `MAINNET_RPC_URL` is available): run `pnpm test:mainnet` against an Alchemy URL to confirm discovery succeeds at the clamped value.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "ACCESS_LIST_GAS_LIMIT" src/constants.ts src/index.ts src/internal/rpc.ts` → declaration, barrel export, clamp use
- [ ] `pnpm verify` exits 0
- [ ] 2 new tests exist and pass; no existing test modified
- [ ] Patch changeset present
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `createAccessList` no longer matches the "Current state" excerpt beyond plan 045's expected normalizeAddress edits.
- Any existing test pins the access-list gas value at 16M (search first: `grep -rn "989680\|16_000_000\|16000000" test/`) — reconcile with the maintainer rather than editing a pinned expectation.
- The clamp would need to apply anywhere other than inside `createAccessList` (a second code path sends `eth_createAccessList`) — that contradicts the single-chokepoint assumption.

## Maintenance notes

- 10M is walletchan's empirically proven Alchemy ceiling, not a spec value. If a provider rejects 10M too, lower the constant — it only bounds discovery probes, which never need the full simulation budget.
- If a caller ever legitimately needs >10M for access-list discovery of a gas-monster call, the observable symptom is discovery returning fewer candidates (the access list comes from a reverted/oog trace normalized to `[]`). That would justify a per-call knob — deferred until observed.
- The debug `hasGas` detail intentionally stays a boolean; the wire value is test-observable via fakeClient.
