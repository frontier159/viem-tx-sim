# Plan 031: Explicit balance queries — discovery-free simulate() observing arbitrary accounts with before/after deltas

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1878564..HEAD -- src test contracts README.md CLAUDE.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED-HIGH (contract + public-result redesign; mitigated by exact-value tests rewritten alongside)
- **Depends on**: none (001-030 DONE); plans/032 (namespace regrouping) depends on THIS
- **Category**: dx + direction (accepted external feedback, 2026-07-03; see plans/README.md for the accepted/rejected breakdown)
- **Planned at**: commit `1878564`, 2026-07-03

## Why this matters

Today `simulate()` can only observe the `from` account's balances, and it
discovers *which* tokens to observe via hidden `eth_createAccessList` calls
it always runs. Two consequences:

1. **Dapp quote-refinement is impossible**: a caller simulating a partial
   bundle cannot read the leftover flash-token balance at a plugin/router
   address — the contract hardcodes `balanceOf(address(this))`.
2. **Discovery is hidden magic with a hidden dependency**: a caller who
   already knows its assets still pays N access-list RPCs, and `simulate()`
   hard-fails on providers without `eth_createAccessList`.

After this plan (breaking, pre-prod, NO deprecated remains):

- `simulate()` requires `balanceQueries: readonly BalanceQuery[]` — explicit
  `{asset, account}` pairs, any account — and runs **zero access lists**:
  one `eth_call` total, on any state-override-capable provider.
- Results mirror the queries 1:1 with `{before, after, delta}` per query
  (`before` = state after `tokenSlotOverrides` are applied); un-probeable
  queries are reported in `unresolved` (the plan-019 convention).
- The wallet path becomes explicit composition:
  `const balanceQueries = await sim.balanceQueries.forUser({ from, calls })`
  then `sim.simulate({ from, calls, balanceQueries })` — the discovery
  pipeline moves into that helper.

This completes the repo's explicitness arc (006 removed auto-forging, 026
required `amount`, this removes auto-observation).

## Current state

(All at `1878564`.)

### Contract — `contracts/TxSimulator.sol`

`simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes)`
snapshots `_tryBalanceOf(candidates[i], address(this))` before/after
(`_snapshotTokens`, `_writeTokenResults`), tracks per-call min balances for
`maxTokenOutflows`, and records allowance checkpoints. Result struct fields:
`success, failingCallIndex, revertData, nativeDelta, observedTokens,
deltaTokens, tokenDeltas, maxTokenOutflows, maxNativeOutflow,
allowanceCheckpoints`. Helpers to reuse: `_tryBalanceOf(token, owner)`
(note: it already takes an arbitrary `owner`), `_signedDelta`, `_trim*`.

### TS core

- `src/txSimulator.ts` — interface `TxSimulator` (methods: `simulate`,
  `prepareBalanceOverrides`, `prepareAllowanceOverrides`,
  `estimateAssetRequirements`), companion `TxSimulator.create()`, and the
  module-private `runSimulate(args: SimulateArgs & ClientArgs)` which calls
  `discoverCandidateAddresses` (access lists) then `runSimulator`.
- `src/internal/simulator.ts` — `runSimulator({calls, candidates,
  tokenSlotOverrides?, allowanceProbes?, errorAbi?, ...})` decodes the tuple
  and returns `SimulationResult & { probeData }`; builds
  `assetBalanceDeltas` from `deltaTokens`/`nativeDelta` (non-zero only).
- `src/internal/requirements.ts` — `discoverRequirements` uses candidates +
  allowance probes; **unchanged in observable behavior** by this plan (its
  runSimulator calls pass no balance probes).
- `src/types.ts` — `SimulateArgs` (with optional `tokenSlotOverrides` —
  stays optional; maintainer decision), `AssetBalanceDelta` (DELETED by
  this plan), `SimulationSuccess`/`SimulationReverted` (discriminated —
  shape preserved, delta fields replaced).
- Errors: `AccessListUnsupportedError` currently reachable from
  `simulate()`; after this plan only discovery helpers can raise it.

### Tests that change (this is a behavior redesign — unlike refactor plans, RPC-count and result assertions here change BY DESIGN)

