# Plan 055: Align the public surface with viem conventions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: this plan was written against `031aff2` **plus
> uncommitted work** (the mutually-exclusive `BlockOptions` union), so a SHA
> diff is meaningless — the excerpt check IS the drift check. Confirm every
> "Current state" excerpt below against the live code before proceeding
> (line numbers may shift by a few lines; the code shape must match). On a
> shape mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L (six sub-changes, each S–M)
- **Risk**: MED (breaking public-surface wave; behavior changes are small and test-pinned)
- **Depends on**: none (precondition: the exclusive `BlockOptions` union is present in `src/types.ts` — see Step 0)
- **Category**: dx
- **Planned at**: commit `031aff2` (branch `v0.4-misu`, dirty tree), 2026-08-05

## Why this matters

`viem-tx-sim` markets itself to viem users, and 0.4 is already a breaking release
(the `BlockOptions` exclusivity change is in the tree). This plan lands the six
remaining viem-alignment changes in the same breaking window so the surface never
has to break twice. After it lands: consumers pass the **same `calls` array** they
hand to viem's `sendCalls`/`simulateCalls` (including the `{ abi, functionName, args }`
form); duplicate state overrides are **rejected like viem rejects them** instead of
silently last-wins merged; any viem `Client` works (not just `PublicClient`); public
argument types follow viem's `*Parameters` naming; the block selector gains viem's
EIP-1898 `blockHash` branch; and the README documents the one-line `client.extend()`
integration. The design principle throughout: **make illegal states unrepresentable**
on argument types (consumer-constructed), and reject loudly where the type system
cannot reach (duplicates in arrays).

## Current state

Files and their roles:

- `src/types.ts` — public argument/result/config types; the `BlockOptions` union (uncommitted work), `SimulatedCall`, the four calls-carrying arg types, `TxSimulatorConfig`.
- `src/index.ts` — public barrel; exports the seven `*Args` type names and `SimulatedCall`.
- `src/txSimulator.ts` — public interface/factory; `create()` bindings, `runSimulate`, `runEstimateBatchGas`, empty-calls guards.
- `src/internal/rpc.ts` — `blockOptionsSpread`, `buildCallParameters` (the only place block options expand into viem params), `createAccessList` raw request, `ClientArgs`/`RpcCallArgs`.
- `src/internal/simulator.ts` — simulator `eth_call` execution (2 `client.call` sites), `buildStateOverride` (cross-source merge), `tokenSlotOverridesToStateDiff`.
- `src/internal/probes.ts`, `src/internal/slots.ts` — 1 `client.call` site each.
- `src/internal/queryDiscovery.ts`, `src/internal/requirements.ts` — import the public arg types; `requirements.ts` reads `call.data` (lines 55, 288, 318 — permit detectors).
- `test/helpers/fakeClient.ts` — a **real** `PublicClient` over a `custom` transport with per-RPC-method scripted responders (lines 19–31). Nothing stubs `.call` as a method; everything routes through the transport, so switching call sites to viem actions cannot break these tests.
- `test/simulate.test.ts` — carries the `@ts-expect-error` both-block-selectors type test (search: "rejects setting both block selectors") — the exemplar for MISU type tests in this repo.

Key excerpts (confirm each before proceeding):

`src/types.ts` — the uncommitted exclusive union (~line 67):

```ts
export type BlockOptions =
  | {
      /** Historical block number to simulate against. */
      blockNumber?: bigint;
      blockTag?: undefined;
    }
  | {
      blockNumber?: undefined;
      /** Block tag to simulate against. Defaults to `latest`. */
      blockTag?: BlockTag;
    };
```

`src/types.ts:176-181` and three siblings — the calls field:

```ts
export type SimulateArgs = SimulationOptions & {
  from: Address;
  /** One call or an ERC-5792-style sequential batch. Must contain at least one call. */
  calls: readonly SimulatedCall[];
```

The four calls-carrying arg types: `SimulateArgs`, `ForUserBalanceQueriesArgs`,
`EstimateAssetRequirementsArgs`, `EstimateBatchGasArgs`. The other three public arg
types (`PrepareBalanceOverridesArgs`, `PrepareAllowanceOverridesArgs`,
`ForPermit2AllowancesArgs`) carry `tokens`/`pairs`, not calls.

