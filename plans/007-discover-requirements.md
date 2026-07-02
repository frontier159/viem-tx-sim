# Plan 007: Add optional discoverRequirements() — measure required balances and approvals from the batch calls

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> 1. `grep -n "| 006 |" plans/README.md` → the status must be `DONE`. If it is
>    not, STOP: this plan builds on plan 006's API and cannot proceed.
> 2. `ls src/slots.ts` → file exists, and `grep -n "discoverBalanceSlots\|discoverAllowanceSlots" src/index.ts`
>    → both exported. If not, STOP (006 not actually landed).
> 3. `git diff --stat c4ec468..HEAD -- contracts/TxSimulator.sol src/internal/abi.ts`
>    → contract and ABI excerpts below were taken at `c4ec468` (plan 006 does
>    not touch them); if they changed beyond that, compare excerpts before
>    proceeding and STOP on mismatch.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/006-caller-supplied-slot-overrides.md (must be DONE)
- **Category**: direction
- **Planned at**: commit `c4ec468`, 2026-07-02 (written before 006 was executed — see drift check)

## Why this matters

After plan 006, `simulate()` applies caller-supplied slot overrides and never
guesses. That is right for callers who statically know which {token, spender,
amount} tuples their transaction needs. But a wallet simulating an *arbitrary*
dapp transaction doesn't know them. This plan adds an **optional, additive**
flow — `discoverRequirements()` — that measures them: it forges generous
balances/allowances for every plausible (token, spender) pair, runs one
instrumented simulation, and reads the requirements off observed state changes
(allowance decreases identify the spender and the exact amount; per-call
balance checkpoints give gross outflows). Measurement replaces the old deleted
attribution heuristics: when two spenders pull the same token, each pair's own
allowance decrease attributes them unambiguously.

It also introduces standard-layout slot inference: after one access-list probe
per token, allowance slots for additional spenders are computed locally
(Solidity mapping keccak math), verified with a single sentinel `eth_call`,
and only fall back to full access-list probing for non-standard tokens. This
cuts the O(pairs) probe cost that made the old pipeline expensive.

Callers who already know their requirements keep using
`discoverBalanceSlots()` / `discoverAllowanceSlots()` + `simulate()` untouched.

## Current state

Relevant files (state after plan 006):

- `contracts/TxSimulator.sol` — the ghost contract; `simulate(SimulatedCall[] calls, address[] candidates)` snapshots balances before/after and returns deltas. **This plan extends it** (allowance probes, per-call checkpoints).
- `src/internal/abi.ts` — viem `parseAbi` definitions for the simulator and ERC-20 probes. Extended here.
- `src/internal/simulator.ts` — `runSimulator()`: encodes the `eth_call`, injects bytecode at `from`, decodes the result tuple. After 006 it returns `SimulationResult` and ignores the tuple's `observedTokens` field. Extended here (optional probes param, extra decoded fields).
- `src/internal/probes.ts` — after 006: `discoverBalanceSlot` / `discoverAllowanceSlot` (access-list probe + sentinel verify, sentinel is caller-passed) and `readBalanceOf` / `readAllowance` (support `stateOverride`). **Unchanged by this plan** — reused as the fallback path and for verifying computed slots.
- `src/slots.ts` — after 006: public `discoverBalanceSlots` / `discoverAllowanceSlots`. Unchanged.
- `src/simulate.ts` — after 006: single-pass `simulate()` with `tokenSlotOverrides`. **Must not change behavior**; at most the `runSimulator` call site stays valid because the new probes param is optional.
- `src/types.ts` — after 006 holds `BalanceSlot`, `AllowanceSlot`, `TokenSlotOverride`, `SimulateArgs`, `SimulationResult`, `AssetBalanceDelta = { asset, delta }`. New public types added here.
- `src/internal/hex.ts` — `OVERRIDE_TOKEN_AMOUNT = 10n ** 50n` (deliberately **not** `type(uint256).max`, so standard tokens still decrement allowances on `transferFrom`; OZ/solmate/solady skip the decrement only at exactly max), `uint256Hex`, `MAX_UINT256`.
- `src/internal/discovery.ts` — `discoverCandidateAddresses` (access list per call). Unchanged, reused.
- `test/simulate.test.ts` — anvil test patterns: `startAnvil` context and `deploy`/`write` helpers. Anvil nightly now matches production RPCs for reverting `eth_createAccessList` calls, so do not copy or add an access-list shim. Model new tests on the existing helper style; the helpers live inside the describe block, so copy them into the new test file.
- `contracts/test/` — existing test contracts: `TestToken.sol` (mintable ERC-20 with `initialize` for proxy use), `Spender.sol` (`pull(token, amount)` via `transferFrom`), `StoredTokenSpender.sol`, `Permit2Like.sol`, `SimpleProxy.sol`, `RevertingTarget.sol`.

