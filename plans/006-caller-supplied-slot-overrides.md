# Plan 006: Split slot discovery out of simulate(); take caller-supplied slot overrides as an argument

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c4ec468..HEAD -- src test README.md`
> This plan was written against commit `c4ec468` **with uncommitted changes
> present in the working tree** (the executed plans 001–005). The "Current
> state" excerpts below reflect the working tree as of 2026-07-02, not the
> commit. Compare the excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (001–005 are already DONE)
- **Category**: tech-debt
- **Planned at**: commit `c4ec468`, 2026-07-02 (dirty working tree — see drift check)

## Why this matters

Today `simulate()` reacts to reverts by *guessing*: it re-simulates with forged
balances, then probes every (token, spender) pair — where spenders are "every
non-token contract in the access list" — to forge allowances, then attributes a
spender per delta. This costs up to 3 simulation passes plus O(tokens ×
spenders) probe RPC calls, and the spender guess is wrong for token-shaped
spenders (an ERC-4626 vault is filtered out of spender candidates because it
answers `balanceOf`). The callers of this library already know exactly which
{token, spender, amount} tuples a transaction needs (owner is always `from`).

After this plan: slot discovery is a pair of separate, composable public
functions the client calls (and can cache) — `discoverBalanceSlots()` and
`discoverAllowanceSlots()` — and `simulate()` is a single pass that applies
caller-supplied slot overrides. The two outputs share the override shape, so a
caller needing both concatenates the arrays; a caller simulating a plain
transfer calls only the balance variant. All revert-retry
stages, spender guessing, and spender attribution are deleted. `simulate()`
drops to N+1 RPC calls (N access lists for candidate discovery + 1 `eth_call`).
This package is pre-production: **no backwards compatibility is required**.

## Current state

Relevant files and their roles:

- `src/simulate.ts` (242 lines) — public `simulate()`; contains the three-stage
  retry pipeline and attribution to be deleted.
- `src/internal/probes.ts` (286 lines) — `discoverBalanceSlot` /
  `discoverAllowanceSlot` (access-list probe + sentinel verification). **Keeps
  existing internals**; becomes the engine behind the new public function.
- `src/internal/simulator.ts` — `runSimulator()`; encodes the `eth_call` with
  the TxSimulator bytecode injected at `from`. Stays, minus the
  `InternalSimulationResult` wrapper.
- `src/types.ts` — public types; `AssetBalanceDelta` currently carries
  `spender`/`currentAllowance` which get removed.
- `src/index.ts` — public exports.
- `src/internal/discovery.ts`, `src/internal/stateOverride.ts`,
  `src/internal/hex.ts`, `src/internal/rpc.ts`, `src/internal/debug.ts`,
  `src/internal/address.ts`, `src/internal/abi.ts`, `src/internal/revert.ts` —
  unchanged support code (`OVERRIDE_TOKEN_AMOUNT = 10n ** 50n` and
  `uint256Hex` live in `hex.ts`; `StorageOverride` in `stateOverride.ts`).
- `contracts/TxSimulator.sol`, `src/generated/txSimulatorBytecode.ts` —
  **untouched**. The contract ABI (`simulate(SimulatedCall[], address[])`) does
  not change; no bytecode regeneration beyond the normal build.
- `test/simulate.test.ts` — anvil-backed tests; three tests exercise the retry
  pipeline and must be rewritten. **Note line 83 currently has `it.only(...)`
  from a debugging session — this must not survive.**
- `test/mainnet.test.ts` — opt-in mainnet test that currently passes **only
  because of the balance-forging retry** (the anvil address holds 0 USDC at the
  pinned block); must be migrated to the new two-step composition.
- `README.md` — documents the retry/attribution behavior in its last paragraph;
  must be updated.

### The retry pipeline being deleted — `src/simulate.ts:40-75`

```ts
const base = await runWithOverrides(args, calls, candidateAddresses, [], gas);
if (base.status === "success") return publicResult(base);

const tokenCandidates = base.observedTokens;
const balanceOverrides = await balanceOverridesFor(args, tokenCandidates, gas);
const withBalances =
  balanceOverrides.length > 0
    ? await runWithOverrides(args, calls, candidateAddresses, balanceOverrides, gas)
    : base;
if (withBalances.status === "success") return publicResult(withBalances);

