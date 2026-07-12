# walletchan vs viem-tx-sim — behavior comparison (2026-07-12)

Scope: transaction-simulation / asset-change-preview behavior only. No API/DX commentary.

Sources, both verified against checked-out source (not just secondhand notes):

- **walletchan** — https://github.com/apoorvlathey/walletchan at commit `470c2767f8c4b35b399b1e97fc00dd9d1ab9a070`. Local paths below are relative to the clone root; GitHub form is `https://github.com/apoorvlathey/walletchan/blob/main/<path>`. Key files: `apps/extension/src/chrome/txSimulation.ts` ("txSimulation.ts"), `apps/contracts/src/utils/TxSimulator.sol` ("their contract"), `apps/extension/src/chrome/batchGasEstimation.ts`.
- **viem-tx-sim** — this repo at `3bce89e` (master). Key files: `contracts/TxSimulator.sol` ("our contract"), `src/internal/simulator.ts`, `src/internal/rpc.ts`, `src/txSimulator.ts`, `src/internal/requirements.ts`, `src/internal/probes.ts`, `src/internal/slots.ts`, `src/internal/checkpoints.ts`.

Both systems share the same core trick: never-deployed `TxSimulator` runtime bytecode injected at the user's own address via `eth_call` `stateOverride.code`, so `address(this) == from` and downstream contracts see `msg.sender == from`. walletchan is the original; viem-tx-sim was inspired by it and rebuilt the domain as a library.

---

## A. Top-level feature comparison

