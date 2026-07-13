# Notes for walletchan: behaviors from viem-tx-sim worth borrowing back

Hi — [viem-tx-sim](https://github.com/frontier159/viem-tx-sim) is a TypeScript library that grew out of walletchan's bytecode-injection simulation trick (never-deployed `TxSimulator` code placed at the user's own address via `eth_call` state overrides, so `msg.sender` matches reality). While rebuilding the domain as a library we diffed the two implementations carefully, and a handful of things we do differently seem genuinely useful upstream. This note lists only those; it skips everything walletchan does better (probe gas caps, NFT identity capture, checksum normalization, per-method gas ceilings — we're adopting those ourselves).

Citations are pinned to walletchan `470c2767` and viem-tx-sim `3bce89e`. "txSimulation.ts" = `apps/extension/src/chrome/txSimulation.ts`; "your contract" = `apps/contracts/src/utils/TxSimulator.sol`; "our contract" = `contracts/TxSimulator.sol`.

---

## 1. ERC-1271: compare the recovered signer against `address(this)` (correctness bug)

Your ghost's `isValidSignature` returns the magic value whenever `ecrecover` yields **any** non-zero address — it never compares the signer to `address(this)`, doesn't normalize `v`, and only handles 65-byte signatures ([your contract:565-583](https://github.com/apoorvlathey/walletchan/blob/470c2767f8c4b35b399b1e97fc00dd9d1ab9a070/apps/contracts/src/utils/TxSimulator.sol#L565-L583)).

Consequence: during simulation, any well-formed signature from **any** signer validates. A Permit2 `permit()` carrying a wrong-signer or forged signature previews as a clean success, then the real broadcast reverts — a false-positive preview in exactly the flow (permit-based approvals) where the wallet's preview matters most. Note the asymmetry with real-world verification: because the ghost gives the EOA code, Permit2 takes its ERC-1271 branch during simulation but the raw `ecrecover`-and-compare branch on-chain — so the ghost's ERC-1271 must reproduce EOA semantics exactly, or the two paths diverge.

The fix is one comparison plus `v` normalization; supporting EIP-2098 compact 64-byte signatures costs a few more lines. Ours for reference: [our contract:93-95](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L93-L95) and [284-315](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L284-L315):

```solidity
function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
    return _recover(hash, signature) == address(this) ? ERC1271_MAGIC_VALUE : ERC1271_INVALID_VALUE;
}
```

(`_recover` normalizes `v < 27`, rejects invalid `v`, and handles both 65-byte and EIP-2098 64-byte encodings.)

## 2. Capture revert data and the failing call index

Your contract discards the inner call's returndata — `(success, ) = to.call{value}(data)` ([your contract:112](https://github.com/apoorvlathey/walletchan/blob/470c2767f8c4b35b399b1e97fc00dd9d1ab9a070/apps/contracts/src/utils/TxSimulator.sol#L112)) — and `simulateBatch` continues past failures with only an aggregate `allSuccess` flag ([your contract:370-377](https://github.com/apoorvlathey/walletchan/blob/470c2767f8c4b35b399b1e97fc00dd9d1ab9a070/apps/contracts/src/utils/TxSimulator.sol#L370-L377)). So a failed preview can tell the user "this will fail" but never *which call* or *why*.

We capture the raw revert bytes in-contract and halt at the first failure with its index ([our contract:155-170](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L155-L170), [190-194](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L190-L194)), then decode TS-side: `Error(string)`, `Panic(uint256)`, caller-supplied custom-error ABIs, and always the 4-byte selector as a fallback ([src/internal/simulator.ts:226-246](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/src/internal/simulator.ts#L226-L246)). The confirmation UI can then show "call 2 of 3 reverts: `InsufficientAllowance(0, 500000000)`" instead of a generic failure banner.

Two independent pieces here, adoptable separately:

- **Returndata capture** is nearly free: keep the `bytes memory` and return it.
- **Halt-at-first-failure** is right for the atomic (ERC-7821/7702) batches you route through `simulateBatch`: on-chain, call N+1 never executes after call N reverts, so deltas that include post-failure calls describe a sequence that cannot happen. Continue-past-failure is arguably right for *non-atomic* EOA batches where the wallet keeps broadcasting — if you keep it there, splitting the two semantics (a flag or second entry point) would make each mode honest.

## 3. Verify forged storage slots before trusting them

Your retry path picks the balance/allowance slot as "the token's first access-list storage key that isn't a known EIP-1967 proxy slot" and writes to it unverified ([txSimulation.ts:724-763](https://github.com/apoorvlathey/walletchan/blob/470c2767f8c4b35b399b1e97fc00dd9d1ab9a070/apps/extension/src/chrome/txSimulation.ts#L724-L763)). For vanilla tokens that works; for anything unusual — packed slots, `balanceOf` reading multiple slots (rebasing/shares-based tokens like stETH or aTokens), fee-on-transfer bookkeeping, unusual proxy layouts — it silently writes a huge number into the *wrong* slot and the retry simulation runs on garbage state, producing a confident, wrong preview.

The verification costs one extra `eth_call` per token: write a sentinel value to the candidate slot via `stateDiff`, re-read `balanceOf`/`allowance` under that override, and accept the slot only if the read returns exactly the sentinel; otherwise try the next candidate key, and if none verifies, *skip the token rather than forge it* ([src/internal/probes.ts:49-94](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/src/internal/probes.ts#L49-L94)). Given the retry only fires occasionally, the extra call is cheap insurance against previews that are wrong rather than merely incomplete.

Related detail: we deliberately forge allowances to a large **non-max** value (`10^50`) instead of `MAX_UINT256` ([txSimulation.ts:848-853](https://github.com/apoorvlathey/walletchan/blob/470c2767f8c4b35b399b1e97fc00dd9d1ab9a070/apps/extension/src/chrome/txSimulation.ts#L848-L853) uses max). Standard ERC-20s (and Permit2's own uint160 amount) skip the allowance decrement at exactly max, so a max override erases the allowance-consumption signal from the simulation — invisible today, but it forecloses ever displaying "this tx consumes X of your approval" from the retry path, and it makes the forged state one step further from any reachable real state.

## 4. Don't silently gift the account 100,000 ETH

Every simulation overrides `from`'s balance to `parseEther("100000")` ([txSimulation.ts:1181](https://github.com/apoorvlathey/walletchan/blob/470c2767f8c4b35b399b1e97fc00dd9d1ab9a070/apps/extension/src/chrome/txSimulation.ts#L1181)). That makes value-carrying previews work for impersonated/watched accounts — but for a *signing* user who genuinely can't fund `value + gas`, the preview shows a clean success for a transaction that will fail. An asset-change preview that can't be wrong about affordability is worth protecting: consider simulating with the real balance by default and applying the big override only when needed (watch-only mode, or as a fallback tagged in the result so the UI can badge it "balance was assumed"). We keep the default honest and make native forging an explicit opt-in ([src/txSimulator.ts:203-206](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/src/txSimulator.ts#L203-L206)); an insufficient-balance failure then surfaces as a real revert the user can act on.

## 5. Distinguish "no change" from "couldn't read" in probes

In `_computeDeltas`, a candidate whose `balanceOf` reverts reads as 0 on both sides, yields delta 0, and is compacted away ([your contract:332-365](https://github.com/apoorvlathey/walletchan/blob/470c2767f8c4b35b399b1e97fc00dd9d1ab9a070/apps/contracts/src/utils/TxSimulator.sol#L332-L365)) — indistinguishable from a token that genuinely didn't move. With your (good) 100k probe gas caps, a slow-but-legitimate token now lands in this bucket too. We carry a per-probe `ok` flag out of the contract (ANDed across every checkpoint) and report failed probes as "unresolved" instead of omitting them ([our contract:220-232](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L220-L232)), so the UI can say "couldn't verify token X" rather than implying it didn't change. One `bool[]` in the return tuple.

## 6. Per-call checkpoints and gross-outflow tracking (feature idea)

Your snapshot model is one `balanceOf` sweep before and after the whole batch — a net signed delta per token. Two things that model can't see, both cheap in the same loop you already run:

- **Per-call attribution**: we record a balance checkpoint after every call (a flat grid of `calls + 1` readings per probe) and reconstruct `byCall[i] = row[i+1] − row[i]` TS-side, with the invariant `sum(byCall) === netDelta` ([our contract:132-188](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L132-L188); [src/internal/checkpoints.ts](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/src/internal/checkpoints.ts)). In a batch confirmation UI this turns "USDC −500 overall" into "approve: 0, swap: −500" per row.
- **Gross vs net**: tracking the per-token *minimum* balance across call boundaries gives `maxOutflow = before − min` — the batch's peak exposure, not its net result ([our contract:196-206](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L196-L206), [83-90](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/contracts/TxSimulator.sol#L83-L90)). A batch that spends 500 USDC and gets 499 back nets −1 but momentarily hands 500 to a router; for a security-oriented preview, the 500 is the number the user should see.

The same checkpoint machinery extended to `allowance()` reads is how we *measure* what a path actually requires — per-call allowance drawdowns under forged state, with in-batch `approve`/`permit` calls excluded and results clamped against physical token outflow ([src/internal/requirements.ts:184-219](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/src/internal/requirements.ts#L184-L219)). That's what lets a wallet render "this needs exactly 500 USDC and an approval of 500 to 0xRouter" instead of forging blindly and hoping — potentially a nicer end-state for your retry path, which today can only display what a hypothetical fully-funded run would do.

## 7. Small robustness items

- **Classify reverts structurally, not by prose.** Provider revert messages vary; JSON-RPC error code `3` on the error's cause chain is the stable signal (with a `/revert/i` message fallback). We got bitten by exact-string matching against geth wording and switched ([src/internal/rpc.ts:127-146](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/src/internal/rpc.ts#L127-L146)); your `.catch(() => [])` fallbacks around `eth_createAccessList` would benefit from the same distinction between "call reverted" (fine, use partial results — geth returns a partial access list *with* an `error` field, which is still usable) and "provider refused" (worth surfacing).
- **Pin the hand-written ABI to the compiled artifact.** Your extension encodes calls against TS-side ABI strings for a contract that lives in another package; a drift test comparing them to the forge artifact catches silent skew at CI time. Ours for the pattern: [test/abi.test.ts](https://github.com/frontier159/viem-tx-sim/blob/3bce89e/test/abi.test.ts).

---

## Summary table

| # | Item | Type | Size |
|---|------|------|------|
| 1 | ERC-1271: compare signer to `address(this)`, normalize `v` | correctness bug | S |
| 2 | Return revert data + failing call index; halt on failure for atomic batches | preview quality | S–M |
| 3 | Sentinel-verify forged slots; skip instead of forging wrong state; non-max allowance values | correctness of retry path | M |
| 4 | Real native balance by default; badge forged-balance previews | preview honesty | S |
| 5 | Per-probe ok flag: "couldn't read" ≠ "didn't change" | preview honesty | S |
| 6 | Per-call checkpoints, gross-outflow, allowance measurement | feature | M–L |
| 7 | Structural revert classification; ABI drift guard | robustness | S |

Happy to talk through any of these — and thanks for publishing walletchan; the injection technique, the probe gas caps, and the empirically-derived provider gas ceilings all shaped viem-tx-sim directly.
