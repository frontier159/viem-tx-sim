import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseEther, zeroHash, type Abi, type Address } from "viem";

import { discoverRequirements, type SimulationDebugEvent } from "../src/index.js";
import { artifact } from "./helpers/artifacts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

describe("discoverRequirements", () => {
  let ctx: AnvilTestContext;

  beforeEach(async () => {
    ctx = await startAnvil();
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("measures vault balance and allowance requirements", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const vault = await deploy("TokenVault.sol", "TokenVault", [token.address]);
    const data = encodeFunctionData({
      abi: vault.abi,
      functionName: "deposit",
      args: [500n],
    });

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: vault.address, data }],
    });

    expect(requirements.status).toBe("success");
    expect(requirements.balances).toContainEqual({ token: token.address, amount: 500n });
    expect(requirements.allowances).toContainEqual({
      token: token.address,
      spender: vault.address,
      amount: 500n,
    });
    expect(requirements.unresolved).toEqual({
      balanceSlots: [],
      allowanceSlots: [],
      allowances: [],
    });
  });

  it("attributes one token pulled by two spenders exactly", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spenderA = await deploy("Spender.sol", "Spender");
    const spenderB = await deploy("Spender.sol", "Spender");
    const pullA = encodeFunctionData({
      abi: spenderA.abi,
      functionName: "pull",
      args: [token.address, 100n],
    });
    const pullB = encodeFunctionData({
      abi: spenderB.abi,
      functionName: "pull",
      args: [token.address, 250n],
    });

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: spenderA.address, data: pullA },
        { to: spenderB.address, data: pullB },
      ],
    });

    expect(requirements.balances).toContainEqual({ token: token.address, amount: 350n });
    expect(requirements.allowances).toEqual(
      expect.arrayContaining([
        { token: token.address, spender: spenderA.address, amount: 100n },
        { token: token.address, spender: spenderB.address, amount: 250n },
      ]),
    );
    expect(requirements.allowances).toHaveLength(2);
  });

  it("uses gross token outflow instead of net delta", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("RefundingSpender.sol", "RefundingSpender");
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 100n],
    });
    const refund = encodeFunctionData({
      abi: spender.abi,
      functionName: "refund",
      args: [token.address, 40n],
    });

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: spender.address, data: pull },
        { to: spender.address, data: refund },
      ],
    });

    expect(requirements.balances).toContainEqual({ token: token.address, amount: 100n });
  });

  it("does not require allowance when the batch approves before pulling", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
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

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: spender.address, data: pull },
      ],
    });

    expect(requirements.balances).toContainEqual({ token: token.address, amount: 400n });
    expect(
      requirements.allowances.some(
        (allowance) => allowance.token === token.address && allowance.spender === spender.address,
      ),
    ).toBe(false);
  });

  it("does not require allowance when the batch permits before pulling", async () => {
    const token = await deploy("PermitToken.sol", "PermitToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    await write(token, "mint", [ctx.account.address, 1_000n]);
    const permit = encodeFunctionData({
      abi: token.abi,
      functionName: "permit",
      args: [ctx.account.address, spender.address, 400n, 0n, 0, zeroHash, zeroHash],
    });
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 400n],
    });

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: token.address, data: permit },
        { to: spender.address, data: pull },
      ],
    });

    expect(requirements.status).toBe("success");
    expect(requirements.balances).toContainEqual({ token: token.address, amount: 400n });
    expect(
      requirements.allowances.some(
        (allowance) => allowance.token === token.address && allowance.spender === spender.address,
      ),
    ).toBe(false);
  });

  it("discards relayed allowance overwrites above gross outflow", async () => {
    const token = await deploy("PermitToken.sol", "PermitToken", ["Token", "TKN", 18]);
    const relayer = await deploy("PermitRelayer.sol", "PermitRelayer");
    const spender = await deploy("Spender.sol", "Spender");
    await write(token, "mint", [ctx.account.address, 1_000n]);
    const relay = encodeFunctionData({
      abi: relayer.abi,
      functionName: "relay",
      args: [token.address, ctx.account.address, spender.address, 400n],
    });
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 400n],
    });

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: relayer.address, data: relay },
        { to: spender.address, data: pull },
      ],
    });

    expect(requirements.status).toBe("success");
    expect(requirements.balances).toContainEqual({ token: token.address, amount: 400n });
    expect(
      requirements.allowances.filter((allowance) => allowance.token === token.address),
    ).toEqual([]);
    expect(requirements.unresolved.allowances).toContainEqual({
      token: token.address,
      spender: spender.address,
    });
  });

  it("measures the executed prefix when a batch reverts mid-way", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    const reverter = await deploy("RevertingTarget.sol", "RevertingTarget");
    await write(token, "mint", [ctx.account.address, 1_000n]);
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 100n],
    });

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: spender.address, data: pull },
        { to: reverter.address, data: "0x12345678" },
      ],
    });

    if (requirements.status !== "reverted") throw new Error("expected reverted requirements");
    expect(requirements.failingCallIndex).toBe(1);
    expect(requirements.balances).toContainEqual({ token: token.address, amount: 100n });
    expect(requirements.allowances).toContainEqual({
      token: token.address,
      spender: spender.address,
      amount: 100n,
    });
  });

  it("infers standard allowance slots after one probe", async () => {
    const events: SimulationDebugEvent[] = [];
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spenderA = await deploy("Spender.sol", "Spender");
    const spenderB = await deploy("Spender.sol", "Spender");
    const pullA = encodeFunctionData({
      abi: spenderA.abi,
      functionName: "pull",
      args: [token.address, 100n],
    });
    const pullB = encodeFunctionData({
      abi: spenderB.abi,
      functionName: "pull",
      args: [token.address, 250n],
    });

    await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: spenderA.address, data: pullA },
        { to: spenderB.address, data: pullB },
      ],
      debug: (event) => events.push(event),
    });

    expect(
      events.filter(
        (event) => event.step === "allowanceSlot.accessList" && event.phase === "start",
      ),
    ).toHaveLength(1);
    expect(events.some((event) => event.step === "allowanceSlot.computedVerify")).toBe(true);
  });

  it("falls back for non-standard allowance slots", async () => {
    const events: SimulationDebugEvent[] = [];
    const token = await deploy("NonStandardSlotToken.sol", "NonStandardSlotToken");
    const spenderA = await deploy("Spender.sol", "Spender");
    const spenderB = await deploy("Spender.sol", "Spender");
    const pullA = encodeFunctionData({
      abi: spenderA.abi,
      functionName: "pull",
      args: [token.address, 100n],
    });
    const pullB = encodeFunctionData({
      abi: spenderB.abi,
      functionName: "pull",
      args: [token.address, 250n],
    });

    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [
        { to: spenderA.address, data: pullA },
        { to: spenderB.address, data: pullB },
      ],
      debug: (event) => events.push(event),
    });

    expect(
      events.filter(
        (event) => event.step === "allowanceSlot.accessList" && event.phase === "start",
      ),
    ).toHaveLength(2);
    expect(requirements.allowances).toEqual(
      expect.arrayContaining([
        { token: token.address, spender: spenderA.address, amount: 100n },
        { token: token.address, spender: spenderB.address, amount: 250n },
      ]),
    );
    expect(requirements.unresolved).toEqual({
      balanceSlots: [],
      allowanceSlots: [],
      allowances: [],
    });
  });

  it("measures native value requirements", async () => {
    const value = parseEther("1");
    const requirements = await discoverRequirements({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value }],
    });

    expect(requirements.status).toBe("success");
    expect(requirements.native).toBe(value);
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
