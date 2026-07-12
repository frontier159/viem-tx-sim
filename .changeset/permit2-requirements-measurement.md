---
"viem-tx-sim": minor
---

`estimateRequirements` now forges and measures Permit2 internal allowances on Permit2-routed paths, reporting them as `permit2Allowances` (with `unresolved.permit2Slots`/`unresolved.permit2Allowances`); paths that never touch Permit2 are unchanged.