const allowanceSlots = await discoverAllowanceSlots(
  args,
  tokenCandidates,
  candidateSpenders(candidateAddresses, calls, args.from, tokenCandidates),
  gas,
);
```

Everything from `runWithOverrides` (line 77) through `publicResult` (line 234)
except the pieces explicitly kept below is deleted: `runWithOverrides`,
`discoverBalanceSlots`, `balanceOverridesFor`, `discoverAllowanceSlots`,
`ApprovalAttribution`, `inferApprovalAttributionsFromDeltas`,
`withSpenderAttribution`, `candidateSpenders`, `storageOverride`,
`publicResult`.

### Attribution fields being removed — `src/types.ts:31-38`

```ts
export type AssetBalanceDelta = {
  asset: "native" | Address;
  delta: bigint;
  /** Present for negative ERC-20 deltas when one spender can be isolated. */
  spender?: Address;
  /** Allowance currently available before simulation. */
  currentAllowance?: bigint;
};
```

### The standalone current-allowance read being removed — `src/internal/probes.ts:180-191`

Inside `discoverAllowanceSlot`, between the access-list probe and the sentinel
verification loop, there is a read whose only consumer was attribution:

```ts
const currentAllowance = await readAllowance({
  client: args.client,
  token: args.token,
  owner: args.owner,
  spender: args.spender,
  ...
  debugStep: "allowanceSlot.currentAllowance",
  ...
});
if (currentAllowance === undefined) return undefined;
```

`AllowanceSlot` (`src/internal/probes.ts:18-23`) carries `currentAllowance`;
that field goes too. **Do not** delete `readAllowance`/`readBalanceOf`
themselves — the sentinel verification loops still use them.

### Internal result wrapper being removed — `src/internal/simulator.ts:21-23`

```ts
export type InternalSimulationResult = SimulationResult & {
  observedTokens: Address[];
};
```

`observedTokens` existed only to feed the retry stages. The Solidity result
struct still returns it (contract unchanged); the TS side simply stops
surfacing it.

### Conventions to match

- ESM with `.js` import specifiers (`import { x } from "./internal/foo.js"`).
- Optional args threaded with conditional spreads, e.g.
  `...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {})`
  — see `src/simulate.ts:34-37`. Match it.
- Public types live in `src/types.ts`; internal helpers under `src/internal/`.
- Debug instrumentation wraps every RPC via `withRpcDebug` from
  `src/internal/debug.js` with a dotted `step` name (e.g.
  `"balanceSlot.accessList"`). Keep existing step names.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Build contracts + TS | `pnpm build` | exit 0 (requires `forge` on PATH) |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Tests (anvil-backed) | `pnpm test` | all pass (requires `anvil` on PATH) |
| Lint + format check | `pnpm lint` | exit 0 |
| Format | `pnpm lint:fix` | exit 0 |

Node 20+, pnpm 10, Foundry (`forge`, `anvil`) required. `pnpm test` runs
`build:contracts` first automatically.

## Scope

**In scope** (the only files you should modify/create):

- `src/types.ts`
- `src/simulate.ts`
- `src/slots.ts` (create)
- `src/index.ts`
- `src/internal/probes.ts`
- `src/internal/simulator.ts`
- `test/simulate.test.ts`
- `test/mainnet.test.ts`
- `README.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `contracts/TxSimulator.sol` and `src/generated/txSimulatorBytecode.ts` — the
  contract interface is unchanged; regeneration happens via the normal build.
- `src/internal/abi.ts`, `src/internal/discovery.ts`,
  `src/internal/stateOverride.ts`, `src/internal/hex.ts`,
  `src/internal/rpc.ts`, `src/internal/debug.ts`, `src/internal/address.ts`,
  `src/internal/revert.ts`, `src/errors.ts` — no changes needed. (Leave the
  unused `"eth_getCode"` member of `SimulationDebugEvent["method"]` alone.)
- `docs/motivation.md` — the motivation doc is a
  historical transcription; it intentionally still describes the old retry
  design.
- `contracts/test/*.sol`, `test/helpers/*` — existing test contracts and
  helpers are sufficient.

## Git workflow

- The working tree already contains uncommitted changes from plans 001–005. Do
  **not** commit, stash, or revert them; work on top.
- Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the new public types

In `src/types.ts`:

1. Reduce `AssetBalanceDelta` to:

```ts
export type AssetBalanceDelta = {
  asset: "native" | Address;
  delta: bigint;
};
```

2. Add (near `SimulateArgs`):

