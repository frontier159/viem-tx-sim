# Design spike: per-call gas measurement for non-atomic 5792 batches

> **Deliverable of plan 051** (`plans/051-subcall-gas-measurement-design.md`). This is a
> design document, not code. It proposes a follow-up implementation plan; a human decides
> whether to schedule it — and question 7 exists so the honest answer can be "don't".
>
> **Written against HEAD** `7351ea0` (plan 051 was stamped at `3bce89e`).
> **walletchan** analysed at commit `470c2767`; the local clone is at that exact commit, so
> citations use the pinned GitHub form
> `https://github.com/apoorvlathey/walletchan/blob/470c2767/<path>#Lxx-Lyy`.

## Drift since the plan was stamped (`3bce89e` → `7351ea0`)

Plans 044–050 landed in between. The drift check
(`git diff 3bce89e..HEAD -- contracts/TxSimulator.sol src/internal/simulator.ts`) shows the
contract changed; `src/internal/simulator.ts` did not. None of it changes this design's
constraints, but the line numbers the plan cites have shifted:

- **Plan 044 (probe gas caps) HAS landed.** `PROBE_GAS_LIMIT = 150_000`
  (`contracts/TxSimulator.sol:15`) now caps `_tryBalanceOf`/`_tryAllowance`. Relevant here only
  as precedent: a gas-measurement entry point must run at a *realistic* outer gas budget, and
  the existing probes already show the contract reasoning about gas stipends.
- **Plan 047 (ERC-165) HAS landed.** `supportsInterface(bytes4)`
  (`contracts/TxSimulator.sol:118-123`) sits between `_executeCalls` and the batch header, so the
  loop the plan cites as `contracts/TxSimulator.sol:132-188` is now `_executeCalls` at
  **`contracts/TxSimulator.sol:144-200`**, with `_executeCall` (the bare per-call primitive) at
  **`contracts/TxSimulator.sol:202-206`**.
- **Plan 048 (Permit2 overrides) landed TS-only.** It added a `tokenOverrides.forPermit2Allowances`
  method (`src/txSimulator.ts:124-…`) and a second sentinel `OVERRIDE_PERMIT2_AMOUNT`
  (`src/constants.ts:26`). It touched neither the `SimulationResult` struct
  (`contracts/TxSimulator.sol:33`) nor the ABI, so the lockstep analysis in question 4 still holds.

`src/internal/simulator.ts` (`txSimulatorAbi` at `:60-67`, `runSimulator` at `:69`) is unchanged.
No walletchan drift: the clone is `470c2767`, matching the pinned analysis commit, so the STOP
condition about walletchan drift does not fire.

## Problem

Dependent calls in a non-atomic ERC-5792 batch — the canonical case is **approve-then-swap** —
cannot be `eth_estimateGas`-ed standalone. Estimating the swap in isolation reverts, because the
approval it depends on hasn't happened; the swap's true gas is only meaningful *after* the
approve's state change. Our ghost already executes the whole batch sequentially in one EVM frame
(`_executeCalls`, `contracts/TxSimulator.sol:144-200`), so each call sees the prior calls' state —
exactly the context standalone estimation lacks. Measuring `gasleft()` deltas around that existing
loop would produce per-call gas that a consumer can use as an EIP-1559 `gas` limit for each leg of
the batch.