`src/types.ts:188-191` and `:263` — the duplicate-tolerance docs this plan deletes:

```ts
   * Native balance overrides applied before simulating. Duplicate accounts use the last amount.
```

`src/types.ts:295-303`:

```ts
export type TxSimulatorConfig = {
  client: PublicClient;
```

`src/txSimulator.ts:265-274` — `runSimulate` normalization today:

```ts
async function runSimulate(args: SimulateArgs & ClientArgs): Promise<SimulationResult> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("simulate requires at least one call.");
  }

  const calls = args.calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
```

(`runEstimateBatchGas` at `:316-327` repeats the same map; `intrinsicAndCalldataGas(call.data)` at `:350` consumes the normalized data.)

`src/internal/simulator.ts:378-397` — the cross-source merge that MUST stay (the ghost
`code` entry at `from`, a native `balance` override at `from`, and token `stateDiff`
entries can legitimately target the same address and must merge into one
`StateOverride` entry, or viem itself throws `AccountStateConflictError`):

```ts
function buildStateOverride(entries: readonly StateOverrideEntry[]): StateOverride {
  const merged = new Map<string, MutableStateOverrideEntry>();
  ...
    if (entry.balance !== undefined) existing.balance = entry.balance;   // ← last-wins today
    if (entry.stateDiff) {
      const bySlot = new Map(...);
      for (const diff of entry.stateDiff) bySlot.set(diff.slot.toLowerCase(), diff);  // ← last-wins today
```

The 4 `client.call` sites (each already wrapped in `buildCallParameters`):
`src/internal/simulator.ts:144`, `src/internal/simulator.ts:269`,
`src/internal/slots.ts:357`, `src/internal/probes.ts:161`.

`src/internal/rpc.ts:106-107` — `createAccessList`'s block param today:

```ts
  const block =
    args.blockNumber !== undefined ? numberToHex(args.blockNumber) : (args.blockTag ?? "latest");
```

Verified facts about the installed viem (2.54.1):

