---
"viem-tx-sim": patch
---

`balanceQueries.forUser`/`discoverErc20s` now degrade to direct call-target candidates when the provider rejects eth_createAccessList for an unfunded `from` (matching `estimateRequirements`'s existing fallback) instead of throwing `AccessListUnsupportedError`.
