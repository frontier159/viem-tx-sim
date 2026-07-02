import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAddress, type Abi, type Address, type CallParameters } from "viem";

import {
  AccessListUnsupportedError,
  discoverBalanceSlots,
  discoverRequirements,
  InvalidSimulationInputError,
  simulate,
  StateOverrideUnsupportedError,
} from "../src/index.js";
import { artifact } from "./helpers/artifacts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

type RpcRequest = {
  method: string;
  params?: unknown;
};
type RpcDelegate = (request: RpcRequest, options?: unknown) => Promise<unknown>;
type CallDelegate = (parameters: CallParameters) => Promise<unknown>;

describe("error handling", () => {
  let ctx: AnvilTestContext;

  beforeEach(async () => {
    ctx = await startAnvil();
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("rejects empty call batches with a typed input error", async () => {
    await expect(
      simulate({ client: ctx.publicClient, from: ctx.account.address, calls: [] }),
    ).rejects.toBeInstanceOf(InvalidSimulationInputError);

    await expect(
      discoverRequirements({ client: ctx.publicClient, from: ctx.account.address, calls: [] }),
    ).rejects.toBeInstanceOf(InvalidSimulationInputError);
  });

  it("rejects unsupported access-list RPCs with a typed error", async () => {
    patchRpc(ctx, "eth_createAccessList", async () => {
      throw new Error("the method eth_createAccessList does not exist/is not available");
    });

    await expect(simulateTrivialCall()).rejects.toBeInstanceOf(AccessListUnsupportedError);
  });

  it("treats access-list execution reverts as empty candidate discovery", async () => {
    patchRpc(ctx, "eth_createAccessList", async () => {
      throw new Error("execution reverted");
    });

    await expect(simulateTrivialCall()).resolves.toMatchObject({ status: "success" });
  });

  it("rejects unsupported state overrides with a typed error", async () => {
    patchCall(ctx, async (parameters, next) => {
      if (parameters.stateOverride !== undefined) throw new Error("state override not supported");
      return next();
    });

    await expect(simulateTrivialCall()).rejects.toBeInstanceOf(StateOverrideUnsupportedError);
  });

  it("rejects undecodable simulator output with a typed error", async () => {
    patchCall(ctx, async (parameters, next) => {
      if (parameters.stateOverride !== undefined) return "0x";
      return next();
    });

    const promise = simulateTrivialCall();
    await expect(promise).rejects.toBeInstanceOf(StateOverrideUnsupportedError);
    await expect(promise).rejects.toThrow(/undecodable/);
  });

  it("omits balance slots when probing fails", async () => {
    const token = await deploy("TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    patchRpc(ctx, "eth_createAccessList", async () => {
      throw new Error("eth_createAccessList unavailable");
    });

    await expect(
      discoverBalanceSlots({
        client: ctx.publicClient,
        from: ctx.account.address,
        tokens: [token.address],
      }),
    ).resolves.toEqual([]);
  });

  function simulateTrivialCall() {
    return simulate({
      client: ctx.publicClient,
      from: ctx.account.address,
      calls: [{ to: ctx.secondAccount.address, data: "0x" }],
    });
  }

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
    } satisfies { abi: Abi; address: Address };
  }
});

function patchRpc(
  ctx: AnvilTestContext,
  method: string,
  handler: (request: RpcRequest, next: () => Promise<unknown>) => Promise<unknown>,
) {
  const original = ctx.publicClient.request.bind(ctx.publicClient) as unknown as RpcDelegate;
  const replacement: RpcDelegate = async (request, options) => {
    if (isRpcRequest(request) && request.method === method) {
      return handler(request, () => original(request, options));
    }
    return original(request, options);
  };
  Object.assign(ctx.publicClient, { request: replacement });
}

function patchCall(
  ctx: AnvilTestContext,
  handler: (parameters: CallParameters, next: () => Promise<unknown>) => Promise<unknown>,
) {
  const original = ctx.publicClient.call.bind(ctx.publicClient) as unknown as CallDelegate;
  const replacement: CallDelegate = async (parameters) =>
    handler(parameters, () => original(parameters));
  Object.assign(ctx.publicClient, { call: replacement });
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    typeof value.method === "string"
  );
}
