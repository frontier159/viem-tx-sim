---
"viem-tx-sim": minor
---

Add Permit2 support. `tokenOverrides.forPermit2Allowances` prepares sentinel-verified, nonce-preserving overrides for Permit2's internal `allowance(owner, token, spender)` mapping, so Permit2-routed paths (Universal Router, 0x) can be simulated under forged approvals. `estimateRequirements` now also forges and measures those allowances, reporting them as `permit2Allowances` (with `unresolved.permit2Slots` / `unresolved.permit2Allowances`); paths that never touch Permit2 are unchanged.
