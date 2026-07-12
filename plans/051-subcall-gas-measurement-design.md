# Plan 051: Design spike — per-call gas measurement for non-atomic batches

> **Executor instructions**: This is a DESIGN plan: the deliverable is a design
> document, not code. Do not modify anything under `src/`, `contracts/`, or
> `test/`. Follow the steps, honor STOP conditions, and update the status row
> for this plan in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 3bce89e..HEAD -- contracts/TxSimulator.sol src/internal/simulator.ts`
> Material drift changes the design constraints — re-read before writing and
> note the drift in the design doc.

## Status

- **Priority**: P3
- **Effort**: L (design only)
- **Risk**: LOW (no code changes)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `3bce89e`, 2026-07-12

## Why this matters

Dependent calls in a non-atomic ERC-5792 batch (swap-after-approve) cannot be `eth_estimateGas`-ed standalone — the swap's estimate is only meaningful *after* the approve's state change, so each call needs measuring inside the sequential execution the ghost already performs. walletchan solves this with a dedicated bare-loop entry point (`simulateBatchGas()`): `gasleft()` deltas per call, plus 21000 intrinsic and per-byte calldata gas so results are usable as transaction gas limits, with consumers applying a flat 2× buffer to compensate for EIP-150's 63/64 forwarding dilution through deep call trees (see `docs/walletchan-learnings-2026-07-12.md` item 8, and `docs/walletchan-comparison-2026-07-12.md` for the 3-tier estimation cascade it sits in).

This is a real consumer problem (gas limits for non-atomic 5792 batches) but outside the library's asset-change scope today, hence P3 and a design spike: the central technical question — measurement pollution — needs settling before anyone writes an implementation plan. Our `simulate()` entry point interleaves probe work (balance snapshots, checkpoint recording) between calls, so `gasleft()` deltas taken there would include probe overhead; walletchan measures around a **bare loop in a separate entry point** for exactly this reason.

## Current state (constraints the design must honor)

- `contracts/TxSimulator.sol:132-188` — `_executeCalls`: the sequential loop, with `_updateMinBalances` + checkpoint recording between calls (the pollution source).
- A second entry point on the ghost extends the contract ABI: `txSimulatorAbi` (`src/internal/simulator.ts:60-67`), `test/abi.test.ts` (one-directional — a new contract function needs a TS declaration only if TS calls it, which it would here), and bytecode regeneration are all in play.
- Pinned invariants: public `simulate()` = one `eth_call`, zero access lists — a gas-measurement helper must be a **separate opt-in method** (its own eth_call), never bolted onto `simulate()`.
- The intrinsic-gas arithmetic (21000 + calldata bytes: 4/zero-byte, 16/nonzero-byte, plus any EIP-7623 floor considerations) is TS-side; the contract only measures execution gas.
- Prior art in-repo: the `balanceQueries`/`tokenOverrides` namespaces show where a `gas.*` or similar helper would live (`src/txSimulator.ts:63-125`).

## Scope

**In scope**: create `docs/design/batch-gas-measurement-design-<YYYY-MM-DD>.md`; update `plans/README.md` status row.

**Out of scope**: ALL code; writing the follow-up implementation plan (the design doc proposes it; a human decides).

## Steps

### Step 1: Read the inputs

Read fully: `docs/walletchan-comparison-2026-07-12.md`, `docs/walletchan-learnings-2026-07-12.md` (item 8), `contracts/TxSimulator.sol`, and walletchan's implementation via GitHub: the contract's gas entry point (https://github.com/apoorvlathey/walletchan/blob/main/apps/contracts/src/utils/TxSimulator.sol, roughly lines 198-226) and the consumer cascade (https://github.com/apoorvlathey/walletchan/blob/main/apps/extension/src/chrome/batchGasEstimation.ts, roughly lines 286-304).

### Step 2: Write the design document

Decided recommendations (not option lists) for:

1. **Entry point shape**: the bare-loop function signature on the ghost (calls in, per-call gas out; revert behavior on a failing call — halt-and-report like `simulate()` or measure-to-failure), and whether it shares `_executeCall` or duplicates the loop to stay probe-free.
2. **Public surface**: method name/namespace, args (calls + the same state-override options as `simulate()`? token overrides matter — an unfunded account can't measure a swap), result shape (per-call execution gas, per-call suggested limit, batch total).
3. **Accuracy model**: where intrinsic + calldata gas is added (TS-side), whether the 2× EIP-150 buffer is applied by the library or documented as consumer responsibility (walletchan: consumer-side flat 2×; state the recommendation and why), and honest error bars (state changes between simulation and broadcast, per-call warm/cold access divergence when calls broadcast as separate transactions — each real tx starts with cold state, but the sequential simulation warms it: quantify the direction of that error).
4. **Cost to the invariants**: exact RPC-count story (one new eth_call per estimate), ABI lockstep updates, bytecode regen authorization, new debug step names.
5. **What NOT to build**: the `eth_simulateV1` tier and per-chain gas-model registry from walletchan's cascade (already rejected in the learnings doc — restate why in one line each).
6. **A sketch of the follow-up implementation plan**: steps, in-scope files, test plan (including a dependent-calls fixture: approve-then-pull where standalone estimation of call 2 would revert).
7. **Do-nothing option**: state plainly what consumers can do today without this feature (their own eth_estimateGas after broadcast of prior calls; padding heuristics) so the maintainer can judge whether the feature clears the bar at all.

Citations: GitHub URL + lines for walletchan claims; `file:line` for this repo.

### Step 3: Index

Update this plan's row in `plans/README.md` to DONE with a pointer to the design doc; add the proposed implementation to "Deferred findings" as awaiting a maintainer decision. Do NOT create the implementation plan file.

## Done criteria

- [ ] `docs/design/batch-gas-measurement-design-<date>.md` exists, answers all 7 questions with decided recommendations and citations
- [ ] No files under `src/`, `contracts/`, or `test/` modified (`git status`)
- [ ] No changeset (docs only)
- [ ] `plans/README.md` updated (status row + deferred entry)

## STOP conditions

- Any step appears to require a code change.
- The walletchan sources have drifted from the pinned analysis commit `470c2767` — switch to commit-pinned URLs (`.../blob/470c2767/...`) and continue.

## Maintenance notes

- If the maintainer reads the design's question 7 and decides the feature doesn't clear the bar, mark the deferred entry REJECTED with that rationale — a clean "no" is a valid outcome of this spike.
