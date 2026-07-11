# viem-tx-sim

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
