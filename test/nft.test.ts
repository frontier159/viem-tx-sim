import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, type Address, type Hex } from "viem";

import { TxSimulator } from "../src/index.js";
import { deploy } from "./helpers/contracts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

describe("nft capture", () => {
  let ctx: AnvilTestContext;
  let sim: TxSimulator;

  beforeEach(async () => {
    ctx = await startAnvil();
    sim = TxSimulator.create({ client: ctx.publicClient });
  });

  afterEach(() => {
    ctx?.stop();
  });

  const nativeQuery = () => [{ asset: "native" as const, account: ctx.account.address }];

  // Anvil is not in viem's typed RPC schema; cast the request fn without introducing `any`.
  async function setStorageAt(address: Address, slot: Hex, value: Hex) {
    await (
      ctx.publicClient.request as unknown as (args: {
        method: "anvil_setStorageAt";
        params: [Address, Hex, Hex];
      }) => Promise<unknown>
    )({ method: "anvil_setStorageAt", params: [address, slot, value] });
  }

  const SLOT_0 = `0x${"00".repeat(32)}` as const;
  const SLOT_1 = `0x${"00".repeat(31)}01` as const;
  // An address-like value left-padded to 32 bytes (~1.2e48) — what a Safe proxy's slot-0 singleton
  // pointer or a dirty 7702 account looks like. Read as an array length it is astronomically large.
  const DIRTY_SLOT_0 =
    `0x000000000000000000000000d9db270c1b5e3bd161e8c8503c55ceabee709552` as const;

  function call(
    contract: { abi: readonly unknown[]; address: Address },
    fn: string,
    args: readonly unknown[],
  ) {
    return {
      to: contract.address,
      data: encodeFunctionData({ abi: contract.abi, functionName: fn, args }),
    };
  }

  it("captures nothing when nftQueries is absent or empty", async () => {
    const nft = await deploy(ctx, "MockERC721.sol", "MockERC721");
    const mint = call(nft, "safeMint", [ctx.account.address, 1n]);

    const withoutQueries = await sim.simulate({
      from: ctx.account.address,
      calls: [mint],
      balanceQueries: nativeQuery(),
    });
    expect(withoutQueries.status).toBe("success");
    expect(withoutQueries.nftReceipts).toEqual([]);

    const withEmptyQueries = await sim.simulate({
      from: ctx.account.address,
      calls: [mint],
      balanceQueries: nativeQuery(),
      nftQueries: [],
    });
    expect(withEmptyQueries.status).toBe("success");
    expect(withEmptyQueries.nftReceipts).toEqual([]);
  });

  it("records a safe-transfer receipt via the receiver hook", async () => {
    const nft = await deploy(ctx, "MockERC721.sol", "MockERC721");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "safeMint", [ctx.account.address, 7n])],
      balanceQueries: nativeQuery(),
      nftQueries: [nft.address],
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts).toHaveLength(1);
    expect(result.nftReceipts[0]).toMatchObject({
      collection: nft.address,
      tokenId: 7n,
      amount: 1n,
      standard: "erc721",
    });
    // MockERC721 has no tokenURI, so metadata capture leaves tokenUri undefined.
    expect(result.nftReceipts[0]?.tokenUri).toBeUndefined();
  });

  it("enumerates plain-mint Enumerable tokens the receiver hook never sees", async () => {
    const nft = await deploy(ctx, "EnumerableMint721.sol", "EnumerableMint721");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "mint", [ctx.account.address, 2n])],
      balanceQueries: nativeQuery(),
      nftQueries: [nft.address],
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts.map((r) => r.tokenId)).toEqual([0n, 1n]);
    for (const receipt of result.nftReceipts) {
      expect(receipt).toMatchObject({ collection: nft.address, amount: 1n, standard: "erc721" });
    }
  });

  it("dedups a token seen by both the hook and the Enumerable walk", async () => {
    const nft = await deploy(ctx, "EnumerableMint721.sol", "EnumerableMint721");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "safeMint", [ctx.account.address, 1n])],
      balanceQueries: nativeQuery(),
      nftQueries: [nft.address],
    });

    expect(result.status).toBe("success");
    // Hook fires (safeMint) and the token is Enumerable — it must appear exactly once.
    const keys = result.nftReceipts.map((r) => `${r.collection}:${r.tokenId}`);
    expect(keys).toEqual([`${nft.address}:0`]);
  });

  it("captures heavy on-chain metadata under the gas budget", async () => {
    const nft = await deploy(ctx, "HeavyMetadataNft.sol", "HeavyMetadataNft");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "safeMint", [ctx.account.address, 3n])],
      balanceQueries: nativeQuery(),
      nftQueries: [nft.address],
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts).toHaveLength(1);
    expect(result.nftReceipts[0]?.tokenId).toBe(3n);
    expect(result.nftReceipts[0]?.tokenUri).toMatch(/^data:application\/json;base64,/);
  });

  it("survives a hostile collection without poisoning other captures", async () => {
    const nft = await deploy(ctx, "MockERC721.sol", "MockERC721");
    const gasBurner = await deploy(ctx, "GasBurner.sol", "GasBurner");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "safeMint", [ctx.account.address, 5n])],
      balanceQueries: nativeQuery(),
      nftQueries: [gasBurner.address, nft.address],
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts).toHaveLength(1);
    expect(result.nftReceipts[0]).toMatchObject({ collection: nft.address, tokenId: 5n });
  });

  it("keeps receipts from calls that ran before a later revert", async () => {
    const nft = await deploy(ctx, "MockERC721.sol", "MockERC721");
    const reverting = await deploy(ctx, "RevertingTarget.sol", "RevertingTarget");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        call(nft, "safeMint", [ctx.account.address, 9n]),
        { to: reverting.address, data: "0x" },
      ],
      balanceQueries: nativeQuery(),
      nftQueries: [nft.address],
    });

    expect(result.status).toBe("reverted");
    if (result.status !== "reverted") return;
    expect(result.failingCallIndex).toBe(1);
    expect(result.nftReceipts).toHaveLength(1);
    expect(result.nftReceipts[0]).toMatchObject({ collection: nft.address, tokenId: 9n });
  });

  // F1 regression: the ghost runs under a CODE-only override, so a smart-contract-wallet `from`
  // keeps its real storage (e.g. a Safe proxy's singleton at slot 0). With capture state at low
  // slots, slot 0 read as an array length OOMs the result copy; slot 1 phantom-enables recording.
  // Hashed namespaced slots make both harmless.
  it("captures correctly when `from` has dirty low storage slots (smart-wallet ON path)", async () => {
    const nft = await deploy(ctx, "MockERC721.sol", "MockERC721");
    await setStorageAt(ctx.account.address, SLOT_0, DIRTY_SLOT_0);
    await setStorageAt(ctx.account.address, SLOT_1, `0x${"00".repeat(31)}01`);

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "safeMint", [ctx.account.address, 7n])],
      balanceQueries: nativeQuery(),
      nftQueries: [nft.address],
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts).toHaveLength(1);
    expect(result.nftReceipts[0]).toMatchObject({
      collection: nft.address,
      tokenId: 7n,
      amount: 1n,
      standard: "erc721",
    });
  });

  it("does not phantom-record when `from` has a dirty slot 1 (smart-wallet OFF path)", async () => {
    const nft = await deploy(ctx, "MockERC721.sol", "MockERC721");
    await setStorageAt(ctx.account.address, SLOT_0, DIRTY_SLOT_0);
    await setStorageAt(ctx.account.address, SLOT_1, `0x${"00".repeat(31)}01`);

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "safeMint", [ctx.account.address, 1n])],
      balanceQueries: nativeQuery(),
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts).toEqual([]);
  });

  // F3 regression: a hostile tokenURI returning ~200KB within its gas budget forces the OUTER frame
  // to copy that returndata. The size cap drops it (tokenUri undefined) instead of expanding toward OOG.
  it("drops oversized metadata instead of OOMing the return copy", async () => {
    const nft = await deploy(ctx, "MetadataBombNft.sol", "MetadataBombNft");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [call(nft, "safeMint", [ctx.account.address, 4n])],
      balanceQueries: nativeQuery(),
      nftQueries: [nft.address],
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts).toHaveLength(1);
    expect(result.nftReceipts[0]).toMatchObject({ collection: nft.address, tokenId: 4n });
    expect(result.nftReceipts[0]?.tokenUri).toBeUndefined();
  });

  // F4: two ERC-1155 transfers of the same (collection, id) in one batch aggregate into one receipt.
  it("aggregates duplicate ERC-1155 receipts for the same (collection, id)", async () => {
    const erc1155 = await deploy(ctx, "MockERC1155.sol", "MockERC1155");

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        call(erc1155, "mint", [ctx.account.address, 42n, 3n]),
        call(erc1155, "mint", [ctx.account.address, 42n, 4n]),
      ],
      balanceQueries: nativeQuery(),
      nftQueries: [erc1155.address],
    });

    expect(result.status).toBe("success");
    expect(result.nftReceipts).toHaveLength(1);
    expect(result.nftReceipts[0]).toMatchObject({
      collection: erc1155.address,
      tokenId: 42n,
      amount: 7n,
      standard: "erc1155",
    });
  });
});