### Contract excerpt — the snapshot/execute/diff core being extended (`contracts/TxSimulator.sol:25-57`, at `c4ec468`)

```solidity
function simulate(
    SimulatedCall[] calldata calls,
    address[] calldata candidates
) external returns (SimulationResult memory result) {
    uint256 nativeBefore = address(this).balance;
    uint256[] memory beforeBalances = new uint256[](candidates.length);
    bool[] memory isToken = new bool[](candidates.length);
    // ... _tryBalanceOf(candidates[i], address(this)) marks isToken / beforeBalances ...

    for (uint256 i; i < calls.length; ++i) {
        (bool ok, bytes memory revertData) = calls[i].to.call{value: calls[i].value}(calls[i].data);
        if (!ok) { result.success = false; result.failingCallIndex = i; result.revertData = revertData; break; }
    }

    result.nativeDelta = _signedDelta(address(this).balance, nativeBefore);
    // ... after-balance loop computes deltaTokens/tokenDeltas ...
}
```

Helpers that exist and must be reused: `_tryBalanceOf(token, owner)` (staticcall,
returns `(bool ok, uint256)`), `_signedDelta`, `_trimAddresses`, `_trimInts`,
`BALANCE_OF_SELECTOR = 0x70a08231`.

### ABI excerpt (`src/internal/abi.ts`, at `c4ec468`)

```ts
export const txSimulatorAbi = parseAbi([
  "struct SimulatedCall { address to; uint256 value; bytes data; }",
  "struct SimulationResult { bool success; uint256 failingCallIndex; bytes revertData; int256 nativeDelta; address[] observedTokens; address[] deltaTokens; int256[] tokenDeltas; }",
  "function simulate(SimulatedCall[] calls, address[] candidates) returns (SimulationResult)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
```

### Conventions to match

- ESM, `.js` import specifiers; optional args threaded via conditional spreads
  (see `src/simulate.ts`). Public types in `src/types.ts`; internals under
  `src/internal/`; every RPC wrapped in `withRpcDebug` with a dotted step name.
- Solidity: 0.8.24, explicit selectors as constants, `_try*` staticcall
  helpers returning `(bool ok, ...)`, scratch-array + `_trim*` pattern.

## Design (read before implementing)

### Measurement model

1. **Candidates** via existing `discoverCandidateAddresses`.
2. **Recon sim** (no overrides) tells us which candidates are tokens.
3. **Spender candidates** = call targets ∪ candidates, minus `from` — and
   **deliberately not filtering out tokens** (an ERC-4626 vault is both a
   token and a spender; the deleted pre-006 pipeline got this wrong).
4. **Slot discovery** for every token's balance slot and every
   (token, spender) allowance slot, using inference (below) to avoid one
   access list per pair.
5. **Measurement sim**: forge ALL discovered slots to `OVERRIDE_TOKEN_AMOUNT`
   and pass the pairs as `allowanceProbes`. The contract snapshots
   `allowance(address(this), spender)` at every call boundary, and tracks the
   running minimum of each candidate token balance and the native balance.
