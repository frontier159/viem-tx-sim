import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, parseEther, zeroHash } from "viem";

import { TxSimulator, type SimulationDebugEvent } from "../src/index.js";
import { deploy, write } from "./helpers/contracts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

describe("tokenOverrides.estimateRequirements", () => {
  let ctx: AnvilTestContext;
  let sim: TxSimulator;

  beforeEach(async () => {
    ctx = await startAnvil();
    sim = TxSimulator.create({ client: ctx.publicClient });
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("measures vault balance and allowance requirements", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const vault = await deploy(ctx, "TokenVault.sol", "TokenVault", [token.address]);
    const data = encodeFunctionData({
      abi: vault.abi,
      functionName: "deposit",
      args: [500n],
    });

    const requirements = await sim.tokenOverrides.estimateRequirements({
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
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spenderA = await deploy(ctx, "Spender.sol", "Spender");
    const spenderB = await deploy(ctx, "Spender.sol", "Spender");
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

    const requirements = await sim.tokenOverrides.estimateRequirements({
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
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy(ctx, "RefundingSpender.sol", "RefundingSpender");
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

    const requirements = await sim.tokenOverrides.estimateRequirements({
      from: ctx.account.address,
      calls: [
        { to: spender.address, data: pull },
        { to: spender.address, data: refund },
      ],
    });

    expect(requirements.balances).toContainEqual({ token: token.address, amount: 100n });
  });

  it("does not require allowance when the batch approves before pulling", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy(ctx, "Spender.sol", "Spender");
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

    const requirements = await sim.tokenOverrides.estimateRequirements({
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
    const token = await deploy(ctx, "PermitToken.sol", "PermitToken", ["Token", "TKN", 18]);
    const spender = await deploy(ctx, "Spender.sol", "Spender");
    await write(ctx, token, "mint", [ctx.account.address, 1_000n]);
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

    const requirements = await sim.tokenOverrides.estimateRequirements({
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
    const token = await deploy(ctx, "PermitToken.sol", "PermitToken", ["Token", "TKN", 18]);
    const relayer = await deploy(ctx, "PermitRelayer.sol", "PermitRelayer");
    const spender = await deploy(ctx, "Spender.sol", "Spender");
    await write(ctx, token, "mint", [ctx.account.address, 1_000n]);
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

    const requirements = await sim.tokenOverrides.estimateRequirements({
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
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy(ctx, "Spender.sol", "Spender");
    const reverter = await deploy(ctx, "RevertingTarget.sol", "RevertingTarget");
    await write(ctx, token, "mint", [ctx.account.address, 1_000n]);
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 100n],
    });

    const requirements = await sim.tokenOverrides.estimateRequirements({
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

  it("decodes custom-error revert fields on a reverting estimate with errorAbi", async () => {
    const target = await deploy(ctx, "CustomErrorTarget.sol", "CustomErrorTarget");
    const data = encodeFunctionData({
      abi: target.abi,
      functionName: "failWithArgs",
      args: [1n, 2n],
    });

    const requirements = await sim.tokenOverrides.estimateRequirements({
      from: ctx.account.address,
      calls: [{ to: target.address, data }],
      errorAbi: parseAbi(["error InsufficientBalance(uint256 have, uint256 want)"]),
    });

    if (requirements.status !== "reverted") throw new Error("expected reverted requirements");
    expect(requirements.failingCallIndex).toBe(0);
    expect(requirements.revertError).toEqual({ name: "InsufficientBalance", args: [1n, 2n] });
    expect(requirements.revertReason).toBe("InsufficientBalance(1, 2)");
    expect(requirements.revertSelector).toBeDefined();
  });

  it("infers standard allowance slots after one probe", async () => {
    const events: SimulationDebugEvent[] = [];
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spenderA = await deploy(ctx, "Spender.sol", "Spender");
    const spenderB = await deploy(ctx, "Spender.sol", "Spender");
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

    await sim.tokenOverrides.estimateRequirements({
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
    const token = await deploy(ctx, "NonStandardSlotToken.sol", "NonStandardSlotToken");
    const spenderA = await deploy(ctx, "Spender.sol", "Spender");
    const spenderB = await deploy(ctx, "Spender.sol", "Spender");
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

    const requirements = await sim.tokenOverrides.estimateRequirements({
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
    const requirements = await sim.tokenOverrides.estimateRequirements({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value }],
    });

    expect(requirements.status).toBe("success");
    expect(requirements.native).toBe(value);
  });

  it("measures native value requirements for unfunded accounts", async () => {
    const from = getAddress("0x0000000000000000000000000000000000000BEE");
    const value = parseEther("1");

    // Fails pre-036: the measurement run had no native forge, so broke wallets collapsed.
    const requirements = await sim.tokenOverrides.estimateRequirements({
      from,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value }],
    });

    expect(requirements.status).toBe("success");
    expect(requirements.native).toBe(value);
  });
});
