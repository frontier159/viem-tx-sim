---
"viem-tx-sim": minor
---

Add `tokenOverrides.forPermit2Allowances`: sentinel-verified, nonce-preserving Permit2 internal-allowance overrides (using `OVERRIDE_TOKEN_AMOUNT`, which fits Permit2's uint160 amount field), so Permit2-routed paths can be simulated under forged approvals.
