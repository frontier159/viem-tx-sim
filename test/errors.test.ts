import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult, getAddress, parseAbi, type Hex } from "viem";

import {
  AccessListUnsupportedError,
  InvalidSimulationInputError,
  StateOverrideUnsupportedError,
  TxSimulator,
} from "../src/index.js";
import { encodeSimulationResult, fakeClient } from "./helpers/fakeClient.js";

const from = getAddress("0x0000000000000000000000000000000000000abc");
const to = getAddress("0x0000000000000000000000000000000000000def");
const token = getAddress("0x00000000000000000000000000000000000000f0");

function simulatorFor(responders: Record<string, (params: unknown) => unknown>): TxSimulator {
  return TxSimulator.create({ client: fakeClient(responders) });
}

describe("error handling", () => {
  it("rejects empty call batches with a typed input error", async () => {
    const sim = simulatorFor({});

    await expect(sim.simulate({ from, calls: [], balanceQueries: [] })).rejects.toBeInstanceOf(
      InvalidSimulationInputError,
    );
    await expect(
      sim.tokenOverrides.estimateRequirements({ from, calls: [] }),
    ).rejects.toBeInstanceOf(InvalidSimulationInputError);
  });

  it("rejects unsupported access-list RPCs with a typed error", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw new Error("the method eth_createAccessList does not exist/is not available");
      },
    });

    await expect(
      sim.balanceQueries.forUser({ from, calls: [{ to, data: "0x" }] }),
    ).rejects.toBeInstanceOf(AccessListUnsupportedError);
  });

  it("treats access-list execution reverts as empty candidate discovery", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw new Error("execution reverted");
      },
      eth_call: () => encodeSimulationResult(),
    });

    await expect(
      sim.balanceQueries.forUser({ from, calls: [{ to, data: "0x" }] }),
    ).resolves.toEqual([{ asset: "native", account: from }]);
  });

  it("rejects unsupported state overrides with a typed error", async () => {
    const sim = simulatorFor({
      eth_call: () => {
        throw new Error("state override not supported");
      },
    });

    await expect(
      sim.simulate({ from, calls: [{ to, data: "0x" }], balanceQueries: [] }),
    ).rejects.toBeInstanceOf(StateOverrideUnsupportedError);
  });

  it("rejects undecodable simulator output with a typed error", async () => {
    const sim = simulatorFor({ eth_call: () => "0x" });

    const promise = sim.simulate({ from, calls: [{ to, data: "0x" }], balanceQueries: [] });
    await expect(promise).rejects.toBeInstanceOf(StateOverrideUnsupportedError);
    await expect(promise).rejects.toThrow(/undecodable/);
  });

  it("omits balance slots when probing fails", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw new Error("eth_createAccessList unavailable");
      },
    });

    await expect(sim.tokenOverrides.forBalances({ from, tokens: [token] })).resolves.toEqual({
      slots: [],
      unresolved: [token],
    });
  });

  // Branches Anvil cannot produce, driven through the public interface.

  it("treats a result-shaped execution revert as empty candidate discovery", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => ({ error: { message: "execution reverted" } }),
      eth_call: () => encodeSimulationResult(),
    });

    await expect(
      sim.balanceQueries.forUser({ from, calls: [{ to, data: "0x" }] }),
    ).resolves.toEqual([{ asset: "native", account: from }]);
  });

  it("drops a non-Error object cause when formatting an access-list failure", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => ({ error: { message: "boom" } }),
    });

    const error = await sim.balanceQueries
      .forUser({ from, calls: [{ to, data: "0x" }] })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AccessListUnsupportedError);
    expect((error as Error).message).toContain("returned no access list");
    expect((error as Error).message).not.toContain("boom");
  });

  it("treats short probe returndata as an unresolved balance slot", async () => {
    const slot = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
    const sim = simulatorFor({
      eth_createAccessList: () => ({
        accessList: [{ address: token, storageKeys: [slot] }],
        gasUsed: "0x0",
      }),
      eth_call: () => "0x1234", // shorter than 66 chars -> readUint256Call yields undefined
    });

    await expect(sim.tokenOverrides.forBalances({ from, tokens: [token] })).resolves.toEqual({
      slots: [],
      unresolved: [token],
    });
  });

  it("treats an alternately-worded access-list revert as empty candidate discovery", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw new Error("transaction reverted");
      },
      eth_call: () => encodeSimulationResult(),
    });

    await expect(
      sim.balanceQueries.forUser({ from, calls: [{ to, data: "0x" }] }),
    ).resolves.toEqual([{ asset: "native", account: from }]);
  });

  it("treats a code-3 access-list error as empty candidate discovery despite non-revert prose", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw Object.assign(new Error("VM execution error"), { code: 3 });
      },
      eth_call: () => encodeSimulationResult(),
    });

    await expect(
      sim.balanceQueries.forUser({ from, calls: [{ to, data: "0x" }] }),
    ).resolves.toEqual([{ asset: "native", account: from }]);
  });

  it("rejects an infrastructure access-list error with a typed error (negative control)", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw new Error("connection refused");
      },
    });

    await expect(
      sim.balanceQueries.forUser({ from, calls: [{ to, data: "0x" }] }),
    ).rejects.toBeInstanceOf(AccessListUnsupportedError);
  });

  it("falls back to call targets on lowercase insufficient-funds during estimation", async () => {
    const events: { step: string; phase: string; details?: Record<string, unknown> }[] = [];
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw new Error("insufficient funds for gas * price + value");
      },
      eth_call: () => encodeSimulationResult(),
    });

    const result = await sim.tokenOverrides.estimateRequirements({
      from,
      calls: [{ to, data: "0x" }],
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(
      events.some(
        (event) =>
          event.step === "txSimulator.simulate" &&
          event.phase === "start" &&
          event.details?.candidates === 1,
      ),
    ).toBe(true);
  });

  it("rethrows an infrastructure error from the estimator", async () => {
    const sim = simulatorFor({
      eth_createAccessList: () => {
        throw new Error("connection refused");
      },
    });

    await expect(
      sim.tokenOverrides.estimateRequirements({ from, calls: [{ to, data: "0x" }] }),
    ).rejects.toBeInstanceOf(AccessListUnsupportedError);
  });

  it("formats a Panic(uint256) revert from the simulator", async () => {
    const panic = encodeErrorResult({
      abi: parseAbi(["error Panic(uint256)"]),
      errorName: "Panic",
      args: [0x11n], // arithmetic overflow
    });
    const sim = simulatorFor({
      eth_call: () =>
        encodeSimulationResult({ success: false, failingCallIndex: 0n, revertData: panic }),
    });

    const result = await sim.simulate({ from, calls: [{ to, data: "0x" }], balanceQueries: [] });
    if (result.status !== "reverted") throw new Error("expected reverted simulation");
    expect(result.revertReason).toBe("Panic(17)");
    expect(result.revertError).toEqual({ name: "Panic", args: [17n] });
  });

  it("logs to console.debug when debug is true", async () => {
    const sim = simulatorFor({ eth_call: () => encodeSimulationResult() });
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});

    let logged: string;
    try {
      await sim.simulate({ from, calls: [{ to, data: "0x" }], balanceQueries: [], debug: true });
      logged = spy.mock.calls.map((args) => args.join(" ")).join("\n");
    } finally {
      spy.mockRestore();
    }

    expect(logged).toContain("[viem-tx-sim]");
    expect(logged).toContain("txSimulator.simulate");
  });

  it("logs to console.debug when VIEM_TX_SIM_DEBUG_RPC is set", async () => {
    const sim = simulatorFor({ eth_call: () => encodeSimulationResult() });
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});

    let logged: string;
    try {
      process.env.VIEM_TX_SIM_DEBUG_RPC = "1";
      await sim.simulate({ from, calls: [{ to, data: "0x" }], balanceQueries: [] });
      logged = spy.mock.calls.map((args) => args.join(" ")).join("\n");
    } finally {
      delete process.env.VIEM_TX_SIM_DEBUG_RPC;
      spy.mockRestore();
    }

    expect(logged).toContain("txSimulator.simulate");
  });

  it("checksum-normalizes from/to and override keys in the outgoing eth_call", async () => {
    const lowerFrom = from.toLowerCase() as typeof from;
    let params: unknown;
    const sim = simulatorFor({
      eth_call: (captured) => {
        params = captured;
        return encodeSimulationResult();
      },
    });

    await sim.simulate({
      from: lowerFrom,
      calls: [{ to: lowerFrom, data: "0x" }],
      balanceQueries: [{ asset: "native", account: lowerFrom }],
    });

    const [tx, , stateOverride] = params as [
      { from: string; to: string },
      unknown,
      Record<string, unknown>,
    ];
    expect(tx.from).toBe(from);
    expect(tx.to).toBe(from);
    for (const key of Object.keys(stateOverride)) {
      expect(key).toBe(getAddress(key));
    }
  });

  it("checksum-normalizes from/to in the outgoing eth_createAccessList", async () => {
    const lowerFrom = from.toLowerCase() as typeof from;
    const lowerTo = to.toLowerCase() as typeof to;
    let params: unknown;
    const sim = simulatorFor({
      eth_createAccessList: (captured) => {
        params = captured;
        return { accessList: [] };
      },
      eth_call: () => encodeSimulationResult(),
    });

    await sim.balanceQueries.discoverErc20s({
      from: lowerFrom,
      calls: [{ to: lowerTo, data: "0x" }],
    });

    const [request] = params as [{ from: string; to: string }];
    expect(request.from).toBe(from);
    expect(request.to).toBe(to);
  });

  it("clamps the default simulation gas to the access-list ceiling on the wire", async () => {
    let params: unknown;
    const sim = simulatorFor({
      eth_createAccessList: (captured) => {
        params = captured;
        return { accessList: [] };
      },
      eth_call: () => encodeSimulationResult(),
    });

    await sim.balanceQueries.discoverErc20s({ from, calls: [{ to, data: "0x" }] });

    const [request] = params as [{ gas: string }];
    expect(request.gas).toBe("0x989680"); // 10,000,000
  });

  it("passes an explicit sub-ceiling gas through to eth_createAccessList unchanged", async () => {
    let params: unknown;
    const sim = TxSimulator.create({
      client: fakeClient({
        eth_createAccessList: (captured) => {
          params = captured;
          return { accessList: [] };
        },
        eth_call: () => encodeSimulationResult(),
      }),
      gas: 5_000_000n,
    });

    await sim.balanceQueries.discoverErc20s({ from, calls: [{ to, data: "0x" }] });

    const [request] = params as [{ gas: string }];
    expect(request.gas).toBe("0x4c4b40"); // 5,000,000
  });

  it("reports a selector-less revert with undefined decode fields", async () => {
    const sim = simulatorFor({
      eth_call: () =>
        encodeSimulationResult({ success: false, failingCallIndex: 0n, revertData: "0x" }),
    });

    const result = await sim.simulate({ from, calls: [{ to, data: "0x" }], balanceQueries: [] });
    if (result.status !== "reverted") throw new Error("expected reverted simulation");
    expect(result.revertData).toBe("0x");
    expect(result.revertSelector).toBeUndefined();
    expect(result.revertReason).toBeUndefined();
    expect(result.revertError).toBeUndefined();
    expect(result.failingCallIndex).toBe(0);
  });
});
