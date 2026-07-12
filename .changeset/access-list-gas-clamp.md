---
"viem-tx-sim": patch
---

eth_createAccessList requests now default to 10M gas (new exported `ACCESS_LIST_GAS_LIMIT`) when no gas is supplied and respect explicitly supplied gas verbatim, instead of silently clamping caller values above 10M; eth_call gas is unchanged.
