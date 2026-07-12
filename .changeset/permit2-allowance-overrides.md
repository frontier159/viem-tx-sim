---
"viem-tx-sim": minor
---

Add `tokenOverrides.forPermit2Allowances`: sentinel-verified, nonce-preserving Permit2 internal-allowance overrides (new `OVERRIDE_PERMIT2_AMOUNT` sentinel, sized for Permit2's uint160 amount field), so Permit2-routed paths can be simulated under forged approvals.
