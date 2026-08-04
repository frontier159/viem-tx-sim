---
"viem-tx-sim": patch
---

Builds the published JavaScript and type declarations with the TypeScript 7 native compiler (`typescript` devDependency `^7.0.2`). No source, API, or tsconfig change. The emitted declarations stay consumable by older TypeScript: CI typechecks the packed tarball against TypeScript 5.9, and that pin is deliberately held below the build version.
