# Plan 032: Group helpers by concern — `sim.balanceQueries.*` and `sim.tokenOverrides.*`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> 1. `grep -n "| 031 |" plans/README.md` → must be `DONE`. If not, STOP —
>    this plan regroups the surface 031 creates (`balanceQueries` namespace,
>    discovery-free simulate).
> 2. `git diff --stat 1878564..HEAD -- src test README.md` → heavy drift
>    from 031 is expected; locate everything by symbol name.

## Status

- **Priority**: P2
- **Effort**: S-M
- **Risk**: LOW-MED (pure surface regrouping; zero behavior change — the suite passes with call-path edits only)
- **Depends on**: plans/031 (must be DONE)
- **Category**: dx (accepted external feedback, 2026-07-03)
- **Planned at**: commit `1878564`, 2026-07-03 (pre-031 — symbol-anchor everything)

## Why this matters

After 031 the instance has a hybrid shape: one namespace
(`balanceQueries.forUser`) beside three flat plan-027 methods
(`prepareBalanceOverrides`, `prepareAllowanceOverrides`,
`estimateAssetRequirements`). With six-plus capabilities, grouping by the
explicit array each helper feeds (`balanceQueries` → the observation input,
`tokenOverrides` → the state-assumption input) makes the API
self-navigating: type `sim.` and the two namespaces mirror the two
`simulate` arguments. Breaking, pre-prod, NO old method names survive
(maintainer instruction: nothing deprecated/redundant).

`tokenOverrides` (not `overrides`) because these helpers are specifically
about token balance/allowance storage — not arbitrary account/code
overrides (feedback point, accepted).

## Current state

(Post-031 expected; verify live.)

`src/txSimulator.ts` interface after 031:

```ts
simulate: (args: SimulateArgs) => Promise<SimulationResult>;
prepareBalanceOverrides: (args: PrepareBalanceOverridesArgs) => Promise<PreparedBalanceOverrides>;
prepareAllowanceOverrides: (args: PrepareAllowanceOverridesArgs) => Promise<PreparedAllowanceOverrides>;
estimateAssetRequirements: (args: EstimateAssetRequirementsArgs) => Promise<EstimatedAssetRequirements>;
readonly balanceQueries: { forUser: (args: ForUserBalanceQueriesArgs) => Promise<BalanceQuery[]> };
```

Implementations live in `src/internal/{slotDiscovery... → slots.ts,
requirements.ts, queryDiscovery.ts}` (031's names authoritative). The
`forUser` pipeline internally derives the observed-token list (access-list
candidates filtered by a balanceOf probe call).

## Target design

```ts
export interface TxSimulator {
  simulate: (args: SimulateArgs) => Promise<SimulationResult>;

  /** Helpers that produce `SimulateArgs.balanceQueries`. */
  readonly balanceQueries: {
    /** Wallet-style: native + discovered ERC-20 queries for `from`. */
    forUser: (args: ForUserBalanceQueriesArgs) => Promise<BalanceQuery[]>;
    /** The discovery half of forUser: ERC-20 addresses the calls plausibly touch (access-list candidates that answer balanceOf). */
    discoverErc20s: (args: ForUserBalanceQueriesArgs) => Promise<Address[]>;
  };

  /** Helpers that produce `SimulateArgs.tokenSlotOverrides`. */
  readonly tokenOverrides: {
    forBalances: (args: PrepareBalanceOverridesArgs) => Promise<PreparedBalanceOverrides>;
    forAllowances: (args: PrepareAllowanceOverridesArgs) => Promise<PreparedAllowanceOverrides>;
    estimateRequirements: (args: EstimateAssetRequirementsArgs) => Promise<EstimatedAssetRequirements>;
  };
}
```

Decisions baked in (do not relitigate):

- The three flat methods are REMOVED, not aliased.
- **Return types keep their full shapes** — `estimateRequirements` returns
  the complete `EstimatedAssetRequirements` (amounts, `slots`,
  `unresolved`, revert variant). The feedback's
  `Promise<TokenSlotOverride[]>` sketch is rejected as lossy: the amounts
  and unresolved data are the point of estimation.
- **Arg types and field names keep their 027 vocabulary** (`from`,
  `pairs`, `tokens`; type names `Prepare*Args`/`Prepared*` etc.) — they
  describe the operation and remain accurate on hover; only method PATHS
  change. The feedback's `{owner, approvals}` shape for `forAllowances` is
  rejected (contradicts the settled `from`/`pairs` naming).
- `discoverErc20s` is extracted from `forUser`'s existing pipeline (shared
  internal function; `forUser` = `discoverErc20s` result → native + per-
  token queries for `from`). The feedback's other two helpers
  (`forErc20s`, `fromAccessList`) are rejected: each is a one-line `.map`
  that doesn't justify API surface — shown as a README snippet instead.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (needs forge/anvil) |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |

