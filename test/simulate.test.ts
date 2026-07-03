import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseEther,
  slice,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import {
  InvalidSimulationInputError,
  OVERRIDE_TOKEN_AMOUNT,
  TxSimulator,
  type BalanceQuery,
  type SimulationDebugEvent,
  type SimulationResult,
} from "../src/index.js";
import { artifact } from "./helpers/artifacts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

describe("viem-tx-sim", () => {
  let ctx: AnvilTestContext;
  let sim: TxSimulator;

  beforeEach(async () => {
    ctx = await startAnvil();
    sim = TxSimulator.create({ client: ctx.publicClient });
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("reports native value deltas", async () => {
    const value = parseEther("1");
    const before = await ctx.publicClient.getBalance({ address: ctx.account.address });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value }],
      balanceQueries: [{ asset: "native", account: ctx.account.address }],
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toEqual([
      {
        asset: "native",
        account: ctx.account.address,
        before,
        after: before - value,
        delta: -value,
        byCall: [-value],
      },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("attributes native balance changes per call", async () => {
    const first = parseEther("1");
    const second = parseEther("0.5");
    const before = await ctx.publicClient.getBalance({ address: ctx.account.address });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: ctx.secondAccount.address, data: "0x", value: first },
        { to: ctx.secondAccount.address, data: "0x", value: second },
      ],
      balanceQueries: [{ asset: "native", account: ctx.account.address }],
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toEqual([
      {
        asset: "native",
        account: ctx.account.address,
        before,
        after: before - first - second,
        delta: -(first + second),
        byCall: [-first, -second],
      },
    ]);
  });

  it("emits debug events for simulator RPC calls", async () => {
    const events: SimulationDebugEvent[] = [];
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x", value: parseEther("1") }],
      balanceQueries: [],
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(
      events.filter((event) => event.method === "eth_createAccessList" && event.phase === "start"),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.step === "txSimulator.simulate" && event.phase === "start"),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        phase: "success",
        method: "eth_call",
        step: "txSimulator.simulate",
      }),
    );
  });

  it("mirrors balance queries including zero deltas", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const data = encodeFunctionData({
      abi: token.abi,
      functionName: "transfer",
      args: [ctx.secondAccount.address, 250n],
    });
    const untouched = token.address;
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: token.address, data }],
      balanceQueries: [
        { asset: token.address, account: ctx.account.address },
        { asset: token.address, account: ctx.secondAccount.address },
        { asset: token.address, account: untouched },
      ],
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toEqual([
      {
        asset: token.address,
        account: ctx.account.address,
        before: 1_000n,
        after: 750n,
        delta: -250n,
        byCall: [-250n],
      },
      {
        asset: token.address,
        account: ctx.secondAccount.address,
        before: 0n,
        after: 250n,
        delta: 250n,
        byCall: [250n],
      },
      {
        asset: token.address,
        account: untouched,
        before: 0n,
        after: 0n,
        delta: 0n,
        byCall: [0n],
      },
    ]);
    expect(result.unresolved).toEqual([]);
  });

  it("reports zero per-call balance changes for unaffected calls", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const transfer = encodeFunctionData({
      abi: token.abi,
      functionName: "transfer",
      args: [ctx.secondAccount.address, 50n],
    });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: ctx.secondAccount.address, data: "0x" },
        { to: token.address, data: transfer },
      ],
      balanceQueries: tokenQueries(token.address),
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: 1_000n,
      after: 950n,
      delta: -50n,
      byCall: [0n, -50n],
    });
  });

  it("reports unresolved balance queries", async () => {
    const query = { asset: ctx.secondAccount.address, account: ctx.account.address };
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x" }],
      balanceQueries: [query],
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toEqual([]);
    expect(result.unresolved).toEqual([query]);
  });

  it("reports ERC-20 balance deltas", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const data = encodeFunctionData({
      abi: token.abi,
      functionName: "transfer",
      args: [ctx.secondAccount.address, 250n],
    });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: token.address, data }],
      balanceQueries: tokenQueries(token.address),
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: 1_000n,
      after: 750n,
      delta: -250n,
      byCall: [-250n],
    });
  });

  it("supports safe NFT receipt at the injected account", async () => {
    const nft = await deploy("MockERC721.sol", "MockERC721");
    const data = encodeFunctionData({
      abi: nft.abi,
      functionName: "safeMint",
      args: [ctx.account.address, 1n],
    });

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: nft.address, data }],
      balanceQueries: tokenQueries(nft.address),
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, nft.address)).toEqual({
      asset: nft.address,
      account: ctx.account.address,
      before: 0n,
      after: 1n,
      delta: 1n,
      byCall: [1n],
    });
  });

  it("observes arbitrary accounts", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    await write(token, "mint", [ctx.account.address, 1_000n]);
    await write(token, "approve", [spender.address, 300n]);

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 300n],
    });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
      balanceQueries: [
        { asset: token.address, account: ctx.account.address },
        { asset: token.address, account: spender.address },
      ],
    });

    expect(result.status).toBe("success");
    expect(result.balanceDeltas).toEqual([
      {
        asset: token.address,
        account: ctx.account.address,
        before: 1_000n,
        after: 700n,
        delta: -300n,
        byCall: [-300n],
      },
      {
        asset: token.address,
        account: spender.address,
        before: 0n,
        after: 300n,
        delta: 300n,
        byCall: [300n],
      },
    ]);
  });

  it("prepares allowance slots for token outflow", async () => {
    const events: SimulationDebugEvent[] = [];
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const allowanceOverrides = await sim.tokenOverrides.forAllowances({
      from: ctx.account.address,
      pairs: [{ token: token.address, spender: spender.address }],
    });

    expect(allowanceOverrides.slots).toContainEqual(
      expect.objectContaining({
        token: token.address,
        spender: spender.address,
        amount: OVERRIDE_TOKEN_AMOUNT,
      }),
    );
    expect(allowanceOverrides.unresolved).toEqual([]);

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 321n],
    });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
      balanceQueries: tokenQueries(token.address),
      tokenSlotOverrides: allowanceOverrides.slots,
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: 1_000n,
      after: 679n,
      delta: -321n,
      byCall: [-321n],
    });
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

    const allowanceOverrides = await sim.tokenOverrides.forAllowances({
      from: ctx.account.address,
      pairs: [
        { token: token.address, spender: spenderA.address },
        { token: token.address, spender: spenderB.address },
      ],
      debug: (event) => events.push(event),
    });

    expect(allowanceOverrides.slots).toEqual([
      expect.objectContaining({
        token: token.address,
        spender: spenderA.address,
        amount: OVERRIDE_TOKEN_AMOUNT,
      }),
      expect.objectContaining({
        token: token.address,
        spender: spenderB.address,
        amount: OVERRIDE_TOKEN_AMOUNT,
      }),
    ]);
    expect(allowanceOverrides.unresolved).toEqual([]);
    expect(
      events.filter(
        (event) => event.step === "allowanceSlot.accessList" && event.phase === "start",
      ),
    ).toHaveLength(1);
    expect(events.some((event) => event.step === "allowanceSlot.computedVerify")).toBe(true);
  });

  it("discovers wallet balance queries from the access list", async () => {
    const events: SimulationDebugEvent[] = [];
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("StoredTokenSpender.sol", "StoredTokenSpender", [token.address]);
    await write(token, "mint", [ctx.account.address, 1_000n]);
    await write(token, "approve", [spender.address, 123n]);

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [123n],
    });
    const balanceQueries = await sim.balanceQueries.forUser({
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
      debug: (event) => events.push(event),
    });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
      balanceQueries,
      debug: (event) => events.push(event),
    });

    expect(result.status).toBe("success");
    expect(balanceQueries).toEqual([
      { asset: "native", account: ctx.account.address },
      { asset: token.address, account: ctx.account.address },
    ]);
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: 1_000n,
      after: 877n,
      delta: -123n,
      byCall: [-123n],
    });
    expect(
      events.filter(
        (event) => event.step === "candidateDiscovery.accessList" && event.phase === "start",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.step === "balanceQueries.tokenFilter" && event.phase === "start",
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.step === "txSimulator.simulate" && event.phase === "start"),
    ).toHaveLength(1);
  });

  it("discovers ERC-20s for wallet balance queries", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("StoredTokenSpender.sol", "StoredTokenSpender", [token.address]);
    await write(token, "mint", [ctx.account.address, 1_000n]);
    await write(token, "approve", [spender.address, 123n]);

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [123n],
    });
    const args = {
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
    };
    const erc20s = await sim.balanceQueries.discoverErc20s(args);
    const balanceQueries = await sim.balanceQueries.forUser(args);

    expect(erc20s).toEqual([token.address]);
    expect(balanceQueries).toEqual([
      { asset: "native", account: ctx.account.address },
      ...erc20s.map((asset) => ({ asset, account: ctx.account.address })),
    ]);
  });

  it("uses caller-supplied balance storage overrides for view-only token balances", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    const balanceOverrides = await sim.tokenOverrides.forBalances({
      from: ctx.account.address,
      tokens: [token.address],
    });

    expect(balanceOverrides.slots).toContainEqual(
      expect.objectContaining({ token: token.address, amount: OVERRIDE_TOKEN_AMOUNT }),
    );
    expect(balanceOverrides.unresolved).toEqual([]);

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
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: spender.address, data: pull },
      ],
      balanceQueries: tokenQueries(token.address),
      tokenSlotOverrides: balanceOverrides.slots,
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: OVERRIDE_TOKEN_AMOUNT,
      after: OVERRIDE_TOKEN_AMOUNT - 500n,
      delta: -500n,
      byCall: [0n, -500n],
    });
  });

  it("reports unresolved balance slots", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const discovery = await sim.tokenOverrides.forBalances({
      from: ctx.account.address,
      tokens: [token.address, ctx.secondAccount.address],
    });

    expect(discovery.slots).toEqual([
      expect.objectContaining({ token: token.address, amount: OVERRIDE_TOKEN_AMOUNT }),
    ]);
    expect(discovery.unresolved).toEqual([ctx.secondAccount.address]);
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
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: spender.address, data: pull },
      ],
      balanceQueries: tokenQueries(token.address),
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: 1_000n,
      after: 600n,
      delta: -400n,
      byCall: [0n, -400n],
    });
  });

  it("attributes token balance changes per call", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("RefundingSpender.sol", "RefundingSpender");
    await write(token, "mint", [ctx.account.address, 1_000n]);

    const approve = encodeFunctionData({
      abi: token.abi,
      functionName: "approve",
      args: [spender.address, 400n],
    });
    const pull = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 300n],
    });
    const refund = encodeFunctionData({
      abi: spender.abi,
      functionName: "refund",
      args: [token.address, 100n],
    });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: spender.address, data: pull },
        { to: spender.address, data: refund },
      ],
      balanceQueries: tokenQueries(token.address),
    });

    expect(result.status).toBe("success");
    const delta = balanceDelta(result, token.address);
    if (delta === undefined) throw new Error("expected balance delta");
    expect(delta).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: 1_000n,
      after: 800n,
      delta: -200n,
      byCall: [0n, -300n, 100n],
    });
    expect(delta.byCall.reduce((sum, value) => sum + value, 0n)).toBe(delta.delta);
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
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: token.address, data: approve },
        { to: permit2.address, data: pull },
      ],
      balanceQueries: tokenQueries(token.address),
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: 1_000n,
      after: 877n,
      delta: -123n,
      byCall: [0n, -123n],
    });
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

    const balanceOverrides = await sim.tokenOverrides.forBalances({
      from: ctx.account.address,
      tokens: [proxyToken.address],
    });
    expect(balanceOverrides.slots).toContainEqual(
      expect.objectContaining({ token: proxyToken.address, amount: OVERRIDE_TOKEN_AMOUNT }),
    );
    expect(balanceOverrides.unresolved).toEqual([]);

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
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: proxyToken.address, data: approve },
        { to: spender.address, data: pull },
      ],
      balanceQueries: tokenQueries(proxyToken.address),
      tokenSlotOverrides: balanceOverrides.slots,
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, proxyToken.address)).toEqual({
      asset: proxyToken.address,
      account: ctx.account.address,
      before: OVERRIDE_TOKEN_AMOUNT,
      after: OVERRIDE_TOKEN_AMOUNT - 77n,
      delta: -77n,
      byCall: [0n, -77n],
    });
  });

  it("combines balance and allowance overrides", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const spender = await deploy("Spender.sol", "Spender");
    const balanceOverrides = await sim.tokenOverrides.forBalances({
      from: ctx.account.address,
      tokens: [token.address],
    });
    const allowanceOverrides = await sim.tokenOverrides.forAllowances({
      from: ctx.account.address,
      pairs: [{ token: token.address, spender: spender.address }],
    });

    const data = encodeFunctionData({
      abi: spender.abi,
      functionName: "pull",
      args: [token.address, 200n],
    });
    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: spender.address, data }],
      balanceQueries: tokenQueries(token.address),
      tokenSlotOverrides: [...balanceOverrides.slots, ...allowanceOverrides.slots],
    });

    expect(result.status).toBe("success");
    expect(balanceDelta(result, token.address)).toEqual({
      asset: token.address,
      account: ctx.account.address,
      before: OVERRIDE_TOKEN_AMOUNT,
      after: OVERRIDE_TOKEN_AMOUNT - 200n,
      delta: -200n,
      byCall: [-200n],
    });
  });

  it("rejects max uint256 token slot override amounts", async () => {
    const maxUint256 = (1n << 256n) - 1n;

    await expect(
      sim.simulate({
        from: ctx.account.address,
        calls: [{ to: ctx.secondAccount.address, data: "0x" }],
        balanceQueries: [],
        tokenSlotOverrides: [
          {
            token: ctx.secondAccount.address,
            slot: zeroHash,
            amount: maxUint256,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(InvalidSimulationInputError);
  });

  it("decodes custom error reverts with per-call ABI", async () => {
    const target = await deploy("CustomErrorTarget.sol", "CustomErrorTarget");
    const errorAbi = parseAbi(["error InsufficientBalance(uint256 have, uint256 want)"]);
    const data = encodeFunctionData({
      abi: target.abi,
      functionName: "failWithArgs",
      args: [1n, 2n],
    });

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: target.address, data }],
      balanceQueries: [],
      errorAbi,
    });

    if (result.status !== "reverted") throw new Error("expected reverted simulation");
    expect(result.revertError).toEqual({ name: "InsufficientBalance", args: [1n, 2n] });
    expect(result.revertReason).toBe("InsufficientBalance(1, 2)");
    expect(result.revertSelector).toBeDefined();
  });

  it("reports a revert selector when custom error ABI is not provided", async () => {
    const target = await deploy("CustomErrorTarget.sol", "CustomErrorTarget");
    const data = encodeFunctionData({
      abi: target.abi,
      functionName: "failWithArgs",
      args: [1n, 2n],
    });

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: target.address, data }],
      balanceQueries: [],
    });

    if (result.status !== "reverted") throw new Error("expected reverted simulation");
    expect(result.revertError).toBeUndefined();
    expect(result.revertReason).toBeUndefined();
    expect(result.revertSelector).toBe(slice(result.revertData, 0, 4));
  });

  it("merges bound and per-call error ABIs", async () => {
    const target = await deploy("CustomErrorTarget.sol", "CustomErrorTarget");
    const customSim = TxSimulator.create({
      client: ctx.publicClient,
      errorAbi: parseAbi(["error Unauthorized()"]),
    });
    const unauthorized = encodeFunctionData({
      abi: target.abi,
      functionName: "failPlain",
    });
    const insufficient = encodeFunctionData({
      abi: target.abi,
      functionName: "failWithArgs",
      args: [3n, 5n],
    });

    const boundResult = await customSim.simulate({
      from: ctx.account.address,
      calls: [{ to: target.address, data: unauthorized }],
      balanceQueries: [],
    });
    const mergedResult = await customSim.simulate({
      from: ctx.account.address,
      calls: [{ to: target.address, data: insufficient }],
      balanceQueries: [],
      errorAbi: parseAbi(["error InsufficientBalance(uint256 have, uint256 want)"]),
    });

    if (boundResult.status !== "reverted") throw new Error("expected reverted simulation");
    if (mergedResult.status !== "reverted") throw new Error("expected reverted simulation");
    expect(boundResult.revertError).toEqual({ name: "Unauthorized", args: [] });
    expect(mergedResult.revertError).toEqual({ name: "InsufficientBalance", args: [3n, 5n] });
  });

  it("decodes built-in Error(string) reverts", async () => {
    const target = await deploy("CustomErrorTarget.sol", "CustomErrorTarget");
    const data = encodeFunctionData({
      abi: target.abi,
      functionName: "failString",
    });

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [{ to: target.address, data }],
      balanceQueries: [],
    });

    if (result.status !== "reverted") throw new Error("expected reverted simulation");
    expect(result.revertReason).toBe("string revert");
    expect(result.revertError).toEqual({ name: "Error", args: ["string revert"] });
  });

  it("returns transaction reverts with executed-prefix balance deltas", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const target = await deploy("RevertingTarget.sol", "RevertingTarget");
    await write(token, "mint", [ctx.account.address, 1_000n]);
    const transfer100 = encodeFunctionData({
      abi: token.abi,
      functionName: "transfer",
      args: [ctx.secondAccount.address, 100n],
    });
    const transfer50 = encodeFunctionData({
      abi: token.abi,
      functionName: "transfer",
      args: [ctx.secondAccount.address, 50n],
    });

    const result = await sim.simulate({
      from: ctx.account.address,
      calls: [
        { to: token.address, data: transfer100 },
        { to: target.address, data: "0x12345678" },
        { to: token.address, data: transfer50 },
      ],
      balanceQueries: [
        { asset: token.address, account: ctx.account.address },
        { asset: token.address, account: ctx.secondAccount.address },
      ],
    });

    if (result.status !== "reverted") throw new Error("expected reverted simulation");
    expect(result.revertData).toBeDefined();
    expect(result.failingCallIndex).toBe(1);
    expect(result.balanceDeltas).toEqual([
      {
        asset: token.address,
        account: ctx.account.address,
        before: 1_000n,
        after: 900n,
        delta: -100n,
        byCall: [-100n, 0n, 0n],
      },
      {
        asset: token.address,
        account: ctx.secondAccount.address,
        before: 0n,
        after: 100n,
        delta: 100n,
        byCall: [100n, 0n, 0n],
      },
    ]);
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

  function tokenQueries(asset: Address, account = ctx.account.address): BalanceQuery[] {
    return [{ asset, account }];
  }

  function balanceDelta(
    result: SimulationResult,
    asset: "native" | Address,
    account = ctx.account.address,
  ) {
    return result.balanceDeltas.find((delta) => delta.asset === asset && delta.account === account);
  }
});

function _narrowingCheck(result: SimulationResult): Hex | "ok" {
  if (result.status === "reverted") return result.revertData;
  return "ok";
}

void _narrowingCheck;
