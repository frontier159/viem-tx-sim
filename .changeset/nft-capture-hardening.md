---
"viem-tx-sim": patch
---

Harden NFT capture: capture state moved to namespaced hashed storage slots (smart-contract-wallet `from` no longer OOMs or phantom-records under code-only overrides), metadata return copies capped at 64KB, and duplicate (collection, tokenId) receipts aggregated.