## Scope

**In scope**: `src/txSimulator.ts` (interface + create wiring),
`src/internal/queryDiscovery.ts` (export the shared discover function),
`src/types.ts` (JSDoc references to method paths only — no shape changes),
`src/index.ts` (only if type exports change — they shouldn't), all test
files (call-path edits + one new test), `README.md`, `CLAUDE.md` (key
modules / flow mentions), `plans/README.md` (status row).

**Out of scope**: ANY behavior, signature-shape, or return-shape change —
this is method-path regrouping plus one extracted helper. RPC counts and
all assertion values are frozen. `contracts/**`, `src/internal/slots.ts` /
`requirements.ts` bodies (only their txSimulator.ts call paths move).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Regroup the interface + factory

Apply Target design in `src/txSimulator.ts`: nest the three override
methods under `tokenOverrides`, add `discoverErc20s` under
`balanceQueries` (export the underlying function from
`internal/queryDiscovery.ts`; `forUser` reuses it). Delete the flat
methods.

**Verify**: `pnpm typecheck` → errors only in tests (call paths);
`grep -n "prepareBalanceOverrides\|prepareAllowanceOverrides\|estimateAssetRequirements" src/txSimulator.ts` →
matches only inside the `tokenOverrides` namespace's type references (arg/
result type names), no flat interface members.

### Step 2: Update tests

Mechanical path edits (`sim.prepareBalanceOverrides(...)` →
`sim.tokenOverrides.forBalances(...)`, etc.); update the compile-time
`const fake: TxSimulator` mock to the nested shape. Add ONE new test:
`discoverErc20s` on the mint+pull fixture returns exactly the deployed
token's address (exact array), and `forUser` equals
`[native, ...that list mapped to from]` (structural assertion).

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass;
`git diff -- test` shows only call-path edits + the one new test (no
assertion-value changes).

### Step 3: Docs + full gate

README: update every example to the namespaced paths; add the rejected-
helper `.map` snippet
(`tokens.map((asset) => ({ asset, account }))`) where explicit dapp
queries are shown. CLAUDE.md: method list updated.

**Verify**: `pnpm verify` → exit 0;
`grep -c "tokenOverrides\." README.md` → ≥2;
`grep -rn "sim\.prepare\|sim\.estimateAssetRequirements" README.md CLAUDE.md test src` → no matches.

## Test plan

Step 2: path migration with frozen values + the one `discoverErc20s` test.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] Interface has exactly: `simulate`, `balanceQueries.{forUser,discoverErc20s}`, `tokenOverrides.{forBalances,forAllowances,estimateRequirements}` — no flat helper methods
- [ ] `estimateRequirements` returns full `EstimatedAssetRequirements` (`git diff -- src/types.ts` shows no shape changes)
- [ ] Zero old method paths anywhere (`grep` from Step 3)
- [ ] All assertion values unchanged except the one new test
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plan 031 not DONE.
- Any assertion VALUE needs changing — behavior moved; this plan must be
  pure regrouping.
- The nested-namespace shape breaks the compile-time mockability check in
  a way `readonly` object members can't express — report the type error.

## Maintenance notes

- The rule going forward: a new helper joins the namespace matching the
  `simulate` argument it produces; a helper producing neither is a design
  smell to discuss before adding.
- If a third namespace ever appears (e.g. per-call attribution from the
  deferred finding), revisit whether `estimateRequirements` — which returns
  more than overrides — deserves its own group; it lives under
  `tokenOverrides` today because feeding `tokenSlotOverrides` is its
  primary use.
