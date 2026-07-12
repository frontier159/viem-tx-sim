---
"viem-tx-sim": patch
---

Clamp the gas attached to eth_createAccessList requests to 10M (new exported `ACCESS_LIST_GAS_LIMIT`), below the provider ceilings that rejected the 16M simulation default; eth_call gas is unchanged.