walletchan solves this with a dedicated bare-loop entry point, `simulateBatchGas`
([`apps/contracts/src/utils/TxSimulator.sol#L198-L226`](https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L198-L226)):
`gasleft()` deltas per call, plus 21000 intrinsic and 4/16-per-byte calldata gas so the returned
value is usable directly as a tx gas limit. Its consumer applies a **flat 2× buffer**
([`apps/extension/src/chrome/batchGasEstimation.ts#L410-L423`](https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/extension/src/chrome/batchGasEstimation.ts#L410-L423)),
where `simulateBatchGas` is tier 2 of a 3-tier cascade (`eth_simulateV1` → bytecode injection →
per-call `eth_estimateGas`).

**The central technical question is measurement pollution.** Our `simulate()` interleaves probe
work between calls — `_updateMinBalances` and checkpoint recording
(`contracts/TxSimulator.sol:184-198`) run *inside* the loop, between each `_executeCall`. A
`gasleft()` delta taken across that region would count probe overhead as call gas. walletchan
measures around a **bare loop in a separate entry point** for exactly this reason, and that is why
this cannot be bolted onto `simulate()`.

---

## 1. Entry-point shape (on the ghost contract)

**Recommendation.** Add a new external function that **duplicates the loop rather than sharing
`_executeCalls`**, and reuses only the existing `_executeCall` primitive
(`contracts/TxSimulator.sol:202-206`):

```solidity
function simulateBatchGas(SimulatedCall[] calldata calls)
    external
    returns (bool allSuccess, uint256 failingCallIndex, uint256[] memory execGasPerCall)
```

- **Reuse `_executeCall`, not `_executeCalls`.** `_executeCall` is already the minimal
  `to.call{value}(data)` primitive with nothing between the `gasleft()` reads; `_executeCalls`
  carries the probe machinery that is the pollution source. Sharing the outer loop would
  reintroduce exactly the overhead we must exclude. Reusing the inner primitive keeps the two
  paths' execution semantics identical (same value-forwarding, same revert-data discard) while the
  measurement loop stays probe-free.
- **`execGas` only from the contract** — measure `gasBefore - gasleft()` straddling the single
  `_executeCall`, and return *just execution gas*. Intrinsic + calldata gas is added TS-side
  (question 3); walletchan folds it in Solidity
  ([`TxSimulator.sol#L207-L212`](https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L207-L212)),
  but doing the arithmetic in TS keeps the constants (21000, 4/16, the EIP-7623 floor) auditable
  and revisable without a bytecode regen, and matches where this repo already puts intrinsic-gas
  math.
- **Revert behavior: halt-and-report, matching `simulate()`.** walletchan measures-to-failure and
  keeps looping (`if (!ok) allSuccess = false;` but continues,
  [`TxSimulator.sol#L204-L213`](https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L204-L213)).
  That is wrong for this repo: gas measured for calls *after* a failing call is meaningless (they
  ran against a state the real chain never reaches), and continue-past-failure is already a
  rejected posture here (learnings doc, "Deliberately NOT adopting"). Return `failingCallIndex`
  (default `type(uint256).max`) and zero-fill `execGasPerCall` from the failing call onward — the
  same zero-tail convention `simulate()` already pins. A consumer that gets a non-max
  `failingCallIndex` knows the measurement is only valid up to that index.

**Cost note.** This is a new external selector on the ghost, so it needs bytecode regeneration
(question 4). It does **not** touch the `SimulationResult` struct or the `simulate()` path.

## 2. Public surface (the TS API)

**Recommendation.** A new `gas` namespace on the instance, mirroring `balanceQueries.*` /
`tokenOverrides.*` (`src/txSimulator.ts:69-…`), with one method:

```ts
readonly gas: {
  estimateBatch: (args: EstimateBatchGasArgs) => Promise<BatchGasEstimate>;
};
```

- **Args** — take the same execution context as `simulate()`: `from`, `calls`, and the **same
  state-override options** (`tokenSlotOverrides`, `nativeBalanceOverrides`, `extraStateOverrides`,
  block tag, gas budget). This is not optional convenience: an **unfunded account cannot measure a
  swap** — without a forged balance the swap leg reverts and you measure nothing useful. The
  consumer is expected to first run `tokenOverrides.*` / discovery to obtain overrides, then pass
  them here, exactly as they would to `simulate()`. Do **not** run discovery inside `estimateBatch`
  (keeps it single-`eth_call`, mirroring the `simulate()` invariant).
- **Result shape:**
  ```ts
  interface BatchGasEstimate {
    byCall: BatchGasCallEstimate[];   // index-aligned with calls
    totalSuggestedLimit: bigint;      // sum of per-call suggested limits
    failingCallIndex: number | null;  // null when allSuccess
  }
  interface BatchGasCallEstimate {
    executionGas: bigint;             // from the contract
    intrinsicAndCalldataGas: bigint;  // computed TS-side
    suggestedLimit: bigint;           // execution + intrinsic + calldata, pre-buffer (see Q3)
  }
  ```
  Report all three components rather than one opaque number so a consumer can see what went into
  the limit and apply their own buffer policy (question 3). `byCall` entries from `failingCallIndex`
  onward are zero, matching the contract's zero-fill and this repo's existing zero-tail convention.

## 3. Accuracy model

- **Intrinsic + calldata gas is added TS-side**, once per call, on top of the contract's
  `executionGas`: `21000 + calldataGas(data)`, where `calldataGas` is `4 × zeroBytes +
  16 × nonZeroBytes`. This is where the contract deliberately stops (question 1).
- **EIP-7623 floor.** Post-Pectra, the intrinsic calldata cost is
  `max(standardCalldataGas, 10 × tokens)` where `tokens = zeroBytes + 4 × nonZeroBytes` (the "floor"
  applies to calls that do little execution relative to their calldata size). The TS arithmetic
  must compute `21000 + max(4·z + 16·nz, 10·(z + 4·nz))`, not the bare `4/16` walletchan uses —
  walletchan predates caring about it in this path and can under-estimate calldata-heavy, low-exec
  legs. This is a one-line `max`, cheap insurance, and belongs in the TS constant math where it can
  be revised without a bytecode regen.
- **The 2× EIP-150 buffer is the CONSUMER's responsibility, not the library's** — document it,
  don't apply it. Rationale: EIP-150's 63/64 gas-forwarding rule means a limit that merely equals
  raw consumption can OOG at the innermost frame of a deep call tree (0x Settler → V4 PoolManager →
  hooks is 4+ levels), because each `CALL` forwards only 63/64 of remaining gas. walletchan
  compensates with a **flat 2×** applied by its consumer
  ([`batchGasEstimation.ts#L410-L423`](https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/extension/src/chrome/batchGasEstimation.ts#L410-L423);
  same rationale on the `eth_simulateV1` tier,
  [`#L286-L304`](https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/extension/src/chrome/batchGasEstimation.ts#L286-L304)).
  This library returns a **pre-buffer** `suggestedLimit` and documents the recommended 2× (with the
  63/64 reasoning) because the right multiplier is a product decision — a wallet that re-estimates
  at broadcast can use a tighter factor; walletchan's own value is dictated by its refusal to make
  RPC calls at broadcast time, which is not this library's constraint. Baking 2× into the return
  would double every consumer's displayed limit whether or not they want it.
- **Honest error bars (document these prominently):**
  1. **State drift between simulation and broadcast.** Non-atomic 5792 legs broadcast as separate
     transactions across potentially several blocks; pools move, storage changes, and the gas a
     leg actually costs at broadcast can differ from the simulated value. Direction is
     unpredictable; the buffer absorbs modest drift, large drift needs re-estimation.
  2. **Warm/cold access divergence — this one has a *known direction*.** The sequential simulation
     runs all calls in one frame, so call 2 sees storage/accounts that call 1 already **warmed**
     (EIP-2929: 100 gas warm vs 2100 cold SLOAD, 100 vs 2600 for account access). But when the same
     legs broadcast as *separate* transactions, **each real transaction starts with cold state**.
     Therefore the sequential simulation **systematically under-measures** the gas of later calls
     that reuse earlier calls' warmed slots — the real cold-start transaction costs *more*. This
     error compounds with EIP-150 dilution in the same direction (both push the real requirement
     up), which is a second reason the buffer should be generous and applied by the consumer rather
     than a tight library-baked factor. (For an *atomic* batch executed as one transaction the
     warming is real and the measurement is accurate — the divergence is specifically a non-atomic,
     separate-broadcast artifact.)

## 4. Cost to the invariants

- **RPC count: exactly one new `eth_call` per `estimateBatch` call**, zero access lists — the same
  single-`eth_call`, zero-discovery shape as `simulate()`. Discovery, if the consumer needs
  overrides, is their prior separate step (question 2). This does not touch the pinned
  "`simulate()` = one `eth_call`, zero access lists" invariant, because it is a *separate* method
  with its own budget, exactly like `balanceQueries.*` and `tokenOverrides.*`.
- **ABI lockstep.** A new external function is a one-directional ABI addition: `txSimulatorAbi`
  (`src/internal/simulator.ts:60-67`) gains a `simulateBatchGas(...)` line, and the test-helper
  return encoder (`fakeClient.ts`) gains the shape so `test/abi.test.ts` stays green. Unlike the
  `SimulationResult` struct, `simulateBatchGas` returns a flat `(bool, uint256, uint256[])` tuple,
  so there is no struct to keep in three-way sync — only the function signature.
- **Bytecode regeneration IS required and must be explicitly authorized** by the follow-up plan:
  the new selector changes `contracts/TxSimulator.sol` → `pnpm build:contracts` regenerates
  `src/generated/txSimulatorBytecode.ts` (never hand-edited). This is the same plan-gated authority
  plans 044 and 047 carried.
- **New debug step name.** Add one entry to `DEBUG_STEPS` (`src/internal/debugSteps.ts`), e.g.
  `gasEstimateBatch: "gas.estimateBatch"`, emitted by the single `eth_call`. Tests pin it as a
  literal per ADR-0001. No other debug steps change; no existing RPC count changes.

## 5. What NOT to build

Restating from the learnings doc's "Deliberately NOT adopting" so the follow-up plan doesn't
re-propose them:

- **The `eth_simulateV1` tier** (walletchan's cascade tier 1). A second RPC method breaks the
  single-method portability story and the pinned counts, and walletchan's own experience is the
  argument — it hard-codes "never trust `eth_simulateV1`'s revert verdict" after Alchemy
  false-positive-reverted valid approve+swap batches. The bytecode-injection path is the *only*
  tier worth porting.
- **The per-chain gas-model registry / EIP-7702 delegate-code tier.** Wallet-product concerns
  (chain-specific quirks, 7702 account gas models); a library consumer composes these. Out of scope
  at this layer.
- **The flat 2× buffer baked into the library** — a consumer policy, not a library value (see
  question 3).

## 6. Sketch of the follow-up implementation plan

Roughly **M** effort (one new external function, one new TS namespace method, TS intrinsic-gas
math, one fixture). Steps:

1. **Contract:** add `simulateBatchGas(SimulatedCall[]) → (bool, uint256, uint256[])` to
   `contracts/TxSimulator.sol`, looping over `_executeCall` with `gasleft()` deltas and
   halt-and-report zero-fill. Authorize `pnpm build:contracts` bytecode regen in the plan's drift
   check.
2. **ABI:** add the function line to `txSimulatorAbi` (`src/internal/simulator.ts:60-67`) and the
   `fakeClient.ts` return encoder; confirm `test/abi.test.ts`.
3. **TS:** new `runBatchGas` internal (mirror `runSimulator` — build state override, single
   `eth_call`, decode), the intrinsic + calldata + EIP-7623-floor arithmetic (new
   `src/internal/gas.ts` or fold into an existing internal), the `gas.estimateBatch` public method
   on the instance (`src/txSimulator.ts`), the `EstimateBatchGasArgs`/`BatchGasEstimate` types
   (`src/types.ts`), the barrel export (`src/index.ts`), and the `DEBUG_STEPS` entry.
4. **Docs:** README section documenting the recommended 2× buffer and the two error-bar directions
   (state drift; cold-start under-measurement).
5. **Changeset** (this would be a behavior/API-adding change).

**Test plan** (Anvil, per repo convention — one Anvil per test):

- **Dependent-calls fixture (the load-bearing one):** deploy a token + a puller contract; batch =
  `[approve(puller, X), puller.pull(token, X)]`. Assert (a) standalone `eth_estimateGas` of call 2
  reverts (proves the problem is real), and (b) `gas.estimateBatch` returns a non-zero
  `executionGas` for *both* calls with `failingCallIndex === null`.
- **Failing-call fixture:** a batch whose 2nd call reverts → `failingCallIndex === 1`,
  `byCall[1..].executionGas === 0n`, `byCall[0]` measured.
- **Intrinsic/calldata math unit test:** a call with known zero/non-zero byte counts →
  `intrinsicAndCalldataGas` matches `21000 + max(standard, 7623-floor)`; a calldata-heavy,
  low-exec call proves the floor path fires.
- **RPC-count pin:** `gas.estimateBatch` emits exactly one `eth_call` (`gas.estimateBatch` debug
  step), zero access lists.
- **Unfunded-account negative:** a swap batch without balance overrides reverts/zero-fills;
  supplying `tokenSlotOverrides` makes it measure — proving question 2's args requirement.

## 7. Do-nothing option — does this clear the bar?

**What a consumer can do today, without this feature:**

- **Atomic (ERC-7821/7702) batches** already work with the chain's own `eth_estimateGas` on the
  single wrapping transaction — no per-call breakdown needed, because the whole batch broadcasts as
  one tx with one gas limit. This feature adds nothing there.
- **Non-atomic batches with independent legs:** `eth_estimateGas` each call standalone. Fine when
  calls don't depend on each other.
- **Non-atomic batches with *dependent* legs (the only case this feature addresses):** the consumer
  can broadcast call 1, wait for inclusion, *then* `eth_estimateGas` call 2 against the now-updated
  chain state. This is what a wallet does today. The cost is a worse UX — the user can't be shown a
  correct gas limit / total-cost preview for the whole batch *before* approving the first
  transaction — but it is correct and needs no library code. Alternatively, a flat padding
  heuristic (e.g. show call 2 at a fixed generous limit like 300k and let the user edit) ships zero
  code and is what many wallets already do.

**Verdict — a genuine feature, but BELOW the bar for this library as it stands.** The problem is
real (pre-broadcast gas preview for dependent non-atomic 5792 batches is not otherwise solvable
from a single `eth_call`), and the mechanism is a clean fit — the ghost already runs the sequential
loop, and a probe-free measurement variant is a small, well-contained addition. But: (a) it is
**outside the library's stated asset-change-preview scope** (gas limits are a transaction-mechanics
concern, not an asset-change concern); (b) **there is no consumer demand signal on record** (unlike
plan 034's per-call attribution, which had the Origami pull); (c) the accuracy story is
irreducibly soft — the cold-start under-measurement and cross-block state drift mean even a correct
implementation ships a number the consumer must buffer and may still find wrong at broadcast, which
sits awkwardly against this library's "measured, verified, honest error bars" posture; and (d) the
do-nothing path (broadcast-then-estimate, or a padding heuristic) is a real, correct fallback that
covers the common cases. Recommend **deferring as REJECTED-pending-demand**: revisit only if a
consumer building a non-atomic 5792 wallet flow asks for pre-broadcast batch gas preview
specifically. A clean "no for now" is the honest outcome of this spike.