6. **Read requirements off the result**:
   - required balance per token = max cumulative outflow (gross, per-call
     granularity — a batch that pulls 100 then gets 40 back needs 100, not 60);
   - required native = max cumulative native outflow;
   - required allowance per pair = cumulative *decreases* of that pair's
     allowance across checkpoints, **stopping at the first in-batch approve**
     for that pair (a batch like [approve, swap] self-provisions its
     allowance; requirement is only what's pulled before the approve —
     normally zero). In-batch approves are detected TS-side by decoding
     `approve(address,uint256)` (selector `0x095ea7b3`) on calls whose `to` is
     the probed token and whose first argument is the probed spender.
     Increases are ignored (an approve overwrites the forged sentinel and
     would otherwise register as a huge bogus "decrease" relative to it —
     which is exactly why the ledger stops at the approve).

Why allowance decreases are trustworthy: the forge sentinel is `10^50`, not
`type(uint256).max`, so standard tokens still decrement on `transferFrom`.
Tokens that skip the decrement for any "large" (non-max) allowance would
under-report — documented limitation, not handled.

### Slot inference (the "OZ trick")

Solidity storage layout for `mapping(address => mapping(address => uint256))`
at base slot `a`: value slot = `keccak256(abi.encode(spender, keccak256(abi.encode(owner, a))))`.

- Probe the FIRST (token, spenderA) pair the normal way (`discoverAllowanceSlot`:
  1 access list + sentinel verify).
- Try to invert: for `a` in `0..64`, check whether the probed slot equals the
  formula above. On a hit, the base slot is known.
- Every additional spender on that token: compute the slot locally, then
  **verify it with one sentinel `eth_call`** (`readAllowance` with a
  `stateDiff` override at the computed slot must return the sentinel).
- Any failure (no inversion hit, or verify mismatch — proxy with re-based
  storage, Vyper, Solady seed-hashed slots) → **fall back** to the full
  `discoverAllowanceSlot` probe for that pair.

Balance slots get no inference: there is exactly one balance slot per (token,
owner) regardless of spender count, so the existing single probe is already
minimal.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Build contracts + regen bytecode + TS | `pnpm build` | exit 0 (requires `forge`) |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | all pass (requires `anvil`) |
| Lint + format check | `pnpm lint` | exit 0 |
| Format | `pnpm lint:fix` | exit 0 |

`pnpm build:contracts` runs `forge build` then
`scripts/generate-txsim-bytecode.mjs`, which rewrites
`src/generated/txSimulatorBytecode.ts` from the forge artifact — never edit
that file by hand.

## Scope

**In scope** (the only files you should modify/create):

- `contracts/TxSimulator.sol`
- `contracts/test/TokenVault.sol` (create)
- `contracts/test/RefundingSpender.sol` (create)
- `contracts/test/NonStandardSlotToken.sol` (create)
- `src/internal/abi.ts`
- `src/internal/simulator.ts`
- `src/internal/layout.ts` (create)
- `src/requirements.ts` (create)
- `src/types.ts`
- `src/index.ts`
- `test/requirements.test.ts` (create)
- `README.md`
- `plans/README.md` (status row only)
- `src/generated/txSimulatorBytecode.ts` changes **only** as a build artifact of `pnpm build:contracts`.

**Out of scope** (do NOT touch, even though they look related):

- `src/simulate.ts` and `src/slots.ts` — the plan-006 API must keep working
  byte-for-byte; the new `runSimulator` param must be optional so these files
  need no edits. If you find yourself editing them, STOP.
- `src/internal/probes.ts`, `src/internal/discovery.ts`,
  `src/internal/stateOverride.ts`, `src/internal/hex.ts`,
  `src/internal/rpc.ts`, `src/internal/debug.ts`, `src/internal/address.ts`,
  `src/internal/revert.ts`, `src/errors.ts` — reused as-is.
