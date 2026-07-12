---
"viem-tx-sim": patch
---

Checksum-normalize `from`/`to` on every outgoing eth_call and eth_createAccessList so lowercase caller addresses no longer produce mixed-casing requests that some RPC proxies reject with -32602.
