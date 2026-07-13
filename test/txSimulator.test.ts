import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEther } from "viem";

import { TxSimulator, type SimulationDebugEvent } from "../src/index.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

describe("TxSimulator", () => {
  let ctx: AnvilTestContext;

  beforeEach(async () => {
    ctx = await startAnvil();
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("binds the client for end-to-end simulation", async () => {
    const sim = TxSimulator.create({ client: ctx.publicClient });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: parseEther("1") }],
      balanceQueries: [{ asset: "native", account: ctx.account.address }],
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toContainEqual(
      expect.objectContaining({ asset: "native", delta: -parseEther("1") }),
    );
  });

  it("uses the bound debug default", async () => {
    const events: SimulationDebugEvent[] = [];
    const sim = TxSimulator.create({
      client: ctx.publicClient,
      debug: (event) => events.push(event),
    });

    await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: parseEther("1") }],
      balanceQueries: [],
    });

    expect(events.some((event) => event.step === "txSimulator.simulate")).toBe(true);
  });

  it("lets per-call debug override the bound default", async () => {
    const boundEvents: SimulationDebugEvent[] = [];
    const callEvents: SimulationDebugEvent[] = [];
    const sim = TxSimulator.create({
      client: ctx.publicClient,
      debug: (event) => boundEvents.push(event),
    });

    await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: parseEther("1") }],
      balanceQueries: [],
      debug: (event) => callEvents.push(event),
    });

    expect(boundEvents).toHaveLength(0);
    expect(callEvents.some((event) => event.step === "txSimulator.simulate")).toBe(true);
  });

  it("uses the bound gas default", async () => {
    const events: SimulationDebugEvent[] = [];
    const sim = TxSimulator.create({
      client: ctx.publicClient,
      gas: 16_000_000n,
      debug: (event) => events.push(event),
    });

    // Gas is not exposed in debug event details; success under this bound budget pins propagation.
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: parseEther("1") }],
      balanceQueries: [],
    });

    expect(result.status).toBe("success");
    expect(events.some((event) => event.step === "txSimulator.simulate")).toBe(true);
  });

  it("is structurally mockable", async () => {
    await expect(
      fake.simulate({
        from: "0x0000000000000000000000000000000000000abc",
        calls: [{ to: "0x0000000000000000000000000000000000000def", data: "0x" }],
        balanceQueries: [],
      }),
    ).resolves.toEqual({ status: "success", balanceDeltas: [], unresolved: [], nftReceipts: [] });
  });
});

const fake: TxSimulator = {
  simulate: async () => ({ status: "success", balanceDeltas: [], unresolved: [], nftReceipts: [] }),
  balanceQueries: { forUser: async () => [], discoverErc20s: async () => [] },
  tokenOverrides: {
    forBalances: async () => ({ slots: [], unresolved: [] }),
    forAllowances: async () => ({ slots: [], unresolved: [] }),
    forPermit2Allowances: async () => ({ slots: [], pairs: [], unresolved: [] }),
    estimateRequirements: async () => ({
      status: "success",
      native: 0n,
      balances: [],
      allowances: [],
      permit2Allowances: [],
      slots: [],
      unresolved: {
        balanceSlots: [],
        allowanceSlots: [],
        allowances: [],
        permit2Slots: [],
        permit2Allowances: [],
      },
    }),
  },
};

void fake;