```ts
export type BalanceSlot = {
  token: Address;
  slot: Hex;
};

export type AllowanceSlot = {
  token: Address;
  spender: Address;
  slot: Hex;
};

export type TokenSlotOverride = {
  token: Address;
  slot: Hex;
  /** Value written to the slot before simulating. Defaults to 10^50. */
  amount?: bigint;
};
```

3. Extend `SimulateArgs` with:

```ts
/** Storage-slot overrides applied before simulating — typically from discoverBalanceSlots()/discoverAllowanceSlots(). */
tokenSlotOverrides?: readonly TokenSlotOverride[];
```

`BalanceSlot` and `AllowanceSlot` are both structurally assignable to
`TokenSlotOverride` (the extra `spender` property on `AllowanceSlot` is
harmless on non-literal values), so discovery outputs — or a concatenation of
both — pass to `simulate()` unmodified.

**Verify**: `pnpm typecheck` → fails only with errors about the removed
`spender`/`currentAllowance` fields and not-yet-updated callers (expected at
this point; fixed by steps 2–4).

### Step 2: Simplify probes and drop the attribution read

In `src/internal/probes.ts`:

1. Delete the local `TokenBalanceSlot` and `AllowanceSlot` type definitions
   (lines 13–23) and instead import `BalanceSlot` and `AllowanceSlot` from
   `../types.js`. Change `discoverBalanceSlot`'s return type to
   `Promise<BalanceSlot | undefined>` (same shape as before) and
   `discoverAllowanceSlot`'s to `Promise<AllowanceSlot | undefined>`.
2. In `discoverAllowanceSlot`, delete the `readAllowance` call with
   `debugStep: "allowanceSlot.currentAllowance"` and its
   `if (currentAllowance === undefined) return undefined;` guard (lines
   180–191), and remove `currentAllowance` from the returned object in the
   verification loop.
3. Keep `readBalanceOf`, `readAllowance`, both discover functions, and all
   existing debug step names (`balanceSlot.accessList`, `balanceSlot.verify`,
   `allowanceSlot.accessList`, `allowanceSlot.verify`) otherwise unchanged.

**Verify**: `grep -n "currentAllowance" src/internal/probes.ts` → no matches.

### Step 3: Create the public discovery functions in `src/slots.ts`

New file `src/slots.ts` exporting two functions with parallel shapes:

```ts
import type { Address, PublicClient } from "viem";

import type { AllowanceSlot, BalanceSlot, SimulationDebug } from "./types.js";
import { OVERRIDE_TOKEN_AMOUNT } from "./internal/hex.js";
import { discoverAllowanceSlot, discoverBalanceSlot } from "./internal/probes.js";
import type { BlockOptions } from "./internal/rpc.js";

export async function discoverBalanceSlots(
  args: {
    client: PublicClient;
    owner: Address;
    tokens: readonly Address[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<BalanceSlot[]> {
  // For each token: call discoverBalanceSlot with sentinel: OVERRIDE_TOKEN_AMOUNT,
  // threading gas/debug/blockNumber/blockTag with conditional spreads exactly as
  // src/simulate.ts:104-113 does today. Push successful results.
}

export async function discoverAllowanceSlots(
  args: {
    client: PublicClient;
    owner: Address;
    pairs: readonly { token: Address; spender: Address }[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot[]> {
  // Same pattern, delegating to discoverAllowanceSlot per pair.
}
```

Semantics (document in a doc comment on each function): entries whose slot
cannot be discovered/verified are **omitted from the result** (no throw) —
callers detect gaps by comparing the result against their input. Both return
types are assignable to `TokenSlotOverride`, so results can be concatenated
and passed straight to `simulate()`.

**Verify**: `pnpm typecheck` → no errors mentioning `src/slots.ts`.

Naming note: the internal singular functions (`discoverBalanceSlot`,
`discoverAllowanceSlot` in `src/internal/probes.ts`) keep their names; the new
public plural functions wrap them. Do not re-export the internal ones.

### Step 4: Collapse `simulate()` to a single pass

Rewrite `src/simulate.ts` to approximately:

```ts
export async function simulate(args: SimulateArgs): Promise<SimulationResult> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("simulate requires at least one call.");
  }

  const gas = args.gas ?? DEFAULT_SIMULATION_GAS_LIMIT;
  const calls = args.calls.map((call) => ({
    to: call.to,
    calldata: call.calldata,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];

  const candidateAddresses = await discoverCandidateAddresses({ /* as today */ });

  const overrides = args.tokenSlotOverrides ?? [];
  const storageOverrides = overrides.map((override) => ({
    address: override.token,
    slot: override.slot,
    value: uint256Hex(override.amount ?? OVERRIDE_TOKEN_AMOUNT),
  }));

  return runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: uniqueAddresses([...candidateAddresses, ...overrides.map((o) => o.token)]),
    storageOverrides,
    debug: args.debug,
    /* blockNumber/blockTag/gas threaded as today */
  });
}
```

