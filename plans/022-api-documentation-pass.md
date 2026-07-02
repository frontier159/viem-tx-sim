# Plan 022: API documentation pass — JSDoc on the full public surface, exported defaults, error guidance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0031a..HEAD -- src README.md CLAUDE.md`
> This plan runs LAST in the 016-022 wave and documents whatever surface
> actually landed. Heavy drift from 016-021 is expected and fine — write
> JSDoc from the live code, never from this plan's assumptions. STOP only if
> a plan 016-021 is still IN PROGRESS (check `plans/README.md`).

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (documentation + two constant exports; one small dedup)
- **Depends on**: plans/016-021 (documents their final surface)
- **Category**: dx + docs
- **Planned at**: commit `ed0031a`, 2026-07-02

## Why this matters

Consumers integrate this library from their editor: hover types, autocomplete,
and `@throws` hints are the real documentation surface, and today it is
nearly empty — `simulate()` and `discoverRequirements()` have no JSDoc at
all, most types in `src/types.ts` have at most one field comment, and the
error classes don't say when they're thrown or whether switching RPC
providers helps. Two operational defaults are also undiscoverable: the 16M
simulation gas limit is a *private const duplicated in two files*, and the
10^50 forge amount lives in `src/internal/hex.ts` — a consumer who wants to
raise gas for a deep call or reason about forged amounts has to read source.
Finally, `blockNumber`-beats-`blockTag` precedence is enforced in
`blockOptionsSpread` but stated nowhere a consumer can see.

## Current state

(At `ed0031a`; the 016-021 wave will have changed shapes — document the live
code.)

- `DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n` defined privately in BOTH
  `src/simulate.ts` and `src/requirements.ts` (duplicate constants).
- `OVERRIDE_TOKEN_AMOUNT = 10n ** 50n` in `src/internal/hex.ts`, not
  exported publicly. Design rationale (from CLAUDE.md): deliberately NOT
  `type(uint256).max` so standard ERC-20 allowance decrements still fire
  during measurement.
- `src/types.ts`: `TokenSlotOverride.amount` has the only substantive field
  JSDoc ("Defaults to 10^50"); `SimulateArgs`, `SimulatedCall`,
  `AssetBalanceDelta`, debug types, slot types have none or one-liners.
