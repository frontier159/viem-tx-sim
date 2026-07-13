---
"viem-tx-sim": patch
---

Probe staticcalls now copy at most 32 bytes of returndata via a bounded assembly read, eliminating the remaining returndata-bomb exposure (a hostile `balanceOf`/`allowance`/probe target can no longer charge the simulation frame memory expansion through an oversized return). The ghost contract also now formally inherits IERC165. No ABI or observable behavior change.
