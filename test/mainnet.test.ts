import { describe, expect, it } from "vitest";
import { createPublicClient, encodeFunctionData, erc20Abi, http } from "viem";
import { mainnet } from "viem/chains";

import { discoverBalanceSlots, simulate, type SimulationDebugEvent } from "../src/index.js";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const DEFAULT_MAINNET_BLOCK_NUMBER = 25_441_331n;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ANVIL_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const mainnetDescribe = MAINNET_RPC_URL === undefined ? describe.skip : describe;

mainnetDescribe("mainnet RPC integration", () => {
  it("discovers USDC from production eth_createAccessList on a reverted transfer", async () => {
    if (MAINNET_RPC_URL === undefined) throw new Error("MAINNET_RPC_URL is required.");

    const events: SimulationDebugEvent[] = [];
    const client = createPublicClient({
      chain: mainnet,
      transport: http(MAINNET_RPC_URL),
    });
    const calldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, 1n],
    });

    const blockNumber = mainnetBlockNumber();
    const balanceSlots = await discoverBalanceSlots({
      client,
      owner: ANVIL_ACCOUNT,
      tokens: [USDC],
      blockNumber,
      debug: (event) => events.push(event),
    });
    expect(balanceSlots).toHaveLength(1);

    const result = await simulate({
      client,
      from: ANVIL_ACCOUNT,
      calls: [{ to: USDC, calldata }],
      blockNumber,
      tokenSlotOverrides: balanceSlots,
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({ asset: USDC, delta: -1n });
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: "success",
        method: "eth_createAccessList",
        step: "candidateDiscovery.accessList",
      }),
    );
    expect(
      events.some((event) => event.step === "candidateDiscovery.calldataAddress.getCode"),
    ).toBe(false);
  });
});

function mainnetBlockNumber(): bigint {
  const blockNumber = process.env.MAINNET_BLOCK_NUMBER;
  return blockNumber === undefined || blockNumber === ""
    ? DEFAULT_MAINNET_BLOCK_NUMBER
    : BigInt(blockNumber);
}
