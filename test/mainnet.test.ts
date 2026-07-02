import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  erc4626Abi,
  getAddress,
  http,
  parseEther,
} from "viem";
import { mainnet } from "viem/chains";

import {
  discoverAllowanceSlots,
  discoverBalanceSlots,
  discoverRequirements,
  simulate,
  type AllowanceSlot,
  type BalanceSlot,
  type SimulationDebugEvent,
  type TokenSlotOverride,
} from "../src/index.js";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const DEFAULT_MAINNET_BLOCK_NUMBER = 25_441_331n;
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const USDS = getAddress("0xdC035D45d973E3EC169d2276DDab16f1e407384F");
const SUSDS = getAddress("0xa3931d71877c0e7a3148cb7eb4463524fec27fbd");
const ANVIL_ACCOUNT = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const RECIPIENT = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const USDS_DEPOSIT_ASSETS = parseEther("1000");
const USDS_BALANCE_SLOTS = [
  {
    token: USDS,
    slot: "0xbc40fbf4394cd00f78fae9763b0c2c71b21ea442c42fdadc5b720537240ebac1",
  },
] satisfies readonly BalanceSlot[];
const USDS_ALLOWANCE_SLOTS = [
  {
    token: USDS,
    spender: SUSDS,
    slot: "0x4d4b9559ecfa1d479ac515558c3d16f6ba97c029b1b54e12e4d53fb06d957a3b",
  },
] satisfies readonly AllowanceSlot[];
const USDS_SLOT_OVERRIDES = [
  ...USDS_BALANCE_SLOTS,
  ...USDS_ALLOWANCE_SLOTS.map((slot) => ({ token: slot.token, slot: slot.slot })),
] satisfies readonly TokenSlotOverride[];

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

  it("discovers known USDS and sUSDS deposit slots", async () => {
    if (MAINNET_RPC_URL === undefined) throw new Error("MAINNET_RPC_URL is required.");

    const client = createPublicClient({
      chain: mainnet,
      transport: http(MAINNET_RPC_URL),
    });
    const blockNumber = mainnetBlockNumber();
    const [balanceSlots, allowanceSlots] = await Promise.all([
      discoverBalanceSlots({
        client,
        owner: ANVIL_ACCOUNT,
        tokens: [USDS],
        blockNumber,
      }),
      discoverAllowanceSlots({
        client,
        owner: ANVIL_ACCOUNT,
        pairs: [{ token: USDS, spender: SUSDS }],
        blockNumber,
      }),
    ]);

    expect(balanceSlots).toEqual(USDS_BALANCE_SLOTS);
    expect(allowanceSlots).toEqual(USDS_ALLOWANCE_SLOTS);
  });

  it("discovers USDS into sUSDS deposit requirements", async () => {
    if (MAINNET_RPC_URL === undefined) throw new Error("MAINNET_RPC_URL is required.");

    const client = createPublicClient({
      chain: mainnet,
      transport: http(MAINNET_RPC_URL),
    });
    const requirements = await discoverRequirements({
      client,
      from: ANVIL_ACCOUNT,
      calls: [{ to: SUSDS, calldata: usdsDepositCalldata() }],
      blockNumber: mainnetBlockNumber(),
    });

    expect(requirements.status).toBe("success");
    expect(requirements.balances).toContainEqual({ token: USDS, amount: USDS_DEPOSIT_ASSETS });
    expect(requirements.allowances).toContainEqual({
      token: USDS,
      spender: SUSDS,
      amount: USDS_DEPOSIT_ASSETS,
    });
    expect(requirements.slots).toEqual(expect.arrayContaining(USDS_SLOT_OVERRIDES));
  });

  it("simulates depositing USDS into sUSDS with predefined slots", async () => {
    if (MAINNET_RPC_URL === undefined) throw new Error("MAINNET_RPC_URL is required.");

    const client = createPublicClient({
      chain: mainnet,
      transport: http(MAINNET_RPC_URL),
    });
    const result = await simulate({
      client,
      from: ANVIL_ACCOUNT,
      calls: [{ to: SUSDS, calldata: usdsDepositCalldata() }],
      blockNumber: mainnetBlockNumber(),
      tokenSlotOverrides: USDS_SLOT_OVERRIDES,
    });

    expect(result.status).toBe("success");
    expect(result.assetBalanceDeltas).toContainEqual({
      asset: USDS,
      delta: -USDS_DEPOSIT_ASSETS,
    });
    expect(result.assetBalanceDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          asset: SUSDS,
        }),
      ]),
    );
  });
});

function usdsDepositCalldata() {
  return encodeFunctionData({
    abi: erc4626Abi,
    functionName: "deposit",
    args: [USDS_DEPOSIT_ASSETS, ANVIL_ACCOUNT],
  });
}

function mainnetBlockNumber(): bigint {
  const blockNumber = process.env.MAINNET_BLOCK_NUMBER;
  return blockNumber === undefined || blockNumber === ""
    ? DEFAULT_MAINNET_BLOCK_NUMBER
    : BigInt(blockNumber);
}
