---
"viem-tx-sim": minor
---

`OVERRIDE_TOKEN_AMOUNT` is now `10^45` (previously `10^50`): still non-max so ERC-20 and Permit2 allowance decrements stay observable, now also below `type(uint160).max` so the same sentinel forges Permit2's packed uint160 amount, with additional headroom under ray-style fixed-point math.
