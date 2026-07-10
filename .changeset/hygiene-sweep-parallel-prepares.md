---
"viem-tx-sim": patch
---

Internal: overlap balance and allowance override preparation in `estimateRequirements` (same RPC calls, lower latency); probe reads parse exactly one 32-byte word. Packaging: viem peer dependency floor corrected to `^2.8.0` (the previous `2.x` range included versions the types cannot compile against).
