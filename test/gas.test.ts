import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";

import { TxSimulator, type SimulationDebugEvent } from "../src/index.js";
import { intrinsicAndCalldataGas } from "../src/internal/gas.js";
import { deploy, write } from "./helpers/contracts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";
import { encodeBatchGasResult, fakeClient } from "./helpers/fakeClient.js";

describe("gas.estimateBatch decode + math (no node)", () => {
  it("pins the decode of simulateBatchGas returndata against the TS intrinsic math", async () => {
    const from = "0x1111111111111111111111111111111111111111" as const;
    const calls = [
      { to: "0x2222222222222222222222222222222222222222" as const, data: "0x01020304" as const },
      { to: "0x3333333333333333333333333333333333333333" as const, data: "0x" as const },
    ];
    // Scripted per-call execution gas the "node" reports back from the ghost's probe-free entry point.
    const execGasPerCall = [5_000n, 8_000n];

    const sim = TxSimulator.create({
      client: fakeClient({
        eth_call: () => encodeBatchGasResult({ allSuccess: true, execGasPerCall }),
      }),
    });

    const estimate = await sim.gas.estimateBatch({ from, calls });

    expect(estimate.failingCallIndex).toBeNull();
    expect(estimate.byCall).toHaveLength(2);
    for (const [index, call] of calls.entries()) {
      const intrinsic = intrinsicAndCalldataGas(call.data);
      expect(estimate.byCall[index]).toEqual({
        executionGas: execGasPerCall[index],
        intrinsicAndCalldataGas: intrinsic,
        suggestedLimit: execGasPerCall[index]! + intrinsic,
      });
    }
    expect(estimate.totalSuggestedLimit).toBe(
      estimate.byCall.reduce((sum, call) => sum + call.suggestedLimit, 0n),
    );
  });
});

describe("intrinsicAndCalldataGas (EIP-7623 floor, no node)", () => {
  it("returns the bare intrinsic for empty calldata", () => {
    expect(intrinsicAndCalldataGas("0x")).toBe(21_000n);
  });

  it("computes 4 non-zero bytes exactly", () => {
    // z=0, nz=4 → standard = 16*4 = 64, floor = 10*(0 + 4*4) = 160 → max = 160.
    expect(intrinsicAndCalldataGas("0x01020304")).toBe(21_000n + 160n);
  });

  it("computes a zero-heavy payload exactly (floor path)", () => {
    // 100 zero bytes: z=100, nz=0 → standard = 4*100 = 400, floor = 10*100 = 1000 → max = 1000.
    const data = `0x${"00".repeat(100)}` as const;
    expect(intrinsicAndCalldataGas(data)).toBe(21_000n + 1000n);
  });

  it("computes a mixed selector+word payload exactly", () => {
    // 4 non-zero selector bytes + 31 zero + 1 non-zero arg byte → nz=5, z=31.
    // standard = 4*31 + 16*5 = 124 + 80 = 204, floor = 10*(31 + 4*5) = 10*51 = 510 → max = 510.
    const data = `0xabcdef01${"00".repeat(31)}07` as const;
    expect(intrinsicAndCalldataGas(data)).toBe(21_000n + 510n);
  });
});

