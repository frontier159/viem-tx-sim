import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  getAddress,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
} from "viem";

import {
  discoverAllowanceSlots,
  discoverBalanceSlots,
  simulate,
  type SimulationDebugEvent,
} from "../src/index.js";
import { artifact } from "./helpers/artifacts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

describe("viem-tx-sim", () => {
  let ctx: AnvilTestContext;

  beforeEach(async () => {
    ctx = await startAnvil();
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("reports native value deltas", async () => {
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: parseEther("1") }],
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: "native", delta: -parseEther("1") });
  });

  it("emits debug events for simulator RPC calls", async () => {
    const events: SimulationDebugEvent[] = [];
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: parseEther("1") }],
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: "success",
        method: "eth_createAccessList",
        step: "candidateDiscovery.accessList",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: "success",
        method: "eth_call",
        step: "txSimulator.simulate",
      }),
    );
  });

  it("reports ERC-20 balance deltas and filters non-token candidates", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const data = encodeFunctionData({
      abi: token.abi,
      functionName: "transfer",
      args: [ctx.secondAccount.address, 250n],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: token.address, data }],
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: token.address, delta: -250n });
  });

  it("supports safe NFT receipt at the injected account", async () => {
    const nft = await deploy("MockERC721.sol", "MockERC721");
    const data = encodeFunctionData({
      abi: nft.abi,
      functionName: "safeMint",
      args: [ctx.account.address, 1n],
    });

    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: nft.address, data }],
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: nft.address, delta: 1n });
  });

  it("discovers allowance slots for token outflow", async () => {
    const events: SimulationDebugEvent[] = [];
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const allowanceSlots = await discoverAllowanceSlots({
      client: ctx.publicClient,
      from: ctx.account.address,
      pairs: [{ token: token.address, spender: spender.address }],
    });

    expect(allowanceSlots).toContainEqual(
      expect.objectContaining({ token: token.address, spender: spender.address }),
    );

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 321n],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
      tokenSlotOverrides: allowanceSlots,
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: token.address, delta: -321n });
    expect(
      events.filter((event) => event.step === "txSimulator.simulate" && event.phase === "start"),
    ).toHaveLength(1);
    expect(events.some((event) => event.step === "allowanceSlot.currentAllowance")).toBe(false);
  });

  it("infers public allowance slots after one probe", async () => {
    const events: SimulationDebugEvent[] = [];
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spenderA = await deploy("Spender.sol", "Spender");
    const spenderB = await deploy("Spender.sol", "Spender");

    const allowanceSlots = await discoverAllowanceSlots({
      client: ctx.publicClient,
      from: ctx.account.address,
      pairs: [
        { token: token.address, spender: spenderA.address },
        { token: token.address, spender: spenderB.address },
      ],
      debug: (event) => events.push(event),
    });

    expect(allowanceSlots).toEqual([
      expect.objectContaining({ token: token.address, spender: spenderA.address }),
      expect.objectContaining({ token: token.address, spender: spenderB.address }),
    ]);
    expect(
      events.filter(
        (event) => event.step === "allowanceSlot.accessList" && event.phase === "start",
      ),
    ).toHaveLength(1);
    expect(events.some((event) => event.step === "allowanceSlot.computedVerify")).toBe(true);
  });

  it("discovers nested token dependencies from the access list", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("StoredTokenSpender.sol", "StoredTokenSpender", [token.address]);
    await write(token, "mint", [ctx.account.address, 1_000n]);
    await write(token, "approve", [spender.address, 123n]);

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [123n],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: token.address, delta: -123n });
  });

  it("uses caller-supplied balance storage overrides for view-only token balances", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    const balanceSlots = await discoverBalanceSlots({
      client: ctx.publicClient,
      from: ctx.account.address,
      tokens: [token.address],
    });

    expect(balanceSlots).toContainEqual(expect.objectContaining({ token: token.address }));

    const approve = encodeFunctionData({
      abi: token.abi,
      functionName: "approve",
      args: [spender.address, 500n],
    });
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 500n],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: spender.address, data: pull },
      ],
      tokenSlotOverrides: balanceSlots,
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: token.address, delta: -500n });
  });

  it("keeps batch state changes visible between calls", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const approve = encodeFunctionData({
      abi: token.abi,
      functionName: "approve",
      args: [spender.address, 400n],
    });
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 400n],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: spender.address, data: pull },
      ],
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: token.address, delta: -400n });
  });

  it("supports Permit2-style ERC-1271 signature checks caused by code injection", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const permit2 = await deploy("Permit2Like.sol", "Permit2Like");
    await write(token, "mint", [ctx.account.address, 1_000n]);
    const hash = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const signature = await ctx.account.sign({ hash });

    const approve = encodeFunctionData({
      abi: token.abi,
      functionName: "approve",
      args: [permit2.address, 123n],
    });
    const pull = encodeFunctionData({
      abi: permit2.abi,
      functionName: "pullWithSignature",
      args: [token.address, 123n, hash, signature],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: permit2.address, data: pull },
      ],
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: token.address, delta: -123n });
  });

  it("verifies proxy token storage slots before overriding balances", async () => {
    const implementation = await deploy("TestToken.sol", "TestToken", [
      "Implementation",
      "IMPL",
      18,
    ]);
    const initData = encodeFunctionData({
      abi: implementation.abi,
      functionName: "initialize",
      args: ["Proxy Token", "PTKN", 18, zeroAddress, 0n],
    });
    const proxyArtifact = artifact("SimpleProxy.sol", "SimpleProxy");
    const hash = await ctx.walletClient.deployContract({
      abi: proxyArtifact.abi,
      bytecode: proxyArtifact.bytecode,
      args: [implementation.address, initData],
    });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    const proxyToken = {
      address: getAddress(receipt.contractAddress!),
      abi: implementation.abi,
    };
    const spender = await deploy("Spender.sol", "Spender");

    const balanceSlots = await discoverBalanceSlots({
      client: ctx.publicClient,
      from: ctx.account.address,
      tokens: [proxyToken.address],
    });
    expect(balanceSlots).toContainEqual(expect.objectContaining({ token: proxyToken.address }));

    const approve = encodeFunctionData({
      abi: proxyToken.abi,
      functionName: "approve",
      args: [spender.address, 77n],
    });
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [proxyToken.address, 77n],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: proxyToken.address, data: approve },
        { to: spender.address, data: pull },
      ],
      tokenSlotOverrides: balanceSlots,
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: proxyToken.address, delta: -77n });
  });

  it("combines balance and allowance overrides", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    const balanceSlots = await discoverBalanceSlots({
      client: ctx.publicClient,
      from: ctx.account.address,
      tokens: [token.address],
    });
    const allowanceSlots = await discoverAllowanceSlots({
      client: ctx.publicClient,
      from: ctx.account.address,
      pairs: [{ token: token.address, spender: spender.address }],
    });

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 200n],
    });
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
      tokenSlotOverrides: [...balanceSlots, ...allowanceSlots],
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: token.address, delta: -200n });
  });

  it("returns unresolved transaction reverts instead of throwing", async () => {
    const target = await deploy("RevertingTarget.sol", "RevertingTarget");
    const result = await simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: target.address, data: "0x12345678" }],
    });

    expect(result.status).toBe("reverted");
    expect(result.revertData).toBeDefined();
    expect(result.failingCallIndex).toBe(0);
  });

  async function deploy(contractFile: string, contractName: string, args: readonly unknown[] = []) {
    const contract = artifact(contractFile, contractName);
    const hash = await ctx.walletClient.deployContract({
      abi: contract.abi,
      bytecode: contract.bytecode,
      args,
    });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    return {
      abi: contract.abi,
      address: getAddress(receipt.contractAddress!),
    };
  }

  async function write(
    contract: { abi: Abi; address: Address },
    functionName: string,
    args: readonly unknown[] = [],
  ) {
    const hash = await ctx.walletClient.writeContract({
      address: contract.address,
      abi: contract.abi,
      functionName,
      args,
    });
    await ctx.publicClient.waitForTransactionReceipt({ hash });
  }
});
