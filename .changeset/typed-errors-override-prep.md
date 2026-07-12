---
"viem-tx-sim": patch
---

Override preparation (`tokenOverrides.forBalances`/`forAllowances`/`forPermit2Allowances`) now throws typed errors (`AccessListUnsupportedError`/`StateOverrideUnsupportedError`) on provider/infrastructure failures instead of silently reporting every token as unresolved; reverting reads still resolve to `unresolved`.