describe("gas.estimateBatch", () => {
  let ctx: AnvilTestContext;
  let sim: TxSimulator;

  beforeEach(async () => {
    ctx = await startAnvil();
    sim = TxSimulator.create({ client: ctx.publicClient });
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("measures dependent approve-then-pull legs a standalone estimate cannot", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy(ctx, "Spender.sol", "Spender");
    await write(ctx, token, "mint", [ctx.account.address, 1_000n]);

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

    // (a) The dependent leg cannot be estimated standalone: without the in-batch approve, the pull's
    // transferFrom reverts on a zero allowance, so eth_estimateGas throws. This is the problem the
    // batch entry point exists to solve.
    await expect(
      ctx.publicClient.estimateGas({
        account: ctx.account.address,
        to: spender.address,
        data: pull,
      }),
    ).rejects.toThrow();

    // (b) The sequential batch measures both legs.
    const estimate = await sim.gas.estimateBatch({
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: spender.address, data: pull },
      ],
    });

    expect(estimate.failingCallIndex).toBeNull();
    expect(estimate.byCall).toHaveLength(2);
    expect(estimate.byCall[0]!.executionGas).toBeGreaterThan(0n);
    expect(estimate.byCall[1]!.executionGas).toBeGreaterThan(0n);
    for (const call of estimate.byCall) {
      expect(call.suggestedLimit).toBe(call.executionGas + call.intrinsicAndCalldataGas);
    }
    expect(estimate.totalSuggestedLimit).toBe(
      estimate.byCall.reduce((sum, call) => sum + call.suggestedLimit, 0n),
    );
    // Sanity: an ERC-20 approve/transferFrom is thousands of gas, well under the eth_call budget.
    expect(estimate.byCall[0]!.executionGas).toBeGreaterThan(1_000n);
    expect(estimate.byCall[1]!.executionGas).toBeLessThan(16_000_000n);
  });

  it("halts and zero-fills from the first reverting call", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const reverter = await deploy(ctx, "RevertingTarget.sol", "RevertingTarget");
    await write(ctx, token, "mint", [ctx.account.address, 1_000n]);

    const transfer = encodeFunctionData({
      abi: token.abi,
      functionName: "transfer",
      args: [ctx.secondAccount.address, 10n],
    });

    const estimate = await sim.gas.estimateBatch({
      from: ctx.account.address,
      calls: [
        { to: token.address, data: transfer },
        { to: reverter.address, data: "0x12345678" },
      ],
    });

    expect(estimate.failingCallIndex).toBe(1);
    expect(estimate.byCall[0]!.executionGas).toBeGreaterThan(0n);
    expect(estimate.byCall[1]).toEqual({
      executionGas: 0n,
      intrinsicAndCalldataGas: 0n,
      suggestedLimit: 0n,
    });
    expect(estimate.totalSuggestedLimit).toBe(estimate.byCall[0]!.suggestedLimit);
  });

  it("issues exactly one eth_call and zero access lists", async () => {
    const events: SimulationDebugEvent[] = [];
    await sim.gas.estimateBatch({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: 1n }],
      debug: (event) => events.push(event),
    });

    expect(
      events.filter((event) => event.method === "eth_createAccessList" && event.phase === "start"),
    ).toHaveLength(0);
    const calls = events.filter((event) => event.method === "eth_call" && event.phase === "start");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.step).toBe("gas.estimateBatch");
  });

  it("requires prepared overrides to measure an unfunded pull", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy(ctx, "Spender.sol", "Spender");
    // No mint: from holds zero of `token`.

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
    const calls = [
      { to: token.address, data: approve },
      { to: spender.address, data: pull },
    ];

    const withoutOverrides = await sim.gas.estimateBatch({
      from: ctx.account.address,
      calls,
    });
    expect(withoutOverrides.failingCallIndex).toBe(1);

    const balanceOverrides = await sim.tokenOverrides.forBalances({
      from: ctx.account.address,
      tokens: [token.address],
    });
    const allowanceOverrides = await sim.tokenOverrides.forAllowances({
      from: ctx.account.address,
      pairs: [{ token: token.address, spender: spender.address }],
    });

    const withOverrides = await sim.gas.estimateBatch({
      from: ctx.account.address,
      calls,
      tokenSlotOverrides: [...balanceOverrides.slots, ...allowanceOverrides.slots],
    });

    expect(withOverrides.failingCallIndex).toBeNull();
    expect(withOverrides.byCall[0]!.executionGas).toBeGreaterThan(0n);
    expect(withOverrides.byCall[1]!.executionGas).toBeGreaterThan(0n);
  });
});
