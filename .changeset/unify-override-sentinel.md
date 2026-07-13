---
"viem-tx-sim": minor
---

Unify forged-state sentinels: `OVERRIDE_TOKEN_AMOUNT` is now 10^45 (fits Permit2's uint160 amount, adds ray-math overflow headroom, still non-max so allowance decrements stay observable); the separate `OVERRIDE_PERMIT2_AMOUNT` export is removed — use `OVERRIDE_TOKEN_AMOUNT`.