- `Call`/`Calls` types are exported from the viem **root** since viem 2.23.8, but
  that is NOT the binding peer floor. The floor is set by the newest viem feature
  this plan uses: EIP-1898 `blockHash` support in the `call` action landed in
  **viem 2.50.0** (CHANGELOG PR #4186); `Call.dataSuffix` landed in 2.31.3. Below
  2.50.0 a consumer's `blockHash` falls into `...rest` and viem silently defaults
  `blockTag: "latest"` — a wrong answer, not an error. Current peer floor `^2.8.0`
  must bump to **`^2.50.0`**.
- `Call` is a `OneOf` union — `{ data?, dataSuffix?, to, value? }` vs
  `{ abi, functionName, args?, to, value?, data?, dataSuffix? }` — but note `data`
  appears in **both** branches, so mixing `data` with `abi` COMPILES (exclusivity
  exists only in the other direction: `abi` is stamped `?: undefined` on the
  data-only branch). Do not attempt a type-level exclusivity test for it;
  `normalizeCalls` mirrors `sendCalls` and prefers the `abi` encoding when both
  are present.
- viem's own encode logic, `node_modules/viem/_esm/actions/wallet/sendCalls.js:66-78` — mirror this exactly:

```js
const data = call.abi
  ? encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args })
  : call.data;
return {
  data: call.dataSuffix && data ? concat([data, call.dataSuffix]) : data,
  ...
```

- viem's `CallParameters` block selector is a union whose third branch carries
  `blockHash?: Hash` + `requireCanonical?: boolean` (EIP-1898) — `buildCallParameters`
  can pass `blockHash` straight through to `client.call`/the `call` action.
- viem rejects duplicate stateOverride accounts/slots with
  `AccountStateConflictError`/`StateAssignmentConflictError`
  (`node_modules/viem/_esm/utils/stateOverride.js:41,55`).
- `getAction(client, actionFn, name)` (`viem/utils`) returns `client[name]` when the
  client is decorated with it and falls back to the tree-shakable action otherwise.
  On today's `PublicClient` inputs it resolves to the decorated `client.call` —
  **zero behavior or RPC-count change** — while permitting minimal/undecorated clients.
- `concat` and `encodeFunctionData` are exported from the viem root.

Repo conventions that bind this plan:

- **Invariants (CLAUDE.md)**: public `simulate()` emits zero `eth_createAccessList`
  and exactly one `eth_call`; tests pin exact RPC counts via debug events and pin
  debug step names as literals (ADR-0001). Nothing in this plan may add an RPC call
  or rename a debug step.
- Type-level MISU tests use `@ts-expect-error` with a comment naming the invariant —
  exemplar: the "rejects setting both block selectors at the type level" test in
  `test/simulate.test.ts`.
- Input-error tests assert `rejects.toBeInstanceOf(InvalidSimulationInputError)` —
  exemplars at `test/errors.test.ts:23-29` (fakeClient) and `test/simulate.test.ts:881` (anvil).
- Formatting is oxfmt; run `pnpm lint:fix` after each step rather than hand-matching style.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no output |
| Lint/format | `pnpm lint` (fix: `pnpm lint:fix`) | exit 0 |
| One test file | `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts` | all pass |
| Full gate | `pnpm verify` | exit 0 |

Foundry **nightly** is required (`ci.yml` pins `nightly-7debd6d47628c5551837534aee507dbf552d5889`).
If ~9 tests fail with `EVM error OutOfGas` from `eth_createAccessList`, the machine is
on stable Foundry — install the pinned nightly and re-run before concluding anything.

## Scope

**In scope** (the only files you should modify):

- `src/types.ts`, `src/index.ts`, `src/txSimulator.ts`
- `src/internal/rpc.ts`, `src/internal/simulator.ts`, `src/internal/probes.ts`, `src/internal/slots.ts`
- `src/internal/queryDiscovery.ts`, `src/internal/requirements.ts` (renamed type references only)
- `test/simulate.test.ts`, `test/txSimulator.test.ts`, `test/errors.test.ts`, `test/requirements.test.ts`, `test/mainnet.test.ts`, `test/permit2.test.ts`, `test/nft.test.ts` (renames + new tests; touch only what the step names)
- `README.md`, `CLAUDE.md`, `AGENTS.md`
- `package.json` + `pnpm-lock.yaml` (peer floor bump only)
- `.changeset/viem-surface-alignment.md` (create)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `contracts/`, `src/generated/` — no contract or bytecode change is needed; if a step seems to require one, that is a STOP.
- `docs/examples/*.md` — verified to contain zero `*Args` type references; the `{ to, data }` call form remains valid. Leave them.
- `.github/` workflows.
- Debug step names (`src/internal/debugSteps.ts`) and anything that changes an RPC count.
- `src/constants.ts`, `src/errors.ts` (used, not modified).

## Git workflow

- Work on the current branch `v0.4-misu` (the 0.4 breaking window). If the tree still
  holds the uncommitted `BlockOptions` work, commit it first (message:
  `feat: make blockNumber and blockTag mutually exclusive, mirroring viem`).
- One commit per step below; message style matches `git log` (`feat:`/`chore:` prefixes).
- Do NOT push or open a PR.

## Steps

### Step 0: Preconditions

1. Confirm `src/types.ts` contains the exclusive `BlockOptions` union excerpted above. Absent → STOP.
2. Run `pnpm verify` for a green baseline (see the Foundry-nightly note). Not green after the nightly fix → STOP.

### Step 1: Rename the seven public `*Args` types to `*Parameters`

viem's house style is `CallParameters`, `SimulateCallsParameters`. Rename exactly these
seven declarations in `src/types.ts`, their `export` lines in `src/index.ts`, and every
reference — all references live under `src/` (`src/txSimulator.ts`,
`src/internal/queryDiscovery.ts`, `src/internal/requirements.ts`,
`src/internal/slots.ts`); tests and README reference **none** of these names, so the
verify grep below passing there is expected, not evidence you missed something:

| Old | New |
|-----|-----|
| `SimulateArgs` | `SimulateParameters` |
| `ForUserBalanceQueriesArgs` | `ForUserBalanceQueriesParameters` |
| `PrepareBalanceOverridesArgs` | `PrepareBalanceOverridesParameters` |
| `PrepareAllowanceOverridesArgs` | `PrepareAllowanceOverridesParameters` |
| `ForPermit2AllowancesArgs` | `ForPermit2AllowancesParameters` |
| `EstimateAssetRequirementsArgs` | `EstimateAssetRequirementsParameters` |
| `EstimateBatchGasArgs` | `EstimateBatchGasParameters` |

Do NOT rename: `ClientArgs`, `RpcCallArgs` (internal), `BoundCallDefaults`, or any
function parameter named `args`. Also update the `/** Arguments for ... */` JSDoc
lines to `/** Parameters for ... */`.

**Verify**:
`grep -rnE "SimulateArgs|ForUserBalanceQueriesArgs|PrepareBalanceOverridesArgs|PrepareAllowanceOverridesArgs|ForPermit2AllowancesArgs|EstimateAssetRequirementsArgs|EstimateBatchGasArgs" src/ test/ README.md` → no matches;
`pnpm typecheck && pnpm lint` → exit 0.

### Step 2: Add the EIP-1898 `blockHash` branch to `BlockOptions`

In `src/types.ts`, extend the union to three branches, mirroring viem's `CallParameters`
selector but with one deliberate improvement — `blockHash` is **required** in its
branch, so `requireCanonical` without `blockHash` is unrepresentable (viem's own type
allows it and throws at runtime; ours won't compile):

```ts
export type BlockOptions =
  | {
      /** Historical block number to simulate against. */
      blockNumber?: bigint;
      blockTag?: undefined;
      blockHash?: undefined;
      requireCanonical?: undefined;
    }
  | {
      blockNumber?: undefined;
      /** Block tag to simulate against. Defaults to `latest`. */
      blockTag?: BlockTag;
      blockHash?: undefined;
      requireCanonical?: undefined;
    }
  | {
      blockNumber?: undefined;
      blockTag?: undefined;
      /** Historical block hash to simulate against (EIP-1898). */
      blockHash: Hex;
      /** Reject the hash if it is not on the canonical chain (EIP-1898). */
      requireCanonical?: boolean;
    };
```

In `src/internal/rpc.ts`:

- `blockOptionsSpread`: forward whichever selector is set; precedence for untyped JS
  callers mirrors viem's `formatBlockParameter`: `blockHash` > `blockNumber` > `blockTag`.
- `buildCallParameters`: add the `blockHash` branch, passing `blockHash` (+
  `requireCanonical` when set) through to viem's `CallParameters`.
- `createAccessList`: the raw request's block param gains the EIP-1898 object form —
  `{ blockHash, requireCanonical? }` — alongside `Hex | BlockTag`; widen
  `requestAccessList`'s `block` parameter type accordingly.

**Tests** (`test/simulate.test.ts`):

1. Extend the existing type-level test with a second `@ts-expect-error` const:
   `{ blockNumber: 1n, blockHash: zeroHash }` must not compile.
2. Runtime: mint, capture `const block = await ctx.publicClient.getBlock()`, mint
   again, then `simulate({ ..., blockHash: block.hash })` and assert the same
   `before`/`delta` as the existing pinned-historical-block test. (This exercises
   `eth_call` only — `simulate` never calls `eth_createAccessList`.)
3. Runtime, access-list path: `balanceQueries.forUser({ from, calls, blockHash })`
   returns the same queries as the `blockNumber` form — `blockHash` is reachable
   through `eth_createAccessList` via every discovery/preparation method, and viem's
   own `createAccessList` action has no blockHash support, so this library's raw
   request is the only tested path. (Verified during planning: anvil nightly accepts
   the EIP-1898 object for both `eth_call` and `eth_createAccessList`.)

**Verify**: `pnpm typecheck` → exit 0; `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts` → all pass.

### Step 3: Reject duplicate user-supplied overrides

viem throws `AccountStateConflictError` on duplicate stateOverride **accounts**; this
library currently documents last-wins. (Precision note: viem does NOT throw on
duplicate slots — its slot map silently last-wins; the slot-level guard below is this
library's stricter extension, consistent with the same reject-ambiguity principle.)
Validate **user input** at the public boundary and leave `buildStateOverride`'s
cross-source merge untouched (see the excerpt above for why it is load-bearing).

In `src/txSimulator.ts`, add one helper and call it from BOTH `runSimulate` and
`runEstimateBatchGas` before any mapping, as
`assertNoOverrideConflicts(args.tokenSlotOverrides ?? [], args.nativeBalanceOverrides ?? [])`
(both fields are optional). Add `TokenSlotOverride` and `NativeBalanceOverride` to the
existing `./types.js` type-import block (`txSimulator.ts:17-35`):

```ts
/** Rejects duplicate user-supplied overrides (accounts mirror viem's AccountStateConflictError; slots are stricter than viem). */
function assertNoOverrideConflicts(
  tokenSlotOverrides: readonly TokenSlotOverride[],
  nativeBalanceOverrides: readonly NativeBalanceOverride[],
): void {
  const slots = new Set<string>();
  for (const override of tokenSlotOverrides) {
    const key = `${override.token.toLowerCase()}:${override.slot.toLowerCase()}`;
    if (slots.has(key)) {
      throw new InvalidSimulationInputError(
        `Duplicate tokenSlotOverrides entry for token ${override.token} slot ${override.slot}.`,
      );
    }
    slots.add(key);
  }
  const accounts = new Set<string>();
  for (const override of nativeBalanceOverrides) {
    const key = override.account.toLowerCase();
    if (accounts.has(key)) {
      throw new InvalidSimulationInputError(
        `Duplicate nativeBalanceOverrides entry for account ${override.account}.`,
      );
    }
    accounts.add(key);
  }
}
```

Update docs: delete both "Duplicate accounts use the last amount." sentences in
`src/types.ts` (lines ~189 and ~263) and replace with
"Duplicate accounts are rejected with `InvalidSimulationInputError`."; add matching
`@throws` lines to the `simulate` and `gas.estimateBatch` JSDoc in `src/txSimulator.ts`.

**Tests**: two new cases modeled on the `InvalidSimulationInputError` exemplars —
duplicate `tokenSlotOverrides` (same token+slot twice) and duplicate
`nativeBalanceOverrides` (same account twice) each
`rejects.toBeInstanceOf(InvalidSimulationInputError)`. The throw happens before any
RPC, so `fakeClient({})` (zero scripted methods) works: any RPC would throw
"unscripted RPC method", proving the guard fired first. Put them in `test/errors.test.ts`.

**Verify**: `pnpm exec vitest run test/errors.test.ts` → all pass, including 2 new;
`grep -rn "use the last amount" src/` → no matches.

### Step 4: Route calls through `getAction` and accept any viem `Client`

Swap the 4 `client.call(` sites for viem's action pattern. At each site
(`simulator.ts:144`, `simulator.ts:269`, `slots.ts:357`, `probes.ts:161`):

```ts
import { call } from "viem/actions";
import { getAction } from "viem/utils";
...
        getAction(args.client, call, "call")(
          buildCallParameters({ ... }),
        ),
```

Then widen the client types: in `src/types.ts`, `TxSimulatorConfig.client:
PublicClient` → `client: Client` (`import type { Client } from "viem"`); in
`src/internal/rpc.ts`, `ClientArgs`/`RpcCallArgs` likewise, AND the
`requestAccessList` helper's own `client: PublicClient` annotation at
`src/internal/rpc.ts:166` (it is called with `args.client` at `:122`; tsc will catch
it if missed). Drop the now-unused `PublicClient` imports from both files (oxlint
flags unused imports). `PublicClient` extends `Client`, so all existing callers (and
`fakeClient`, which returns a real `PublicClient`) remain assignable. Update the
`TxSimulator.create` JSDoc ("bound to one viem client"). The `client.request` call
sites themselves need no change.

Behavior note for the reviewer: `getAction` resolves to the decorated `client.call`
on every existing input (a `PublicClient`), so RPC counts, debug events, and error
wrapping are byte-identical today; the change only *admits* undecorated clients.

**Verify**: `grep -rn "client\.call(" src/` → no matches; `pnpm typecheck` → exit 0;
`pnpm exec vitest run test/errors.test.ts test/simulate.test.ts` → all pass (the
fakeClient error-path tests prove viem's action/error wrapping is unchanged).

### Step 5: Adopt viem's `Call` type for `calls`

1. **Peer floor**: in `package.json`, `peerDependencies.viem` `"^2.8.0"` → `"^2.50.0"`
   (set by EIP-1898 `blockHash` support in the `call` action, NOT by the `Call`
   export — see Current state; below 2.50.0 a caller's `blockHash` is silently
   swapped for `blockTag: "latest"`). Run `pnpm install` to refresh the lockfile's
   specifier line. README names no viem floor (`grep -n "2.8.0" README.md` → 0
   matches) — nothing to update there.
2. **Types** (`src/types.ts`): on the four calls-carrying parameter types, change
   `calls: readonly SimulatedCall[]` → `calls: readonly Call[]`
   (`import type { Call } from "viem"`). Keep `SimulatedCall` exported from
   `types.ts` as the **internal normalized shape** — reword its JSDoc to
   "Normalized call executed by the simulator; public methods accept viem's `Call`
   union and normalize to this." — but REMOVE it from `src/index.ts`. Add one helper
   type next to it for internal signatures:

   ```ts
   /**
    * Internal: a public parameters type with `calls` already normalized.
    * The `T extends unknown` conditional is LOAD-BEARING: it distributes over the
    * BlockOptions union branches. A plain `Omit<T, "calls">` collapses the union
    * into one flat object, which (a) no longer satisfies `blockOptionsSpread`'s
    * `BlockOptions` parameter (TS2345 at six call sites) and (b) silently
    * re-legalizes setting blockNumber and blockTag together on every internal
    * signature. Do not simplify it away.
    */
   export type WithNormalizedCalls<T extends { calls: readonly Call[] }> = T extends unknown
     ? Omit<T, "calls"> & { calls: readonly SimulatedCall[] }
     : never;
   ```

3. **Normalization** (`src/txSimulator.ts`): add `normalizeCalls`, mirroring
   `sendCalls.js:66-78` byte-for-byte in behavior (`concat` and `encodeFunctionData`
   from the viem root):

   ```ts
   function normalizeCalls(calls: readonly Call[]): SimulatedCall[] {
     return calls.map((call) => {
       const data = call.abi
         ? encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args })
         : call.data;
       return {
         to: call.to,
         data: call.dataSuffix && data ? concat([data, call.dataSuffix]) : (data ?? "0x"),
         value: call.value ?? 0n,
       };
     });
   }
   ```

   This compiles verbatim against viem 2.54.1 — no cast needed. (Fallback only if a
   future viem tightens the overloads: `encodeFunctionData({ ... } as
   EncodeFunctionDataParameters)`, type import from `"viem"`.) Wrap the
   `encodeFunctionData` call in try/catch and rethrow as
   `InvalidSimulationInputError(\`calls[\${index}]: \${message}\`)` — otherwise a
   malformed `abi`/`functionName` throws viem's `AbiFunctionNotFoundError` (a viem
   `BaseError`) out of `simulate()`, the first non-`TxSimError` on the public
   surface. Use the `(call, index)` map signature to have the index available.

   Apply it once, in the `create()` bindings, for the five methods that take calls
   (`simulate`, `balanceQueries.forUser`, `balanceQueries.discoverErc20s`,
   `tokenOverrides.estimateRequirements`, `gas.estimateBatch`):
   `runSimulate({ ...args, calls: normalizeCalls(args.calls), ... })`.
   Then in `runSimulate`/`runEstimateBatchGas` delete the per-runner
   `const calls = args.calls.map(...)` normalization maps (keep the empty-calls
   guards) and **repoint their surviving `calls` references to `args.calls`** —
   `buildBalanceResults(..., calls.length)` at `txSimulator.ts:297` and the
   `calls.map((call, index) => ...)` gas loop at `:344` both use the deleted local
   and will be TS2304 dangling references if you only delete the declaration.
   Leave the identical-looking maps in `src/internal/queryDiscovery.ts:26-30` and
   `src/internal/requirements.ts:53-57` IN PLACE — after normalization they become
   cheap identity maps, and removing them widens this step's blast radius for zero
   gain. Retype the internal entry points with `WithNormalizedCalls<...>`
   (`runSimulate`, `runEstimateBatchGas`, `forUserBalanceQueries`, `discoverErc20s`,
   and `estimateAssetRequirements`); the internal
   modules keep reading `call.data: Hex` exactly as today (`requirements.ts`'s
   permit detectors at lines 288/318 and `intrinsicAndCalldataGas` at
   `txSimulator.ts:350` must keep receiving definite `Hex`).

4. **Tests** (`test/simulate.test.ts` unless noted):
   - (There is deliberately NO `@ts-expect-error` test for mixing `data` with `abi` —
     viem's `Call` carries `data` in both `OneOf` branches, so that mix compiles; see
     Current state. Do not add one: it fails typecheck as an unused directive, TS2578.)
   - abi-form: `simulate` a transfer passed as `{ to, abi, functionName: "transfer",
     args: [recipient, 250n] }` and assert deltas identical to the existing data-form
     transfer test.
   - `data`-less native transfer: `{ to, value }` with no `data` key → succeeds with
     the same deltas as the existing `data: "0x"` native test.
   - dataSuffix: the same transfer with `dataSuffix: "0x1234"` still succeeds with the
     same delta (standard ABI decoding ignores trailing bytes — this proves the concat
     happened without corrupting the selector/args).

**Verify**: `grep -n "SimulatedCall" src/index.ts` → no matches;
`pnpm typecheck && pnpm lint` → exit 0;
`pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts test/txSimulator.test.ts` → all pass.

### Step 6: Docs, changeset, index

1. **README.md**:
   - Quick start: after the `TxSimulator.create({ client })` line, add the extension
     one-liner as an alternative:
     ```ts
     // Or hang it off your client, viem-extension style:
     const extended = client.extend((c) => ({ txSim: TxSimulator.create({ client: c }) }));
     ```
   - "Public API" section (`README.md:146-157`): it lists method signatures and
     constants, and names **zero** `*Args` types — there is nothing to sweep; add
     the two new sentences only: "`calls` accepts viem's `Call` union — the same
     array you pass to `sendCalls`, including the `{ abi, functionName, args }`
     form." and "Duplicate `tokenSlotOverrides` slots or `nativeBalanceOverrides`
     accounts are rejected with `InvalidSimulationInputError`."
2. **CLAUDE.md and AGENTS.md**: amend the corresponding invariant lines in EACH file
   independently — the two files are deliberately different lengths and content;
   do NOT sync one onto the other. Add to each: `calls` accept viem's `Call` union
   and are normalized once in the `create()` bindings; duplicate user overrides
   throw `InvalidSimulationInputError`; the config takes any viem `Client` and call
   sites route through `getAction`; `BlockOptions` has three exclusive branches
   (number/tag/hash). Do not restate what CLAUDE.md already says about
   `blockOptionsSpread`/`buildCallParameters` — amend those lines in place.
3. **Changeset** `.changeset/viem-surface-alignment.md` (minor — pre-1.0 breaking):
   list every break: the seven `*Args` → `*Parameters` renames (with a
   find-and-replace migration note), `SimulatedCall` no longer exported (calls now
   accept viem's `Call`), duplicate overrides now throw instead of last-wins, viem
   peer floor `^2.50.0`, `TxSimulatorConfig.client` widened to `Client` (non-breaking),
   `blockHash`/`requireCanonical` block selector added (non-breaking).
4. **plans/README.md**: set this plan's row to DONE.

**Verify**: `pnpm verify` → exit 0; `grep -n "extend((c)" README.md` → 1 match;
`ls .changeset/viem-surface-alignment.md` → exists.

## Test plan

New tests, all following existing exemplars in the same files:

| Case | File | Pattern to model |
|------|------|------------------|
| `@ts-expect-error` blockNumber+blockHash | `test/simulate.test.ts` | the both-block-selectors type test |
| simulate at `blockHash` pin | `test/simulate.test.ts` | "reads state and executes at a pinned historical block" |
| forUser at `blockHash` (access-list path) | `test/simulate.test.ts` | the existing forUser discovery test |
| duplicate tokenSlotOverrides throws | `test/errors.test.ts` | `InvalidSimulationInputError` fakeClient exemplar (~line 23) |
| duplicate nativeBalanceOverrides throws | `test/errors.test.ts` | same |
| abi-form call equals data-form | `test/simulate.test.ts` | "mirrors balance queries including zero deltas" |
| data-less native transfer | `test/simulate.test.ts` | "reports native value deltas" |
| dataSuffix concat | `test/simulate.test.ts` | any transfer test |

Verification: `pnpm verify` → all pass, 8 new tests included, none of the pinned
RPC-count/debug-step tests changed.

## Done criteria

ALL must hold:

- [ ] `pnpm verify` exits 0 (on pinned Foundry nightly)
- [ ] `grep -rnE "(SimulateArgs|ForUserBalanceQueriesArgs|PrepareBalanceOverridesArgs|PrepareAllowanceOverridesArgs|ForPermit2AllowancesArgs|EstimateAssetRequirementsArgs|EstimateBatchGasArgs)" src/ test/ README.md` → no matches
- [ ] `grep -rn "client\.call(" src/` → no matches
- [ ] `grep -n "SimulatedCall" src/index.ts` → no matches
- [ ] `grep -rn "use the last amount" src/` → no matches
- [ ] `grep -n "blockHash" src/types.ts` → ≥1 match
- [ ] `grep -n '"viem": "\^2.50.0"' package.json` → 1 match (peerDependencies)
- [ ] `.changeset/viem-surface-alignment.md` exists and names every break
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` row 055 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `BlockOptions` union excerpt is absent from `src/types.ts` (the uncommitted
  prerequisite work is missing).
- ~9 tests fail with `EVM error OutOfGas` **after** installing the pinned Foundry
  nightly (baseline broken for another reason).
- Anvil rejects the EIP-1898 `{ blockHash }` object for `eth_call` **or**
  `eth_createAccessList` (Step 2's runtime tests cannot pass) — report; do not ship
  untested blockHash support. (Not expected: both were probed green on anvil nightly
  during planning.)
- `import type { Call } from "viem"` does not resolve on the installed viem.
- Any test pinning RPC counts or debug-step literals fails after Step 4 or 5 — those
  invariants outrank this plan.
- A step appears to require touching `contracts/`, `src/generated/`, or a debug step name.

## Maintenance notes

- **Deferred, deliberately**: viem's `Calls<calls>` const-generic inference (per-element
  `functionName`/`args` narrowing against `abi`). Plain `readonly Call[]` accepts the
  loose union; upgrade to the generic form only if consumers ask for narrowed inference.
- `normalizeCalls` mirrors `sendCalls`' encode (including `dataSuffix` concat). If viem
  changes that logic, mirror it — the promise is "same array as `sendCalls`".
- `getAction` means a consumer's `client.extend({ call: ... })` override now takes
  effect in this library — that is viem-canonical behavior, but reviewers should know
  it is reachable.
- The duplicate-override guard validates **user input only**; `buildStateOverride`'s
  internal cross-source merge is load-bearing (ghost code + native balance + token
  slots on one address) and must stay permissive.
- The `tokenOverrides.*` preparers do not dedupe their `tokens`/`pairs` inputs, so
  `forBalances({ tokens: [X, X] })` returns a duplicate slot list that the new guard
  will reject when spread into `simulate` — that is the guard working as intended
  (the caller passed a duplicate), but a consumer bug report of this shape is
  expected; point them at deduping their token list.
- A future `estimateRequirements` overrides parameter (it takes none today) must call
  `assertNoOverrideConflicts` too.
- `docs/design/*.md` still reference the old `*Args` names — deliberately untouched
  historical design records (same policy as prior rename plans); do not "fix" them.
