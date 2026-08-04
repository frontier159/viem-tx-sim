---
"viem-tx-sim": patch
---

Declares `typescript` as an optional peer dependency at `>=5.9`, matching the version CI compiles the packed tarball's declarations with. The floor was already real policy but was expressed only in a CI pin; consumers can now see it in the manifest. TypeScript stays optional, so JavaScript consumers are unaffected.
