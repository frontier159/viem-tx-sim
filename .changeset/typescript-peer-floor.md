---
"viem-tx-sim": patch
---

Declares `typescript` as an optional peer dependency at `>=5.9`. That is the oldest TypeScript CI proves the published declarations are consumable by: the declarations are built with TypeScript 7, then type-checked from a consumer file compiled with TypeScript 5.9 against the packed tarball. The floor was already real policy but was expressed only in a CI pin; consumers can now see it in the manifest. TypeScript stays optional, so JavaScript consumers are unaffected.