- `test/simulate.test.ts`, `test/mainnet.test.ts`,
  `docs/motivation.md` — existing behavior is the regression baseline.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend `TxSimulator.sol`

1. Add types/constants:

```solidity
bytes4 internal constant ALLOWANCE_SELECTOR = 0xdd62ed3e;

struct AllowanceProbe {
    address token;
    address spender;
}
```

2. Extend `SimulationResult` with three fields (append, keep existing order):

```solidity
uint256[] maxTokenOutflows;      // parallel to candidates; 0 for non-tokens
uint256 maxNativeOutflow;
uint256[] allowanceCheckpoints;  // flattened: probes.length * (calls.length + 1), row-major per probe
```

3. Change the signature to
   `simulate(SimulatedCall[] calldata calls, address[] calldata candidates, AllowanceProbe[] calldata probes)`.
4. Add `_tryAllowance(address token, address owner, address spender)` modeled
   exactly on `_tryBalanceOf` (staticcall `ALLOWANCE_SELECTOR`; on failure or
   short returndata return `(false, 0)`).
5. Semantics to implement:
   - Checkpoint index 0 (per probe) is recorded before any call executes;
     checkpoint `k+1` after call `k`. A failed probe read records 0.
   - After each executed call, also update per-candidate running minimum
     balance (only for `isToken` candidates) and running minimum native
     balance. `maxTokenOutflows[i] = before >= min ? before - min : 0`;
     `maxNativeOutflow` likewise from `nativeBefore`.
   - On a failing call, `break` as today, then fill every remaining
     checkpoint slot for each probe with that probe's last recorded value (so
     the array is always fully populated).
   - When `probes.length == 0` the extra work must be skipped (existing
     callers pass empty) — guard the checkpoint loops.
6. Keep everything else (`observedTokens`, delta computation,
   `isValidSignature`, `receive`) unchanged.

**Verify**: `forge build` → exit 0, no warnings about `TxSimulator.sol`.

### Step 2: Regenerate bytecode and update the ABI

1. Run `pnpm build:contracts` (regenerates `src/generated/txSimulatorBytecode.ts`).
2. In `src/internal/abi.ts`, update `txSimulatorAbi`:

```ts
"struct AllowanceProbe { address token; address spender; }",
"struct SimulationResult { bool success; uint256 failingCallIndex; bytes revertData; int256 nativeDelta; address[] observedTokens; address[] deltaTokens; int256[] tokenDeltas; uint256[] maxTokenOutflows; uint256 maxNativeOutflow; uint256[] allowanceCheckpoints; }",
"function simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes) returns (SimulationResult)",
```

**Verify**: `pnpm typecheck` → errors only in `src/internal/simulator.ts`
(missing third arg), nowhere else.

### Step 3: Extend `runSimulator`

In `src/internal/simulator.ts`:

1. Add optional args: `allowanceProbes?: readonly { token: Address; spender: Address }[]`.
   Encode `args.allowanceProbes ?? []` as the third `simulate` argument.
2. Extend the decoded-tuple type with `maxTokenOutflows: bigint[]`,
   `maxNativeOutflow: bigint`, `allowanceCheckpoints: bigint[]`.
3. Return type: `SimulationResult & { probeData: ProbeData }` where

```ts
export type ProbeData = {
  observedTokens: Address[];
  candidates: Address[];          // the exact (deduped, ordered) array sent — needed to index maxTokenOutflows
  maxTokenOutflows: bigint[];
  maxNativeOutflow: bigint;
  allowanceCheckpoints: bigint[];
};
```

   Important: `runSimulator` already dedupes candidates via
   `uniqueAddresses()`; `probeData.candidates` must be that deduped array, and
   the encoded call must use the same one, or outflow indexing breaks.
4. `src/simulate.ts` must keep compiling **without edits** (it ignores the
   extra fields on the returned object).

