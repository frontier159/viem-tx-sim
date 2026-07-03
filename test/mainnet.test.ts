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
  OVERRIDE_TOKEN_AMOUNT,
  TxSimulator,
  type AllowanceSlot,
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
    amount: OVERRIDE_TOKEN_AMOUNT,
  },
] satisfies readonly TokenSlotOverride[];
const USDS_ALLOWANCE_SLOTS = [
  {
    token: USDS,
    spender: SUSDS,
    slot: "0x4d4b9559ecfa1d479ac515558c3d16f6ba97c029b1b54e12e4d53fb06d957a3b",
    amount: OVERRIDE_TOKEN_AMOUNT,
  },
] satisfies readonly AllowanceSlot[];
const USDS_SLOT_OVERRIDES = [
  ...USDS_BALANCE_SLOTS,
  ...USDS_ALLOWANCE_SLOTS,
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
    const sim = TxSimulator.create({ client });
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, 1n],
    });

    const blockNumber = mainnetBlockNumber();
    const balanceOverrides = await sim.tokenOverrides.forBalances({
      from: ANVIL_ACCOUNT,
      tokens: [USDC],
      blockNumber,
      debug: (event) => events.push(event),
    });
    expect(balanceOverrides.slots).toHaveLength(1);
    expect(balanceOverrides.unresolved).toEqual([]);

    const result = await sim.simulate({
      from: ANVIL_ACCOUNT,
      calls: [{ to: USDC, data }],
      blockNumber,
      balanceQueries: [{ asset: USDC, account: ANVIL_ACCOUNT }],
      tokenSlotOverrides: balanceOverrides.slots,
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toEqual([
      expect.objectContaining({ asset: USDC, account: ANVIL_ACCOUNT, delta: -1n }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: "success",
        method: "eth_createAccessList",
        step: "candidateDiscovery.accessList",
      }),
    );
    expect(events.some((event) => event.step === "candidateDiscovery.dataAddress.getCode")).toBe(
      false,
    );
  });

  it("discovers known USDS and sUSDS deposit slots", async () => {
    if (MAINNET_RPC_URL === undefined) throw new Error("MAINNET_RPC_URL is required.");

    const client = createPublicClient({
      chain: mainnet,
      transport: http(MAINNET_RPC_URL),
    });
    const sim = TxSimulator.create({ client });
    const blockNumber = mainnetBlockNumber();
    const [balanceOverrides, allowanceOverrides] = await Promise.all([
      sim.tokenOverrides.forBalances({
        from: ANVIL_ACCOUNT,
        tokens: [USDS],
        blockNumber,
      }),
      sim.tokenOverrides.forAllowances({
        from: ANVIL_ACCOUNT,
        pairs: [{ token: USDS, spender: SUSDS }],
        blockNumber,
      }),
    ]);

    expect(balanceOverrides).toEqual({ slots: USDS_BALANCE_SLOTS, unresolved: [] });
    expect(allowanceOverrides).toEqual({ slots: USDS_ALLOWANCE_SLOTS, unresolved: [] });
  });

  it("discovers USDS into sUSDS deposit requirements", async () => {
    if (MAINNET_RPC_URL === undefined) throw new Error("MAINNET_RPC_URL is required.");

    const client = createPublicClient({
      chain: mainnet,
      transport: http(MAINNET_RPC_URL),
    });
    const sim = TxSimulator.create({ client });
    const requirements = await sim.tokenOverrides.estimateRequirements({
      from: ANVIL_ACCOUNT,
      calls: [{ to: SUSDS, data: usdsDepositCalldata() }],
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
    const sim = TxSimulator.create({ client });
    const result = await sim.simulate({
      from: ANVIL_ACCOUNT,
      calls: [{ to: SUSDS, data: usdsDepositCalldata() }],
      blockNumber: mainnetBlockNumber(),
      balanceQueries: [
        { asset: USDS, account: ANVIL_ACCOUNT },
        { asset: SUSDS, account: ANVIL_ACCOUNT },
      ],
      tokenSlotOverrides: USDS_SLOT_OVERRIDES,
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toContainEqual({
      asset: USDS,
      account: ANVIL_ACCOUNT,
      delta: -USDS_DEPOSIT_ASSETS,
      before: OVERRIDE_TOKEN_AMOUNT,
      after: OVERRIDE_TOKEN_AMOUNT - USDS_DEPOSIT_ASSETS,
      byCall: [-USDS_DEPOSIT_ASSETS],
    });
    expect(result.balanceDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          asset: SUSDS,
          account: ANVIL_ACCOUNT,
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