- `src/errors.ts` (25 lines): four classes, default messages, zero JSDoc.
  When thrown: `InvalidSimulationInputError` — empty `calls` (caller bug,
  don't retry); `AccessListUnsupportedError` — `eth_createAccessList`
  missing/failed non-revert (provider capability — try another RPC);
  `StateOverrideUnsupportedError` — `eth_call` with state overrides failed
  OR returned undecodable output (provider capability). Note:
  `createAccessList` deliberately returns `[]` (not an error) for
  execution-revert responses.
- `src/internal/rpc.ts` `blockOptionsSpread`: `blockNumber` wins over
  `blockTag` when both are set.
- Public functions: `simulate` (`src/simulate.ts`), `discoverBalanceSlots` /
  `discoverAllowanceSlots` (`src/slots.ts`, one-line JSDoc each),
  `discoverRequirements` (`src/requirements.ts`), and post-021
  `TxSimulator` interface + `create` (`src/txSimulator.ts`).
- README and CLAUDE.md exist and are current per the 016-021 wave; this plan
  syncs only where the constants/exports below change what they should say.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 |
| Typecheck only | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: `src/types.ts`, `src/errors.ts`, `src/simulate.ts`,
`src/slots.ts`, `src/requirements.ts`, `src/txSimulator.ts`,
`src/index.ts`, `src/internal/hex.ts` (JSDoc on the constant only),
`src/internal/rpc.ts` (JSDoc on `blockOptionsSpread` only), `README.md`
(constants mention), `CLAUDE.md` (one invariant line), `plans/README.md`
(status row). `dist/` via build.

**Out of scope**: any runtime behavior change except the single-constant
dedup in Step 1; test files (must pass untouched); generated docs tooling
(no typedoc/docusaurus — hover JSDoc is the deliverable).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Single-source and export the two defaults

1. Create the constant once: move `DEFAULT_SIMULATION_GAS_LIMIT` into
   `src/types.ts`? No — types.ts is types-only by convention. Put both
   public constants in a new tiny `src/constants.ts`:

```ts
/** Gas budget for the simulation eth_call. Generous because ... (JSDoc per Step 2 standards). */
export const DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n;
/** Default forged balance/allowance. Deliberately not uint256-max: standard ERC-20s skip the allowance decrement at exactly max, which would blind discoverRequirements' measurements. */
export const OVERRIDE_TOKEN_AMOUNT = 10n ** 50n;
```

2. `src/internal/hex.ts` re-exports or imports from it (keep internal import
   paths working — simplest: hex.ts imports and re-exports; internal callers
   unchanged). `simulate.ts` and `requirements.ts` import the gas constant
   (deleting both private copies).
3. Export both from `src/index.ts`.

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "16_000_000" src/ | grep -v constants.ts` → no matches;
`grep -rn "10n \*\* 50n" src/ | grep -v constants.ts` → no matches.

### Step 2: JSDoc the functions

Standard per function: one-sentence summary; behavior notes a consumer needs
(what is/isn't forged, what an empty result means, RPC cost shape);
`@throws` for each typed error it can raise; a compact `@example` on
`simulate` and `TxSimulator.create` only. Cover: `simulate`,
`discoverBalanceSlots`, `discoverAllowanceSlots`, `discoverRequirements`,
`TxSimulator` interface + `create`. State on the discovery functions that
unresolved entries are reported, not thrown (post-019), and on
`discoverRequirements` the pad-the-amounts guidance (already in README —
compress to two lines).

**Verify**: `pnpm lint` → exit 0; hover-check spot verification is manual —
instead machine-check presence:
`grep -B3 "export async function\|export function\|export interface\|export const TxSimulator" src/*.ts | grep -c "\*/"` → one closing JSDoc per export (report the count).

### Step 3: JSDoc the types and errors

- Every exported type in `src/types.ts` gets a type-level comment; fields
  whose meaning isn't self-evident get field comments — REQUIRED ones:
  `SimulateArgs.blockNumber`/`blockTag` ("if both are set, `blockNumber`
  wins"), `gas` ("defaults to `DEFAULT_SIMULATION_GAS_LIMIT`"),
  `TokenSlotOverride.amount` ("defaults to `OVERRIDE_TOKEN_AMOUNT`" —
  replace the raw 10^50 mention), the discriminated-union variants
  (success/reverted semantics), `unresolved` fields (what a wallet should do
  with them).
- `src/errors.ts`: each class gets when-thrown + recovery guidance JSDoc per
  the Current state table above.
- `blockOptionsSpread` in `src/internal/rpc.ts` gets the precedence comment.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0;
`grep -c "/\*\*" src/types.ts` → ≥ number of exported types (report both
numbers); `grep -c "/\*\*" src/errors.ts` → ≥4.

### Step 4: README + CLAUDE.md sync

- README: in "Getting started" or "Forging" (wherever gas/amount are first
  relevant), mention both constants are importable; ensure the 16M and 10^50
  prose mentions reference the constant names.
- CLAUDE.md: add the audit-confirmed layering invariant if not present:
  "internal modules never import from public modules; public modules may
  import internal and each other."

**Verify**: `grep -n "DEFAULT_SIMULATION_GAS_LIMIT" README.md` → ≥1;
`pnpm verify` → exit 0.

## Test plan

No new tests; Step 1's constant dedup is behavior-neutral (same value) and
covered by the existing suite. All existing tests must pass untouched.

## Done criteria

- [ ] `pnpm verify` exits 0; `git diff --stat -- test/` → empty
- [ ] `src/constants.ts` exists; both constants exported from package root (`node -e` import check on `dist/index.js` shows both)
- [ ] No duplicate gas-limit constants (`grep -rn "16_000_000" src/ | grep -v constants.ts` → none)
- [ ] Every export in `index.ts` resolves to a declaration with JSDoc (spot-check counts from Steps 2-3 reported)
- [ ] Error classes document when-thrown and recovery
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any plan 016-021 is IN PROGRESS (surface still moving — docs would rot on
  arrival).
- Deduping the gas constant changes an actual value (the two copies drifted)
  — report which value is intended rather than picking.
- JSDoc for a behavior contradicts what the code does — the code wins;
  report the discrepancy (it may be a real bug) and document the code's
  behavior.

## Maintenance notes

- JSDoc rots at the same speed as README — the review rule from CLAUDE.md
  applies: surface changes update their JSDoc in the same PR.
- If the package later wants published API docs, typedoc over this JSDoc is
  the zero-marginal-cost path; that's why hover-docs are the canonical
  source.
