---
"viem-tx-sim": minor
---

Add `gas.estimateBatch`: per-call gas measurement for sequential batches via a probe-free ghost entry point, sizing dependent calls (e.g. approve-then-swap) that `eth_estimateGas` cannot measure standalone. Returns pre-buffer suggested limits with EIP-7623-aware intrinsic math — apply your own EIP-150 headroom buffer (2× recommended).