| Feature | walletchan | viem-tx-sim |
|---|---|---|
| Ghost-bytecode injection at `from` | Yes (txSimulation.ts:1172-1186) | Yes (src/internal/simulator.ts:102-134) |
| Sequential batch in one EVM frame | Yes (`simulateBatch`, their contract:152-186) | Yes (unified `simulate(calls[], ...)`, our contract:57-91) |
| Native (ETH) delta | Net delta only, for `address(this)` only (their contract:101,115) | Per-call checkpoints for **any** account via `token == address(0)` probes (our contract:256-263) + gross max outflow (our contract:83) |
| ERC-20 deltas | Net signed delta per candidate, filtered in-contract to non-zero (their contract:332-365) | before/after/delta/`byCall` per explicit balance query, from checkpoint grid (src/internal/checkpoints.ts:29-65) |
| Per-call delta attribution (`byCall`) | No | Yes (pinned invariant: `sum(byCall) === delta`, zero tail after failing call) |
| Balance probes for accounts other than `from` | No (`balanceOf(address(this))` only, their contract:229-238) | Yes (`BalanceProbe { token, account }`, our contract:23-26) |
| Allowance observation / measurement | No | Yes (allowance checkpoint grid, our contract:208-218; requirements math, src/internal/requirements.ts:184-219) |
| Asset-requirement estimation (needed balances/approvals) | No — only a one-shot forged retry of the same simulation (txSimulation.ts:1118-1128) | Yes (`estimateRequirements`: recon + forged measurement, gross outflows, in-batch approve/permit exclusion, physical clamp) |
| Forged token balances (state override) | Yes, auto retry path; slot = first non-proxy access-list key, **unverified**; amount `10^30` (txSimulation.ts:734-763, 817) | Yes, explicit; slot **sentinel-verified**; amount `OVERRIDE_TOKEN_AMOUNT = 10^50`, max rejected (src/internal/probes.ts:49-94; src/internal/simulator.ts:297-300) |
| Forged ERC-20 allowances | Yes, ERC-20→Permit2 only, set to `MAX_UINT256` (txSimulation.ts:848-853) | Yes, arbitrary (token, spender) pairs, sentinel amount, base-slot inference + probe fallback (src/internal/slots.ts) |
| Forged **Permit2** internal allowances (triple-nested mapping, nonce-preserving) | Yes (txSimulation.ts:854-896) | **No** |
| Revert reporting | Boolean `success` only; returndata discarded in-contract (their contract:112); `simulationFailed` string for infra errors | `status: "reverted"` with `revertData`, selector, `Error`/`Panic`/custom-ABI decode, `failingCallIndex`; typed errors for infra (src/internal/simulator.ts:166-183, 226-246) |
| Failing-call index in a batch | No (batch continues past failures, their contract:370-377) | Yes (halts at first failure, our contract:155-170) |
| NFT tokenId / amount / tokenURI capture | Yes — receiver-hook storage capture + ERC-721 Enumerable fallback + `nextTokenId()` fallback + post-state `tokenURI`/`uri` capture (their contract:246-544) | No — hooks exist only so safe transfers don't revert; nothing recorded (our contract:97-111) |
| ERC-165 `supportsInterface` on the ghost | Yes (their contract:551-556) | **No** (no fallback either — unknown selectors revert, by design) |
| ERC-1271 `isValidSignature` | Yes, but accepts **any** recoverable 65-byte signature (see §C) | Yes, requires recovery `== address(this)`, 65-byte + EIP-2098 64-byte, `v` normalization (our contract:93-95, 284-315) |
| Per-probe gas caps in the contract | Yes — 100k probes, 5M metadata, 500k return reserve (their contract:36-47) | **No** — uncapped `staticcall` in `_tryBalanceOf`/`_tryAllowance` (our contract:248-254, 265-275) |
| Gas caps on RPC requests | 10M for `eth_createAccessList` + single-tx `eth_call`; 50M for batch `eth_call` (txSimulation.ts:122, 136) | One knob, default 16M, applied to both `eth_call` and `eth_createAccessList` (src/constants.ts:7; src/txSimulator.ts:144; src/internal/rpc.ts:93) |
| Automatic native balance override at `from` | Always: `parseEther("100000")` (txSimulation.ts:1181) | Never automatic in `simulate()`; opt-in `nativeBalanceOverrides` (src/txSimulator.ts:203-206); `estimateRequirements` forges `10^50` wei (src/internal/requirements.ts:103) |
| Address checksum normalization before RPC | Yes, explicit `getAddress(from/to)` to avoid `-32602` on casing-sensitive RPCs (txSimulation.ts:1026-1034) | Override map addresses normalized (src/internal/simulator.ts:264); **`account`/`to` of the call passed as given** (src/internal/simulator.ts:127-128) |
| `eth_simulateV1` usage | Yes — non-atomic batch dual-path merge + gas tier 1 (txSimulation.ts:2189-2428; batchGasEstimation.ts:180-310) | No |
| Batch gas estimation | Yes — 3-tier: `eth_simulateV1` → `simulateBatchGas` bytecode injection → per-call `eth_estimateGas`, 2× EIP-150 buffer (batchGasEstimation.ts:76-468) | No (out of scope) |
| EIP-7702 delegate-code override for gas estimation | Yes (gasEstimation.ts:205-211, 287-323) | No |
| ERC-7715 `redeemDelegations` special case | Yes — skips injection, static calldata decode (txSimulation.ts:909-986) | No |
| Metadata/pricing enrichment, retry loops, post-confirm log extraction | Yes (wallet product features) | No (out of scope for a library) |
| Deterministic ordering, debug-event RPC accounting, pinned RPC counts | No | Yes (DEBUG_STEPS vocabulary; tests pin exact call counts) |
| Foundry regression tests for the contract | 2 (gas-burning probe, heavy metadata — apps/contracts/test/TxSimulator.t.sol) | Full TS integration suite against Anvil; ABI-drift guard (test/abi.test.ts) |

### Prose highlights

**Asset-type coverage.** Both detect ERC-20 via `balanceOf(address)` and native via `address(this).balance` (ours also via arbitrary-account probes). Both are blind to outgoing ERC-1155 and to ERC-1155 balances generally (the two-arg `balanceOf(address,uint256)` never matches the one-arg probe). walletchan additionally recovers **incoming** NFT identity: ERC-721/1155 tokenIds and amounts through receiver hooks, plus two enumeration fallbacks and post-state `tokenURI` capture. viem-tx-sim sees NFTs only as `balanceOf` count deltas and documents token-ID ownership as out of scope.