Notes:

- Overridden tokens are unioned into `candidates` so their deltas are observed
  even if candidate discovery missed them.
- Delete every helper listed in "Current state": `runWithOverrides`,
  `discoverBalanceSlots`, `balanceOverridesFor`, `discoverAllowanceSlots`,
  `ApprovalAttribution`, `inferApprovalAttributionsFromDeltas`,
  `withSpenderAttribution`, `candidateSpenders`, `storageOverride`,
  `publicResult`. The file should end up ~50 lines.
- In `src/internal/simulator.ts`: delete the `InternalSimulationResult` type,
  change `runSimulator`'s return type to `Promise<SimulationResult>`, and drop
  `observedTokens` from the returned object (keep decoding the ABI tuple as-is
  — the field simply goes unused). Update the import in `simulate.ts`.

**Verify**: `pnpm typecheck` → exit 0. Then
`grep -n "observedTokens" src/*.ts src/internal/simulator.ts` → matches only
the ABI-decode plumbing inside `runSimulator` (the tuple type/decode), nothing
exported.

### Step 5: Export the new API

In `src/index.ts`, add `discoverBalanceSlots` and `discoverAllowanceSlots`
from `./slots.js` and the types `AllowanceSlot`, `BalanceSlot`,
`TokenSlotOverride` from `./types.js`.

**Verify**: `pnpm build` → exit 0; `node -e "import('./dist/index.js').then(m => { if (typeof m.discoverBalanceSlots !== 'function' || typeof m.discoverAllowanceSlots !== 'function') throw new Error('missing export'); console.log('ok'); })"` → prints `ok`.

### Step 6: Rewrite the tests

In `test/simulate.test.ts` (model new tests on the existing structure —
`deploy`/`write` helpers stay; Anvil nightly now matches production RPCs for
reverting `eth_createAccessList` calls, so do not add an access-list shim):

1. **Remove the `it.only` on line 83.** Replace the test "discovers allowance
   gaps from token outflow and attributes the spender" (and delete its
   `console.log`) with:
   - `"discovers allowance slots and applies caller-supplied overrides"`:
     deploy `TestToken` + `Spender`, mint 1_000n to the account. Call
     `discoverAllowanceSlots({ client, owner, pairs: [{ token, spender }] })`
     → expect exactly 1 slot with matching `token`/`spender`. Then
     `simulate({ ..., calls: [pull 321n], tokenSlotOverrides: slots })`
     → `status === "success"`, delta `{ asset: token.address, delta: -321n }`
     (no `spender`/`currentAllowance` keys), and exactly **1** debug event with
     `step === "txSimulator.simulate"` and `phase === "start"`.
2. Replace "uses balance storage overrides for view-only insufficient token
   balances" with `"applies caller-supplied balance overrides for view-only accounts"`:
   same contracts, **no mint**.
   `discoverBalanceSlots({ client, owner, tokens: [token.address] })` → 1 slot.
   Simulate the existing `[approve, pull]` batch with `tokenSlotOverrides` →
   success, delta `-500n`.
3. Replace "verifies proxy token storage slots before overriding balances" with
   the same proxy setup but calling `discoverBalanceSlots` for the proxy token
   and passing the result through — this preserves coverage of the
   sentinel-verification path on proxies.
4. Add one small test `"combines balance and allowance overrides"`: no mint,
   no prior approve; calls `[pull 200n]` only (no approve call), overrides =
   `[...await discoverBalanceSlots({ tokens: [token.address], ... }), ...await discoverAllowanceSlots({ pairs: [{ token, spender }], ... })]`
   → success, delta `-200n`. This pins the concatenation composition the API
   is designed around.
5. In "keeps batch state changes visible between calls", delete the final
   assertion that checks `delta.spender === undefined` (the field no longer
   exists; keeping it is a type error).
6. Leave all other tests untouched.

In `test/mainnet.test.ts`: the USDC transfer test relied on automatic balance
forging (the anvil address holds 0 USDC). Migrate it: first
`discoverBalanceSlots({ client, owner: ANVIL_ACCOUNT, tokens: [USDC], blockNumber })`,
assert 1 slot returned, then pass it as `tokenSlotOverrides` to `simulate` and
keep the existing assertions. Import `discoverBalanceSlots` from
`../src/index.js`. (A direct transfer has no spender — this is why the balance
variant exists standalone.)

