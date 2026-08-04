---
"viem-tx-sim": minor
---

Raises the Node.js engines floor from `>=20` to `>=24`, and moves `@types/node` to match. Node 20 reached end of life on 2026-04-30; the floor now matches the version CI builds and tests with. Consumers on Node 20 or 22 must upgrade to Node 24 or newer. No source change: nothing in the library uses a Node-24-only API.