**Batch modes.** walletchan distinguishes atomic (ERC-7821/7702) from non-atomic (plain EOA) batches; the non-atomic path runs `eth_simulateV1` and bytecode injection **concurrently** and merges (ERC-20/native from v1 transfer logs, NFTs and the revert verdict from the bytecode path — Alchemy's `eth_simulateV1` was observed to false-positive-revert valid approve+swap batches, txSimulation.ts:2486-2496). viem-tx-sim has a single batch model: sequential calls in one frame, atomic revert semantics.

**Revert reporting** is the largest quality gap in walletchan's favor of viem-tx-sim: walletchan reduces a revert to a boolean; viem-tx-sim returns the revert payload, decodes it, and pinpoints the failing call.

**Robustness hardening** is the largest gap in viem-tx-sim's favor of walletchan: per-probe gas caps (regression-tested against a hostile `balanceOf` that infinite-loops), explicit checksum normalization for casing-sensitive RPC proxies, and empirically-derived per-method gas caps.

---

## B. Implementation differences between common features

### B1. Ghost-bytecode injection (the `eth_call`)

Both call `client.call({ account: from, to: from, data: encoded, stateOverride: [{ address: from, code: BYTECODE, ... }] })`.

| Aspect | walletchan | viem-tx-sim |
|---|---|---|
| Gas on the call | `10_000_000n` single (txSimulation.ts:1176), `50_000_000n` batch (txSimulation.ts:2055) — split because "most RPC providers accept 50M+ for `eth_call` while still capping `eth_createAccessList` at ~10M" (txSimulation.ts:124-136) | `DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n` for everything (src/constants.ts:7), overridable per call/instance (src/txSimulator.ts:144) |
| Balance override at `from` | Always `parseEther("100000")` so value-carrying calls never fail on funds (txSimulation.ts:1181; rationale in `_docs/ASSET_CHANGES_SIMULATION.md`) | None by default — a real insufficient native balance surfaces as the inner call failing (low-level `.call{value}` returns `false` → `status: "reverted"` with empty `revertData`). Opt-in via `nativeBalanceOverrides` (src/txSimulator.ts:203-206) |
| Nonce/other overrides | None beyond code+balance | Code, plus token `stateDiff`s and native balance entries merged per address, later slot-writes win (src/internal/simulator.ts:260-291) |
| Address casing | `from`/`to` checksummed with `getAddress` before every RPC — documented workaround for `-32602` from `mainnet.base.org` when viem checksums the override key but leaves `from` lowercase (txSimulation.ts:1026-1034) | Only override addresses normalized (`normalizeAddress` in `buildStateOverride`, src/internal/simulator.ts:264); the call's `account`/`to` use `args.from` verbatim (src/internal/simulator.ts:127-128) — a lowercase `from` reproduces exactly the casing mismatch walletchan patched |
| Failure handling | Empty `eth_call` response → empty non-failed-looking result with `txSuccess: false` (txSimulation.ts:1188-1191); thrown errors → `simulationFailed: true` + message string | Thrown or undecodable → typed `StateOverrideUnsupportedError` (src/internal/simulator.ts:137-154) |
| Conditional second `eth_call` | Yes — revert-with-zero-changes triggers a forged-override retry (txSimulation.ts:1118-1128) | Never — public `simulate()` is pinned at exactly one `eth_call`, zero access lists (test-pinned) |

### B2. Access-list candidate discovery

| Aspect | walletchan | viem-tx-sim |
|---|---|---|
| Where it runs | Inline in every simulation (single tx: txSimulation.ts:1079-1109; batch: 1979-2014) | Only in helpers (`balanceQueries.forUser`/`discoverErc20s`, src/internal/queryDiscovery.ts:30-37; `estimateRequirements`, src/internal/requirements.ts:44-51) — never in `simulate()` |
| Shape (single tx) | 1 `eth_createAccessList` on the raw user tx, gas 10M | N per-call `eth_createAccessList` in parallel; candidates = `[call.to, ...accessList.address]` per call, rebuilt from the indexed array so ordering stays deterministic (src/internal/simulator.ts:191-218) |
| Shape (batch) | 1 `eth_createAccessList` over the batch encoded as an ERC-7821 `execute(mode, executionData)` **self-call** (txSimulation.ts:1964-1989) — captures cross-call dependencies but only works when `from` is a real on-chain 7821 account; falls back to N parallel per-call lists, each `.catch → []` (txSimulation.ts:1993-2014) | Always N per-call lists; each list is traced against pre-batch state, so addresses only reachable after an earlier call's state change can be missed (documented README limitation) |
| Failure fallback | Whole-call throw → `candidates = [to]` and the simulation still runs (txSimulation.ts:1106-1109); observed cause: Alchemy rejecting `createAccessList` for zero-ETH `from` accounts | Execution reverts are classified structurally (JSON-RPC code 3 on the cause chain or `/revert/i`) and normalized to `[]` — still yields `call.to` candidates; also accepts a returned access list even when the node attaches an `error` field (geth returns partial lists on revert) (src/internal/rpc.ts:113-119, 130-146). Any **non-revert** failure throws `AccessListUnsupportedError`; only `estimateRequirements` degrades further, and only for `/insufficient (funds\|balance)/i` → `candidates = calls.map(to)` (src/internal/requirements.ts:52-55) |
| Gas on the request | Always `SIMULATION_GAS_LIMIT` (10M) — chosen because "Alchemy mainnet rejects 30M while accepting ≤ ~10M for eth_createAccessList" (txSimulation.ts:110-122) | The same default 16M as the `eth_call` flows into `gas` on every `eth_createAccessList` (src/internal/simulator.ts:205 → src/internal/rpc.ts:93) — above walletchan's empirically observed ~10M Alchemy ceiling |

### B3. Balance snapshots / checkpoints & attribution math

- **walletchan**: one `balanceOf` sweep before, one after the whole (batch of) call(s), signed net delta per candidate, non-zero entries compacted in Solidity (their contract:314-365). No per-call granularity, no record of whether a probe *worked* (revert reads as 0 both sides → delta 0 → dropped). Gross outflow, minimum balances, and allowances are not tracked.
- **viem-tx-sim**: a checkpoint grid — for each probe, `calls.length + 1` readings (before everything, then after each call), stride `calls.length + 1`, row-major (our contract:65-69, 208-232). TS reconstructs `before = row[0]`, `after = row[len]`, `byCall[i] = row[i+1] - row[i]` (src/internal/checkpoints.ts:13-65). `balanceProbeOk` is per-probe AND across all checkpoints; failed probes go to `unresolved` instead of silently reading 0 (our contract:230; src/internal/checkpoints.ts:43-46). Separately, `_updateMinBalances` after every successful call feeds `maxTokenOutflows = before − min` and `maxNativeOutflow` — gross flow, not net (our contract:172-174, 196-206, 83-90).
- Net effect: walletchan can tell you "USDC −500 overall"; viem-tx-sim can tell you "call 0: −500, call 1: +499, probe verified at every step, max intra-batch USDC exposure 500".

### B4. Sequential batch execution & failure semantics

Both loop `to.call{value}(data)` in one frame so earlier state changes are visible to later calls. They diverge on failure:

- **walletchan** `simulateBatch` sets `allSuccess = false` and **keeps executing** remaining calls (their contract:370-377). Deltas reflect the whole hypothetical sequence including calls after the failure; there is no failing-call index and no revert payload. (This incidentally approximates non-atomic EOA semantics, where a wallet may keep broadcasting after one tx reverts — but walletchan uses the same function for atomic batches, where continuing is wrong.)
- **viem-tx-sim** halts at the first failure, records `failingCallIndex` and the raw `revertData`, and fill-forwards the last checkpoint value across remaining offsets so `byCall` entries from the failing call onward are exactly `0n` (our contract:155-170, 234-246). This models atomic revert-all semantics and is a pinned invariant.

### B5. State-override forging of balances / allowances

| Aspect | walletchan (`buildRetryOverrides`, txSimulation.ts:809-903) | viem-tx-sim (`tokenOverrides.*`, src/internal/probes.ts + slots.ts) |
|---|---|---|
| Trigger | Automatic: first simulation reverted AND zero tokens/ethDelta observed (txSimulation.ts:1118-1128) | Explicit caller action (`forBalances`/`forAllowances`/`estimateRequirements`) |
| Slot discovery | `eth_createAccessList` on `balanceOf(user)` / `allowance(owner,spender)`; take the token's storage keys, subtract 3 known EIP-1967 proxy slots, use **the first remaining key without verification** (txSimulation.ts:724-763) | Same access-list probe, then each candidate slot is **sentinel-verified**: write the sentinel via `stateDiff`, re-read, accept only if the read returns exactly the sentinel (src/internal/probes.ts:49-94). Unverifiable → `unresolved`, state untouched |
| RPC economy | Balance + allowance probes for all candidates in `Promise.all`; one `eth_getStorageAt` per Permit2 slot (txSimulation.ts:820-823, 874-878) | Per-token-group allowance **base-slot inference**: probe one pair, brute-force base `0..64` against `keccak(spender, keccak(owner, base))`, then compute remaining pairs' slots directly with a single verify call each, falling back to probing if the computed slot fails (src/internal/slots.ts:88-212) |
| Amounts written | Balance: `10^30` ("large but not max, avoids overflow"); ERC-20→Permit2 allowance: `MAX_UINT256`; Permit2 packed record: max 48-bit expiration + max 160-bit amount with the **on-chain nonce preserved** (read via `getStorageAt`; overwriting it would break `permit()` signature checks) (txSimulation.ts:815-817, 848-896) | Everything: `OVERRIDE_TOKEN_AMOUNT = 10^50`, deliberately non-max so `transferFrom` allowance decrements stay observable; `MAX_UINT256` is rejected with a typed error (src/constants.ts:15; src/internal/simulator.ts:297-300) |
| Permit2 | First-class: derives the triple-nested `allowance[owner][token][spender]` slot from Permit2 slot 0 via three nested keccaks (txSimulation.ts:862-876) | Not supported — allowance probing speaks only the ERC-20 `allowance(owner,spender)` selector, which Permit2 does not implement |
| Purpose | Make a reverting preview produce *some* asset-change display (impersonator accounts, missing approvals) | Measure exactly which balances/approvals the path requires (`estimateRequirements` recon → forge → measure → clamp) |

### B6. Revert surfacing

- Both split "the transaction would revert" (data) from "the simulation infrastructure failed" (walletchan: `simulationFailed` + message string; viem-tx-sim: typed `TxSimError` subclasses).
- **walletchan** propagates only the boolean; the inner call's returndata is discarded at the Solidity level (`(success, ) = to.call…`, their contract:112) so no decode is possible even in TS. On a batch there is no failing index.
- **viem-tx-sim** captures returndata in-contract (our contract:190-194), returns it with `failingCallIndex`, and decodes `Error(string)`/`Panic(uint256)` plus caller-supplied custom-error ABIs, always exposing the 4-byte selector (src/internal/simulator.ts:226-246).

---

## C. `TxSimulator.sol` side-by-side

Theirs: `apps/contracts/src/utils/TxSimulator.sol` (587 lines, `pragma ^0.8.26`, https://github.com/apoorvlathey/walletchan/blob/main/apps/contracts/src/utils/TxSimulator.sol). Ours: `contracts/TxSimulator.sol` (316 lines, `pragma ^0.8.24`). Both diffed directly for this report.

### Entry points

| | walletchan | viem-tx-sim |
|---|---|---|
| Single call | `simulate(address to, uint256 value, bytes data, address[] candidates) → (bool, int256 ethDelta, address[] tokens, int256[] deltas, NftReceived[])` (theirs:86-129) | none — single call is a 1-element batch |
| Batch | `simulateBatch(BatchCall[], address[] candidates)` — same returns (theirs:152-186) | `simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes, BalanceProbe[] balanceProbes) → SimulationResult` struct (ours:57-91) |
| Gas measurement | `simulateBatchGas(BatchCall[]) → (bool, uint256[] gasUsedPerCall)` — `gasleft()` deltas + 21000 intrinsic + per-byte calldata gas (4/16) so values are usable as tx gas limits (theirs:198-226) | none |

### Snapshot / delta mechanics

- **Theirs**: pre-call `PreSnapshot { balances, nextTokenIds }` per candidate (theirs:314-326); post-call `_computeDeltas` re-reads `balanceOf`, produces signed `int256` net deltas, compacts non-zero entries in-contract (theirs:332-365). All balance reads target `address(this)` only. Native: single `int256 ethDelta = after − before` (theirs:101, 115).
- **Ours**: `_snapshotTokens` classifies candidates (`isToken`, `beforeBalances`, `minBalances`, `observedScratch`) (ours:115-130); per-call loop records allowance + balance **checkpoint grids** at offsets `0..calls.length` with stride `calls.length + 1` (ours:132-188, 208-232), updates min balances after each successful call (ours:196-206), and returns raw grids — delta math lives in TS. Balance probes accept arbitrary `(token, account)` and treat `token == address(0)` as native `account.balance` (ours:256-263). Allowance probes read `allowance(address(this), spender)` (ours:208-218, 265-275).
- **Aggregate vs per-call**: theirs is aggregate-only; ours is per-call with a fill-forward tail on failure so post-failure per-call deltas reconstruct to exactly `0n` (ours:234-246).
- **Gross outflow**: only ours — `maxTokenOutflows[i] = before − min`, `maxNativeOutflow = nativeBefore − nativeMin` (ours:83-90).

### Failure semantics

- Theirs: `_executeCalls` continues after a failed sub-call, `allSuccess = false`, returndata discarded (theirs:112, 370-377).
- Ours: break at first failure, capture `failingCallIndex` + `revertData` (ours:155-170, 190-194).

### Gas budgeting

- Theirs: every probe `staticcall` carries `{gas: PROBE_GAS_LIMIT}` = 100k (`_tryBalanceOf` theirs:229-238, `_tryNextTokenId` theirs:458-464, `_tryOwnerOf` theirs:467-473, Enumerable walk theirs:424). Metadata calls get `min(gasleft() − 500k, 5M)` and the loop breaks at budget 0 rather than reverting (theirs:523-544). Regression-tested: a target whose fallback infinite-loops on the `balanceOf` selector cannot hide the native delta (apps/contracts/test/TxSimulator.t.sol:45-66); a `tokenURI` burning ~3000 keccaks still gets captured (t.sol:68-93).
- Ours: **no gas caps anywhere** — `_tryBalanceOf`/`_tryAllowance` are bare `staticcall`s (ours:248-254, 265-275). A hostile or pathological `balanceOf`/`allowance` can consume 63/64 of remaining gas per probe; since our probes run once per candidate per call boundary, a few such burns can OOG the entire `eth_call`, which the TS layer then misreports as `StateOverrideUnsupportedError` (infrastructure failure).

### Receiver hooks / ERC-165 / ERC-1271

- **Hooks**: theirs are stateful — each pushes `NftReceived { token: msg.sender, tokenId, amount, standard }` into storage slot 0 (guaranteed empty per `eth_call`) (theirs:69-72, 246-299). Ours are `pure` selector-returners only (ours:97-111): they exist so `safeTransferFrom`/`_safeMint` into the injected account doesn't revert, and record nothing.
- **ERC-165**: theirs advertises ERC-165 + ERC-721-receiver (`0x150b7a02`) + ERC-1155-receiver (`0x4e2312e0`) (theirs:551-556). Ours has neither `supportsInterface` nor a `fallback()` — an unknown selector reverts (deliberate: don't fake interfaces the account lacks), which means a contract that pre-checks `supportsInterface` before a safe transfer sees a revert during simulation that would not occur against the real code-less EOA.
- **ERC-1271**: materially different.
  - Theirs (theirs:565-583): `pure`, 65-byte signatures only, and returns the magic value whenever `ecrecover(hash, v, r, s) != address(0)` — i.e. **any well-formed signature from any signer validates**. No `v` normalization, no comparison against `address(this)`.
  - Ours (ours:93-95, 284-315): recovers and requires `signer == address(this)`; normalizes `v < 27`, rejects invalid `v`; additionally supports EIP-2098 compact 64-byte signatures.
  - Consequence: walletchan's version can validate signatures that the real Permit2/EOA verification would reject (false-positive preview); ours reproduces real EOA verification semantics.

### NFT / tokenURI machinery (theirs only)

Three capture paths, all bounded by `MAX_ENUMERATE_PER_COLLECTION = 50` and deduped via a linear `_alreadyCaptured` scan (theirs:443-454):

1. Receiver hooks (safe transfers / `_safeMint`) (theirs:246-282).
2. ERC-721 Enumerable walk of `tokenOfOwnerByIndex(this, idx)` over `[before, after)` for candidates with positive delta ≤ 50 — catches plain-`_mint` Enumerable contracts like Uniswap V3's position manager (theirs:407-438).
3. `nextTokenId()` counter walk `[nextBefore, nextAfter)` with `ownerOf(id) == address(this)` filtering — catches Uniswap V4's PositionManager (theirs:488-511).

Then `_captureTokenUris` staticcalls `tokenURI(id)`/`uri(id)` **after** the inner call so state-dependent on-chain SVG renderers reflect post-tx state, storing raw ABI return bytes decoded TS-side (theirs:513-537). Nothing comparable exists in our contract.

### Return encoding

- Theirs: positional tuple `(bool, int256, address[], int256[], NftReceived[])`; `NftReceived` carries `bytes tokenUriRaw`.
- Ours: one `SimulationResult` struct with the flat checkpoint grids, `observedTokens`, outflow aggregates, `balanceProbeOk`, `failingCallIndex`, `revertData` (ours:28-38) — mirrored 1:1 by the TS ABI with a drift-guard test (src/internal/simulator.ts:60-67; test/abi.test.ts).

### Things each contract does that the other doesn't

- Only theirs: probe/metadata gas caps; NFT identity capture (3 paths) + post-state tokenURI; ERC-165; `simulateBatchGas` with intrinsic+calldata gas accounting; continue-past-failure batches.
- Only ours: allowance checkpoints; balance probes for arbitrary accounts and native-by-`address(0)`; per-call checkpoint grids with fill-forward; min-balance / gross-outflow tracking; revert-data capture + failing index; correct signer-bound ERC-1271 with EIP-2098; per-probe ok-tracking (`balanceProbeOk`).
