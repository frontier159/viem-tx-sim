---
"viem-tx-sim": patch
---

The ghost contract now answers ERC-165 `supportsInterface` for the ERC-721/ERC-1155 receiver interfaces it implements, so safe-transfer flows that pre-check receiver support no longer false-revert during simulation.