**Verify**: `pnpm typecheck` → exit 0; `git diff --name-only src/simulate.ts src/slots.ts` → empty.

### Step 4: Slot-layout inference in `src/internal/layout.ts`

New internal module using `keccak256` and `encodeAbiParameters` from viem:

```ts
/** keccak256(abi.encode(key, baseSlot)) — Solidity mapping value slot. */
export function mappingSlot(key: Address, baseSlot: Hex | bigint): Hex;

/** Nested allowance slot: mappingSlot(spender, mappingSlot(owner, base)). */
export function allowanceSlotFor(owner: Address, spender: Address, base: bigint): Hex;

/** Try base slots 0..64; return the base whose computed slot matches, else undefined. */
export function inferAllowanceBaseSlot(args: {
  probedSlot: Hex;
  owner: Address;
  spender: Address;
}): bigint | undefined;
```

`mappingSlot` must produce `keccak256` of the 64-byte concatenation of the
32-byte-padded key and 32-byte base slot (`encodeAbiParameters([{ type: "address" }, { type: "uint256" }], ...)`
gives exactly that). Compare slots case-insensitively.

**Verify**: `pnpm typecheck` → exit 0. Sanity check against a known vector:

```sh
node -e "import('./dist/internal/layout.js').then(m => console.log(m.mappingSlot('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 0n)))"
```

(after `pnpm build`) prints a 32-byte hex slot; the anvil test in Step 6
asserts correctness end-to-end against a real probe.

### Step 5: The public `discoverRequirements()` in `src/requirements.ts`

Public types in `src/types.ts`:

```ts
export type RequiredBalance = { token: Address; amount: bigint };
export type RequiredAllowance = { token: Address; spender: Address; amount: bigint };

export type DiscoveredRequirements = {
  /** Outcome of the fully-forged measurement simulation. */
  status: "success" | "reverted";
  /** Max cumulative native outflow across call boundaries. */
  native: bigint;
  balances: RequiredBalance[];
  allowances: RequiredAllowance[];
  /** Verified slots discovered along the way — pass to simulate() as tokenSlotOverrides. */
  slots: TokenSlotOverride[];
  revertData?: Hex;
  revertReason?: string;
  failingCallIndex?: number;
};
```

`src/requirements.ts` exports:

```ts
export async function discoverRequirements(
  args: {
    client: PublicClient;
    from: Address;
    calls: readonly SimulatedCall[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<DiscoveredRequirements>
```

Implementation order (thread gas/debug/block options everywhere, conditional
spreads as in `src/simulate.ts`; sentinel is always `OVERRIDE_TOKEN_AMOUNT`):

1. Validate non-empty calls (`InvalidSimulationInputError`, same message style
   as `simulate`). Normalize calls (default `value: 0n`).
2. `discoverCandidateAddresses(...)` → candidates.
3. Recon sim: `runSimulator({ calls, candidates, allowanceProbes: [] })` →
   `tokens = probeData.observedTokens`.
4. Spenders: `uniqueAddresses([...calls.map(c => c.to), ...candidates])`
   minus `from` (compare via `addressKey`). **Do not filter tokens out.**
5. Balance slots: `discoverBalanceSlot` per token (from `internal/probes.js`).
6. Allowance slots per token: probe the first spender with
   `discoverAllowanceSlot`; on success run `inferAllowanceBaseSlot`. For each
   remaining spender: if a base was inferred, compute the slot with
   `allowanceSlotFor` and verify it (`readAllowance` with
   `stateOverride: [{ address: token, stateDiff: [{ slot, value: uint256Hex(OVERRIDE_TOKEN_AMOUNT) }] }]`
   must return the sentinel — use debug step `"allowanceSlot.computedVerify"`);
   on verify mismatch or no inferred base, fall back to
   `discoverAllowanceSlot` for that pair. Skip pairs where token === spender.
7. Measurement sim: overrides = every discovered balance and allowance slot at
   the sentinel; `allowanceProbes` = the pairs with verified slots (order
   preserved — checkpoint rows are indexed by it);
   candidates = the recon candidates.