- `test/simulate.test.ts` — every `sim.simulate` call gains
  `balanceQueries`; delta assertions move from `assetBalanceDeltas`
  (non-zero, `{asset, delta}`) to `balanceDeltas` (query-mirrored,
  `{asset, account, before, after, delta}`); debug assertions: `simulate`
  now emits ZERO `candidateDiscovery.accessList` events and exactly one
  `txSimulator.simulate` eth_call.
- `test/errors.test.ts` — "access list unsupported" and
  "access-list-revert tolerated" tests re-target `balanceQueries.forUser`
  (simulate no longer performs discovery); "empty calls",
  state-override, and undecodable-output tests stay on `simulate` (now with
  `balanceQueries: []`).
- `test/txSimulator.test.ts` — instance tests updated; the compile-time
  mock check gains the new member.
- `test/requirements.test.ts` — call-shape only if any (estimate path
  unchanged).
- `test/mainnet.test.ts` — becomes SIMPLER: explicit
  `balanceQueries: [{asset: USDC, account}]`, no access-list dependency for
  the simulate itself.

## Target design

### Types (`src/types.ts`)

```ts
/** One balance to observe during simulation. `asset` is "native" or an ERC-20 address. */
export type BalanceQuery = {
  asset: "native" | Address;
  /** Account whose balance is observed — any address, not just `from`. */
  account: Address;
};

/**
 * Balance observation for one query. `before` is the balance AFTER
 * tokenSlotOverrides are applied — deltas describe what the simulated calls
 * changed under the supplied state assumptions, not real-wallet changes.
 */
export type BalanceDelta = {
  asset: "native" | Address;
  account: Address;
  before: bigint;
  after: bigint;
  delta: bigint;
};
```

- `SimulateArgs`: `balanceQueries: readonly BalanceQuery[]` (REQUIRED —
  empty array is legal and means "execute only"); `tokenSlotOverrides`
  stays optional; everything else unchanged.
- `SimulationSuccess` = `{ status: "success"; balanceDeltas: readonly BalanceDelta[]; unresolved: readonly BalanceQuery[] }`.
  `SimulationReverted` = same two fields + the existing revert fields
  (`revertData`, `revertReason?`, `revertError?`, `revertSelector?`,
  `failingCallIndex`) — deltas on revert reflect the executed prefix, as
  today. `AssetBalanceDelta` deleted; export `BalanceQuery`, `BalanceDelta`.
- Rejected shapes (recorded in plans/README.md — do not implement):
  `{kind: "erc20"}` asset objects, required `tokenSlotOverrides`, a
  `diagnostics` field on results, an `error` wrapper object, required
  `value` on calls.

### Contract (`contracts/TxSimulator.sol`)

```solidity
struct BalanceProbe {
    address token;   // address(0) = native balance
    address account;
}
```

- `simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes, BalanceProbe[] balanceProbes)`.
- Result struct appends: `uint256[] balanceBefore; uint256[] balanceAfter; bool[] balanceProbeOk;`
  (parallel to `balanceProbes`).
- Semantics: before-snapshot each probe prior to executing calls
  (`token == address(0)` → `account.balance`, else
  `_tryBalanceOf(token, account)`); after-snapshot at the end (regardless
  of a mid-batch revert — matching the existing after-balance loop).
  `ok = false` iff the ERC-20 staticcall failed on EITHER snapshot (native
  is always ok). Guard the loops with `balanceProbes.length > 0` like the
  allowance-probe loops.
- The existing candidates/allowance machinery is untouched — requirements
  estimation still uses it; the public `simulate` will simply pass empty
  `candidates`. **Safety of `candidates: []` (verified 2026-07-03)**: every
  `candidates` usage in the contract is observation-only — `_snapshotTokens`,
  `_updateMinBalances`, `_writeTokenResults`, all length-bounded loops that
  no-op on empty; execution (`_executeCall`) and native tracking never read
  them. Executor: re-confirm with `grep -n "candidates" contracts/TxSimulator.sol`
  — if any hit falls OUTSIDE those three functions plus signatures/
  forwarding, STOP. Side effect worth noting in your report: empty
  candidates removes the O(calls × candidates) per-call staticcall loop
  from the public simulate path — a gas reduction, not a risk.
- **Override/observation decoupling (behavior change to document)**:
  pre-031, override tokens were auto-unioned into candidates, so forged
  tokens were always observed. Post-031 they are not — a caller who forges
  token X but does not query X gets no observation of X. Intended
  (explicit API), but add one JSDoc line on `tokenSlotOverrides` and one
  README sentence: "query the tokens you forge if you want to observe
  them."

