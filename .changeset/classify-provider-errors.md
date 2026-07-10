---
"viem-tx-sim": patch
---

Classify access-list reverts and unfunded-wallet errors on structured signals (JSON-RPC error code 3, a case-insensitive `revert` / `insufficient funds|balance` match) instead of exact geth-worded English substrings, so balance-query discovery and requirement estimation keep working across Erigon/Besu/Nethermind and proxy RPC providers that word errors differently.
