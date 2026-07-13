# viem-tx-sim

## 0.3.0

### Minor Changes

- [#16](https://github.com/frontier159/viem-tx-sim/pull/16) [`710ab34`](https://github.com/frontier159/viem-tx-sim/commit/710ab344d401ac3e64fb55537438d0ca43ab1213) Thanks [@frontier159](https://github.com/frontier159)! - Add `gas.estimateBatch`: per-call gas measurement for sequential batches via a probe-free ghost entry point, sizing dependent calls (e.g. approve-then-swap) that `eth_estimateGas` cannot measure standalone. Returns pre-buffer suggested limits with EIP-7623-aware intrinsic math — apply your own EIP-150 headroom buffer (2× recommended).

- [#16](https://github.com/frontier159/viem-tx-sim/pull/16) [`710ab34`](https://github.com/frontier159/viem-tx-sim/commit/710ab344d401ac3e64fb55537438d0ca43ab1213) Thanks [@frontier159](https://github.com/frontier159)! - Add opt-in NFT capture. Pass `nftQueries` (ERC-721/1155 collection addresses) to `simulate` and read the new `nftReceipts` (`NftReceipt[]`, exported) on both result variants to see which token ids `from` received during simulation — via receiver hooks (safe transfers / `_safeMint`) and an ERC-721 Enumerable walk (plain `_mint` on Enumerable collections such as Uniswap V3 positions), with best-effort post-state `tokenUri`/`uri` metadata under a gas budget. Duplicate `(collection, tokenId)` receipts are aggregated. Omitting `nftQueries` is behaviour-identical to before (empty `nftReceipts`, no added cost, still one `eth_call`). The ghost contract now compiles with `viaIR` (required for the extended return struct; also shrinks the runtime bytecode).

- [#16](https://github.com/frontier159/viem-tx-sim/pull/16) [`710ab34`](https://github.com/frontier159/viem-tx-sim/commit/710ab344d401ac3e64fb55537438d0ca43ab1213) Thanks [@frontier159](https://github.com/frontier159)! - Add Permit2 support. `tokenOverrides.forPermit2Allowances` prepares sentinel-verified, nonce-preserving overrides for Permit2's internal `allowance(owner, token, spender)` mapping, so Permit2-routed paths (Universal Router, 0x) can be simulated under forged approvals. `estimateRequirements` now also forges and measures those allowances, reporting them as `permit2Allowances` (with `unresolved.permit2Slots` / `unresolved.permit2Allowances`); paths that never touch Permit2 are unchanged.

- [#16](https://github.com/frontier159/viem-tx-sim/pull/16) [`710ab34`](https://github.com/frontier159/viem-tx-sim/commit/710ab344d401ac3e64fb55537438d0ca43ab1213) Thanks [@frontier159](https://github.com/frontier159)! - `OVERRIDE_TOKEN_AMOUNT` is now `10^45` (previously `10^50`): still non-max so ERC-20 and Permit2 allowance decrements stay observable, now also below `type(uint160).max` so the same sentinel forges Permit2's packed uint160 amount, with additional headroom under ray-style fixed-point math.

### Patch Changes

- [#16](https://github.com/frontier159/viem-tx-sim/pull/16) [`710ab34`](https://github.com/frontier159/viem-tx-sim/commit/710ab344d401ac3e64fb55537438d0ca43ab1213) Thanks [@frontier159](https://github.com/frontier159)! - Robustness and RPC hardening:

  - The ghost contract's `balanceOf`/`allowance`/probe staticcalls are gas-capped (150k) and copy at most 32 bytes of returndata, so a hostile or gas-burning token degrades to `unresolved` instead of out-of-gassing or memory-bombing the whole simulation `eth_call`.
  - `from`/`to` are checksum-normalized on every `eth_call` and `eth_createAccessList`, so lowercase caller addresses no longer draw `-32602` from casing-sensitive RPC proxies.
  - `eth_createAccessList` defaults to 10M gas (new exported `ACCESS_LIST_GAS_LIMIT`) and sends explicitly supplied gas verbatim; `eth_call` gas is unchanged.
  - The ghost answers ERC-165 `supportsInterface` for the receiver interfaces it implements, so safe-transfer flows that pre-check receiver support no longer false-revert during simulation.
  - `balanceQueries.forUser`/`discoverErc20s` degrade to direct call-target candidates when the provider rejects `eth_createAccessList` for an unfunded `from`, instead of throwing `AccessListUnsupportedError`.
  - Override preparation (`tokenOverrides.forBalances`/`forAllowances`/`forPermit2Allowances`) throws typed `AccessListUnsupportedError`/`StateOverrideUnsupportedError` on provider/infrastructure failures instead of silently reporting every token as `unresolved`; reverting reads still resolve to `unresolved`.

## 0.2.3

### Patch Changes

- [#14](https://github.com/frontier159/viem-tx-sim/pull/14) [`bdd624f`](https://github.com/frontier159/viem-tx-sim/commit/bdd624f289631cb0fcf8f9c2d7c51d04fee0230e) Thanks [@frontier159](https://github.com/frontier159)! - Rewrite the README around a concise first-use path, add focused examples for discovery, batches, state overrides, reverts, and debugging, and update the package description.

## 0.2.2

### Patch Changes

- [#11](https://github.com/frontier159/viem-tx-sim/pull/11) [`260887c`](https://github.com/frontier159/viem-tx-sim/commit/260887cde3aa26a3ed4629ee5ff886502563f554) Thanks [@frontier159](https://github.com/frontier159)! - Classify access-list reverts and unfunded-wallet errors on structured signals (JSON-RPC error code 3, a case-insensitive `revert` / `insufficient funds|balance` match) instead of exact geth-worded English substrings, so balance-query discovery and requirement estimation keep working across Erigon/Besu/Nethermind and proxy RPC providers that word errors differently.

- [#11](https://github.com/frontier159/viem-tx-sim/pull/11) [`4dee22b`](https://github.com/frontier159/viem-tx-sim/commit/4dee22b5c3cb254b563449de34888f5437e6e574) Thanks [@frontier159](https://github.com/frontier159)! - Internal: overlap balance and allowance override preparation in `estimateRequirements` (same RPC calls, lower latency); probe reads parse exactly one 32-byte word. Packaging: viem peer dependency floor corrected to `^2.8.0` (the previous `2.x` range included versions the types cannot compile against).

- [#11](https://github.com/frontier159/viem-tx-sim/pull/11) [`8931d7e`](https://github.com/frontier159/viem-tx-sim/commit/8931d7eab7f41329e5e31bfbd822d28af1c5d586) Thanks [@frontier159](https://github.com/frontier159)! - Remove the undocumented generic `DEBUG_RPC=1` env switch for RPC debug logging; use `VIEM_TX_SIM_DEBUG_RPC=1` (now documented in the README).

- [#11](https://github.com/frontier159/viem-tx-sim/pull/11) [`efe89d3`](https://github.com/frontier159/viem-tx-sim/commit/efe89d3135eb0672e3a43a71b4bce2050b649f82) Thanks [@frontier159](https://github.com/frontier159)! - Slim the ghost contract: drop unread nativeDelta/deltaTokens/tokenDeltas from the simulator result; smaller returndata per simulation.

## 0.2.1

### Patch Changes

- [#7](https://github.com/frontier159/viem-tx-sim/pull/7) [`34728ee`](https://github.com/frontier159/viem-tx-sim/commit/34728eeae6a0d62476a9f95d7d783270e8b0d213) Thanks [@frontier159](https://github.com/frontier159)! - Add `nativeBalanceOverrides` to `simulate()` and let `estimateRequirements()` measure native requirements for unfunded accounts.

## 0.2.0

### Minor Changes

- [#5](https://github.com/frontier159/viem-tx-sim/pull/5) [`f7ad02a`](https://github.com/frontier159/viem-tx-sim/commit/f7ad02a7cfa4ca9916d47945c3117c14810688d7) Thanks [@frontier159](https://github.com/frontier159)! - Add required `BalanceDelta.byCall` per-call attribution and replace the simulator contract's `balanceBefore`/`balanceAfter` result arrays with `balanceCheckpoints`.

### Patch Changes

- README: add the mental model, API-at-a-glance summary, TOC, and `byCall` in the getting-started output.

## 0.1.1

### Patch Changes

- Initial release