### TS wiring

- `runSimulator` gains `balanceProbes?: readonly {token: Address | "native"; account: Address}[]`
  (map `"native"` → zero address when encoding; map back when building
  results). `probeData` gains the three decoded arrays.
- `runSimulate` (txSimulator.ts): DELETE the `discoverCandidateAddresses`
  call and its import; pass `candidates: []`, `balanceProbes` from
  `args.balanceQueries`; build `balanceDeltas` (ok probes, input order,
  including zero deltas — the caller asked) and `unresolved` (failed
  probes, input order). Delete the `assetBalanceDeltas` assembly in
  `runSimulator` — nothing consumes `deltaTokens`/`nativeDelta` publicly
  anymore (requirements uses outflows/checkpoints, not deltas; verify and,
  if truly unconsumed, drop those tuple fields from the decode ONLY if the
  ABI struct keeps them — do NOT change the Solidity result fields beyond
  the appends, to keep this diff reviewable).
- **New namespace + helper** on the interface (the namespace is born here;
  plan 032 adds the second namespace):

```ts
readonly balanceQueries: {
  /** Wallet-style discovery: access-list candidates, filtered to real tokens, mapped to queries for `from` (native included). */
  forUser: (args: ForUserBalanceQueriesArgs) => Promise<BalanceQuery[]>;
};
```

  Implementation (new `src/internal/queryDiscovery.ts`): run
  `discoverCandidateAddresses` (existing), then ONE filtering
  `runSimulator` call with `calls: []`, `candidates`, empty probes — the
  contract's `observedTokens` is exactly "candidates that answer
  balanceOf" — then return
  `[{asset: "native", account: from}, ...observedTokens.map(t => ({asset: t, account: from}))]`.
  Debug step for the filter call: `debugStep: "balanceQueries.tokenFilter"`.
  Honest cost note (document in JSDoc + README): the wallet flow is now
  N access lists + 1 filter call + 1 simulate — one more RPC than the old
  fused pipeline; the trade is explicitness and a discovery-free core.
- `AccessListUnsupportedError` JSDoc/README: now raised only by
  `balanceQueries.forUser` and `tokenOverrides` helpers, never `simulate`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (needs forge/anvil) |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |
| Bytecode regen | `pnpm build` | `src/generated/` + `dist/` updated |

## Scope

**In scope**: `contracts/TxSimulator.sol`, `src/generated/` + `dist/` (via
build only), `src/types.ts`, `src/txSimulator.ts`,
`src/internal/simulator.ts`, `src/internal/queryDiscovery.ts` (create),
`src/internal/requirements.ts` (only if the runSimulator signature change
requires touching call sites), `src/index.ts`, all four anvil test files +
`test/mainnet.test.ts`, `README.md`, `CLAUDE.md` (invariants + flow
sections), `plans/README.md` (status row).

**Out of scope**: `prepareBalanceOverrides`/`prepareAllowanceOverrides`/
`estimateAssetRequirements` behavior and names (plan 032 regroups them);
`src/internal/{slots,probes,data,rpc}.ts` beyond signature ripple; any
deprecated/compat shims — old shapes are DELETED (maintainer instruction:
pre-prod, no redundant surface).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Contract + ABI + regen

Add `BalanceProbe`, the fourth `simulate` param, the three result arrays,
and the snapshot loops per Target design. Update the inline `parseAbi`
strings in `src/internal/simulator.ts` to match. `pnpm build`.

**Verify**: `forge build` exit 0; `pnpm typecheck` fails only at
`runSimulator` call sites (expected).

### Step 2: Types

Apply the Types section: add `BalanceQuery`/`BalanceDelta` +
`ForUserBalanceQueriesArgs` (`{from, calls, gas?, debug?} & BlockOptions`),
require `balanceQueries` on `SimulateArgs`, rewrite the result variants,
delete `AssetBalanceDelta`, update `src/index.ts` exports.

**Verify**: `grep -n "AssetBalanceDelta" src/` → no matches;
`pnpm typecheck` errors confined to implementation + tests.

### Step 3: runSimulator + runSimulate + forUser