8. Compute the result:
   - `balances`: for each `probeData.candidates[i]` that is a token and has
     `maxTokenOutflows[i] > 0n` → `{ token, amount: maxTokenOutflows[i] }`.
   - `native`: `probeData.maxNativeOutflow`.
   - `allowances`: for each probe row (stride `calls.length + 1`): find the
     index of the first call that is an in-batch approve for this pair —
     `call.to === probe.token` (via `addressKey`) and the calldata decodes as
     `approve(address,uint256)` with first arg === probe.spender (use
     `decodeFunctionData` with `erc20WriteAbi` — add
     `"function approve(address spender, uint256 amount) returns (bool)"` to
     `src/internal/abi.ts` as a new small `parseAbi` export; wrap decode in
     try/catch, non-decodable calldata is simply not an approve). Then sum
     `max(0, checkpoint[k] - checkpoint[k+1])` for call indices `k` **before**
     that approve (or all calls when there is none). Emit
     `{ token, spender, amount }` when the sum is > 0.
   - `slots`: all verified balance + allowance slots as `TokenSlotOverride[]`
     (no `amount` field — callers choose).
   - `status`/revert fields: from the measurement sim result.

**Verify**: `pnpm typecheck` → exit 0.

### Step 6: Exports and tests

1. `src/index.ts`: export `discoverRequirements` from `./requirements.js` and
   types `DiscoveredRequirements`, `RequiredAllowance`, `RequiredBalance` from
   `./types.js`.
2. New test contracts in `contracts/test/` (match the existing minimal style —
   see `Spender.sol`):
   - `TokenVault.sol` — a minimal ERC-20 (shares) that is ALSO a spender:
     `deposit(uint256 assets)` does `underlying.transferFrom(msg.sender, address(this), assets)`
     and mints shares 1:1. Constructor takes the underlying token address.
   - `RefundingSpender.sol` — `pull(token, amount)` via `transferFrom`, plus
     `refund(token, amount)` transferring tokens back to `msg.sender`.
   - `NonStandardSlotToken.sol` — ERC-20 whose balances/allowances live at
     non-standard slots via assembly, e.g.
     `keccak256(abi.encode(owner, uint256(0x4242)))` for balances and
     `keccak256(abi.encode(spender, keccak256(abi.encode(owner, uint256(0x4343)))))`
     for allowances — base slots far outside the 0..64 inference window, so
     inference misses and the fallback probe must succeed.
3. New `test/requirements.test.ts` (copy the `startAnvil` setup and
   `deploy`/`write` helpers from `test/simulate.test.ts` — they are
   function-scoped there, not importable).
   Tests, each asserting on `discoverRequirements` output:
   - **vault (token-shaped spender)**: TestToken + TokenVault; no approve; call
     `[vault.deposit(500n)]` → `allowances`
     contains `{ token, spender: vault.address, amount: 500n }`; `balances`
     contains `{ token, amount: 500n }`; `status === "success"`.
   - **two spenders, one token**: two `Spender` deployments pulling 100n and
     250n in one batch → two allowance entries with exact amounts; balance
     requirement 350n.
   - **gross vs net**: RefundingSpender batch `[pull(token, 100n), refund(token, 40n)]`
     → balance requirement `100n` (not 60n).
   - **self-provisioned approve**: batch `[token.approve(spender, 400n), spender.pull(token, 400n)]`
     → NO allowance entry for (token, spender) (ledger stops at the approve);
     balance requirement `400n`.
   - **inference saves probes**: one token, two spenders → exactly **1** debug
     event with `step === "allowanceSlot.accessList"` and at least one with
     `step === "allowanceSlot.computedVerify"`.
   - **non-standard token falls back**: NonStandardSlotToken with two spenders
     → 2 events with `step === "allowanceSlot.accessList"` (fallback probed
     both), and the allowance amounts are still exact.
   - **native**: value-bearing call to an EOA → `native === value`.
   - **plan-006 API regression**: `pnpm test` still passes
     `test/simulate.test.ts` unchanged (no new assertions needed — just do not
     touch the file).

