---
"viem-tx-sim": patch
---

Gas-cap the ghost contract's balanceOf/allowance probe staticcalls (150k) so a hostile or gas-burning token in the candidate list or balance queries degrades to `unresolved` instead of OOG-ing the whole simulation eth_call.