Per TS wiring. Order within the file: implement `runSimulator`'s probe
plumbing first, then `runSimulate`, then `internal/queryDiscovery.ts` and
the `balanceQueries` namespace on the interface + `create()`.

**Verify**: `pnpm typecheck` → exit 0;
`grep -n "discoverCandidateAddresses" src/txSimulator.ts` → no matches
(only `queryDiscovery.ts` and `requirements.ts` import it).

### Step 4: Tests

Rewrite per "Tests that change". Key new coverage (exact values):

1. **Arbitrary-account observation**: Spender pulls 300n from `from` →
   queries `[{token, account: from}, {token, account: spender.address}]` →
   deltas `-300n` (with correct before/after) and `+300n` respectively.
2. **Query mirroring incl. zero delta**: query an untouched token+account →
   entry present with `delta: 0n`.
3. **Unresolved query**: query an EOA address as `asset` → appears in
   `unresolved`, not in `balanceDeltas`.
4. **Post-override `before`**: forge balance to sentinel, query it →
   `before === OVERRIDE_TOKEN_AMOUNT`.
5. **Native query** on a value transfer → correct before/after.
6. **forUser wallet flow**: mint + transfer → `forUser` returns native +
   token queries; end-to-end deltas match; debug events: N
   `candidateDiscovery.accessList` + 1 `balanceQueries.tokenFilter` from
   the helper, and exactly 1 `txSimulator.simulate` (zero access lists)
   from `simulate`.
7. **Reverted mid-batch**: deltas reflect executed prefix; revert fields
   intact (narrowing unchanged).
8. Errors file re-targeting per "Tests that change".
9. Mainnet test: explicit USDC query at the account, balance override kept.

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass;
three consecutive green runs (contract + concurrency touched).

### Step 5: Docs + full gate

README: rewrite Getting-started (wallet flow = forUser + simulate),
add the dapp partial-bundle example (flash-plugin leftover read via
`balanceDeltas.find(...).after`), add the override-semantics paragraph
(feedback issue 7 text), document the two approval patterns (approve call
in `calls`, or allowance overrides) and the wallet-vs-dapp discovery
pattern. CLAUDE.md: update flow + "invariants tests pin" (new RPC shape:
simulate = 1 eth_call, discovery lives in helpers).

**Verify**: `pnpm verify` → exit 0;
`grep -c "balanceQueries" README.md` → ≥3.

## Test plan

Step 4 is the test plan; the exact-value + RPC-count assertions are
REWRITTEN deliberately (this plan changes behavior) and become the new
pinned baseline.

## Done criteria

- [ ] `pnpm verify` exits 0; suite green 3 consecutive runs
- [ ] `simulate` emits zero `eth_createAccessList` (debug-event test pins it)
- [ ] `SimulateArgs.balanceQueries` required; `AssetBalanceDelta` gone from src and package root
- [ ] `balanceDeltas` mirrors queries (zero-delta test) with post-override `before` (sentinel test); `unresolved` populated for un-probeable queries
- [ ] Arbitrary-account test passes with exact ±300n values
- [ ] `sim.balanceQueries.forUser` exists and the wallet e2e test passes
- [ ] README has wallet + dapp examples and the override-semantics paragraph
- [ ] `plans/README.md` status row updated

## STOP conditions

- The contract with 4 params + 3 new arrays exceeds gas/size limits in
  tests — report numbers.
- `requirements.ts` behavior changes observably (its tests must pass with
  at most call-shape edits) — the estimate path is out of scope.
- You find a consumer of `deltaTokens`/`nativeDelta` that blocks removing
  the public delta assembly — report rather than keeping a dual surface.
- Anything tempts you to keep `assetBalanceDeltas` as an alias — forbidden
  (pre-prod, no deprecated remains).

## Maintenance notes

- `balanceProbes` before/after arrays are endpoint snapshots — they do NOT
  do per-call gross tracking (that remains the requirements machinery).
  If per-call granularity is wanted later, that's the deferred per-call
  attribution finding, not an extension of this.
- The wallet flow costs one more RPC than the pre-031 fused pipeline
  (documented). If that ever matters, a fused convenience wrapper is a new
  decision — do not quietly re-fuse discovery into `simulate`.
- Plan 032 renames/regroups the override helpers around this new shape;
  execute it immediately after to avoid a mixed-vocabulary release.