**Verify**: `pnpm test` → all pass. `grep -n "it.only" test/` → no matches.

### Step 7: Update README and the plans index

1. `README.md`: delete the final paragraph ("When a high-allowance retry is
   needed, ...") and the sentence in the V1-scope paragraph if it references
   attribution. Add a short section showing the two-step composition:

```ts
import { discoverAllowanceSlots, discoverBalanceSlots, simulate } from "viem-tx-sim";

const [balanceSlots, allowanceSlots] = await Promise.all([
  discoverBalanceSlots({ client, owner: from, tokens: [token] }),
  discoverAllowanceSlots({ client, owner: from, pairs: [{ token, spender }] }),
]);

const result = await simulate({
  client,
  from,
  calls: [{ to, calldata }],
  // optional per-slot amount; defaults to 10^50
  tokenSlotOverrides: [...balanceSlots, ...allowanceSlots],
});
```

   State plainly: `simulate()` never retries or forges state on its own; slot
   discovery results are cacheable per (token, owner[, spender]) and block.
2. `plans/README.md`: set plan 006's status.

**Verify**: `pnpm lint` → exit 0. `grep -n "currentAllowance\|high-allowance" README.md` → no matches.

## Test plan

- New/rewritten tests in `test/simulate.test.ts` (pattern: existing tests in
  the same file): allowance-slot composition happy path, balance-slot
  composition for a zero-balance account, proxy-token slot verification,
  batch test without attribution assertion.
- Migrated `test/mainnet.test.ts` (only runs with `MAINNET_RPC_URL` set — if
  you cannot run it, note that in your report; it must still typecheck).
- Verification: `pnpm test` → all pass; `pnpm typecheck` → exit 0.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0
- [ ] `src/slots.ts` exists and both `discoverBalanceSlots` and `discoverAllowanceSlots` are exported from the package root
- [ ] `grep -rn "spender\|currentAllowance" src/types.ts` matches only the `AllowanceSlot` definition (nothing on `AssetBalanceDelta`)
- [ ] `grep -rn "withSpenderAttribution\|candidateSpenders\|balanceOverridesFor\|InternalSimulationResult\|observedTokens" src/simulate.ts src/slots.ts src/index.ts src/types.ts` → no matches
- [ ] `grep -rn "allowanceSlot.currentAllowance" src/` → no matches
- [ ] `grep -rn "it.only" test/` → no matches
- [ ] `git status --porcelain` shows changes only to in-scope files (beyond the pre-existing dirty files from plans 001–005 — compare against the drift-check diff)
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows in-scope files changed and the "Current state" excerpts
  no longer match the live code.
- `contracts/TxSimulator.sol` or `src/internal/abi.ts` appears to require
  changes — this plan is scoped to TypeScript only; the contract interface must
  not change.
- The rewritten allowance test cannot pass without re-introducing a second
  `runSimulator` pass inside `simulate()` — the single-pass invariant is the
  point of the plan.
- `pnpm test` fails because `anvil`/`forge` are missing from the environment —
  report the missing toolchain rather than skipping tests.
- Deleting the `currentAllowance` read breaks a consumer you can find via
  `grep -rn "currentAllowance" src/ test/` that this plan did not list.

## Maintenance notes

- Slot-discovery results are valid per (token, owner[, spender]) and can be
  cached client-side across `simulate()` calls; they only go stale if a token's
  storage layout changes (proxy upgrade). A future `plans/` item could add
  standard-layout inference (compute `keccak256(spender · keccak256(owner · baseSlot))`
  against the probed slot for base slots 0..64) to cut probe RPC further.
- Reverts caused by genuinely missing balance/allowance are now reported
  honestly as `status: "reverted"` — the caller decides whether to re-run with
  overrides. Wallet-side UX ("you need an approval first") is now the caller's
  job, using its own knowledge of required approvals.
- Reviewer should scrutinize: (1) that overridden tokens are unioned into
  `candidates` in `simulate()` — dropping that silently loses deltas; (2) the
  mainnet test migration, since it can't run in CI without a secret.
- Deferred deliberately: the ERC-4626 "spender is a token" filter bug dies with
  the deleted `candidateSpenders`; no residual fix needed. Removal of the
  now-unused `"eth_getCode"` debug-method member was left out to keep the diff
  minimal.