**Verify**: `pnpm test` → all pass, including ≥7 new tests.

### Step 7: README and index

1. `README.md`: add a short "Discovering requirements (optional)" section after
   the slot-discovery section: one paragraph (measures required balances and
   approvals by forging generous state and observing per-call balance and
   allowance changes; amounts are estimates measured under forged state — pad
   them; tokens that skip allowance decrements for large non-max allowances
   under-report) plus a snippet:

```ts
import { discoverRequirements, simulate } from "viem-tx-sim";

const requirements = await discoverRequirements({ client, from, calls });
// requirements.allowances → [{ token, spender, amount }]
// requirements.balances   → [{ token, amount }]
// requirements.slots      → feed to simulate({ ..., tokenSlotOverrides })
```

2. Update this plan's status row in `plans/README.md`.

**Verify**: `pnpm lint` → exit 0.

## Test plan

Covered by Step 6: token-shaped spender (the pre-006 blind spot), exact
multi-spender attribution, gross-vs-net balances, in-batch approve ledger rule,
inference fast path (probe-count assertion via debug events), non-standard
fallback, native requirement. Pattern: `test/simulate.test.ts`. Verification:
`pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0
- [ ] `git diff --name-only` shows NO changes to `src/simulate.ts`, `src/slots.ts`, `src/internal/probes.ts`, `test/simulate.test.ts`
- [ ] `node -e "import('./dist/index.js').then(m => { if (typeof m.discoverRequirements !== 'function') throw new Error('missing'); console.log('ok'); })"` → `ok`
- [ ] `grep -c "allowanceSlot.computedVerify" src/requirements.ts src/internal/*.ts | grep -v ':0'` → at least one file uses the new debug step
- [ ] `test/requirements.test.ts` exists with ≥7 passing tests
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 006 is not DONE (drift check) — everything here assumes its API.
- The extended contract exceeds size or the measurement sim exceeds the 16M
  default gas limit in tests (checkpoint loops are O(calls × (candidates +
  probes)) staticcalls) — report numbers rather than silently raising limits.
- `decodeFunctionResult` on the extended tuple mismatches (field order/ABI
  drift between Step 1 and Step 2) after one fix attempt.
- Implementing the ledger rule requires per-transfer (intra-call) granularity
  to make a listed test pass — the design is call-boundary granularity by
  intent; a test that genuinely needs finer granularity is mis-specified,
  report it.
- You need to modify `src/simulate.ts` or `src/slots.ts` for any reason.

## Maintenance notes

- **Measured-under-forged-state caveat**: amounts come from a world where the
  owner holds 10^50 of everything; contracts that branch on the user's real
  balance (fee tiers, proportional withdrawals) can report amounts from the
  wrong branch. Callers should pad amounts and treat them as estimates —
  keep that in the README, not just here.
- **Allowance-decrement blind spot**: tokens skipping the `transferFrom`
  decrement for large non-max allowances under-report requirements. If this
  bites, the fix is a second measurement sim with a small sentinel, not a
  bigger one.
- Intra-call transients (flash-loan-shaped flows) are invisible at
  call-boundary granularity; finer would need `debug_traceCall`, which breaks
  the raw-RPC design goal. Deliberately deferred.
- The inference window (base slots 0..64) and the Solidity-only formula are
  deliberate scope cuts; Vyper/Solady layouts take the fallback path, which is
  correct but costs one access list per pair. Extending inference is a
  follow-up, not a review blocker.
- Reviewer should scrutinize: checkpoint indexing (row-major stride
  `calls.length + 1`), the deduped-candidates/outflows index alignment in
  `runSimulator`, and that the recon sim's candidate order is reused for the
  measurement sim.
