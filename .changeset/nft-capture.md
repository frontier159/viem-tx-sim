---
"viem-tx-sim": minor
---

Add opt-in NFT capture. Pass `nftQueries` (ERC-721/1155 collection addresses) to `simulate` and read the new `nftReceipts` (`NftReceipt[]`, exported) on both result variants to see which token ids `from` received during simulation — via receiver hooks (safe transfers / `_safeMint`) and an ERC-721 Enumerable walk (plain `_mint` on Enumerable collections such as Uniswap V3 positions), with best-effort post-state `tokenUri`/`uri` metadata under a gas budget. Duplicate `(collection, tokenId)` receipts are aggregated. Omitting `nftQueries` is behaviour-identical to before (empty `nftReceipts`, no added cost, still one `eth_call`). The ghost contract now compiles with `viaIR` (required for the extended return struct; also shrinks the runtime bytecode).
