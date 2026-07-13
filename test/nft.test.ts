import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, type Address } from "viem";

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
});
