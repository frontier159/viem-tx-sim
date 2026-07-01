import type { Address, CallParameters, Hex, PublicClient, StateOverride } from "viem";
import { encodeFunctionData } from "viem";

import type { SimulationDebug } from "../types.js";
import { erc20ProbeAbi } from "./abi.js";
import { addressKey } from "./address.js";
import { withRpcDebug } from "./debug.js";
import type { BlockOptions } from "./rpc.js";
import { createAccessList } from "./rpc.js";
import { uint256Hex } from "./hex.js";
import { getCallData } from "./hex.js";

export type TokenBalanceSlot = {
  token: Address;
  slot: Hex;
};

export type AllowanceSlot = {
  token: Address;
  spender: Address;
  slot: Hex;
  currentAllowance: bigint;
};

export async function readBalanceOf(
  args: {
    client: PublicClient;
    token: Address;
    owner: Address;
    stateOverride?: StateOverride;
    debug?: SimulationDebug;
    debugStep?: string;
  } & BlockOptions,
): Promise<bigint | undefined> {
  const data = encodeFunctionData({
    abi: erc20ProbeAbi,
    functionName: "balanceOf",
    args: [args.owner],
  });

  return readUint256Call({
    client: args.client,
    account: args.owner,
    to: args.token,
    data,
    stateOverride: args.stateOverride,
    debug: args.debug,
    debugStep: args.debugStep ?? "erc20.balanceOf",
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });
}

export async function readAllowance(
  args: {
    client: PublicClient;
    token: Address;
    owner: Address;
    spender: Address;
    stateOverride?: StateOverride;
    debug?: SimulationDebug;
    debugStep?: string;
  } & BlockOptions,
): Promise<bigint | undefined> {
  const data = encodeFunctionData({
    abi: erc20ProbeAbi,
    functionName: "allowance",
    args: [args.owner, args.spender],
  });

  return readUint256Call({
    client: args.client,
    account: args.owner,
    to: args.token,
    data,
    stateOverride: args.stateOverride,
    debug: args.debug,
    debugStep: args.debugStep ?? "erc20.allowance",
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });
}

export async function discoverBalanceSlot(
  args: {
    client: PublicClient;
    token: Address;
    owner: Address;
    sentinel: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<TokenBalanceSlot | undefined> {
  const data = encodeFunctionData({
    abi: erc20ProbeAbi,
    functionName: "balanceOf",
    args: [args.owner],
  });

  let storageKeys: Hex[];
  try {
    const accessList = await createAccessList({
      client: args.client,
      from: args.owner,
      to: args.token,
      data,
      debug: args.debug,
      debugStep: "balanceSlot.accessList",
      blockNumber: args.blockNumber,
      blockTag: args.blockTag,
    });
    storageKeys = accessList
      .filter((entry) => addressKey(entry.address) === addressKey(args.token))
      .flatMap((entry) => entry.storageKeys);
  } catch {
    return undefined;
  }

  const sentinelHex = uint256Hex(args.sentinel);
  for (const slot of storageKeys) {
    const balance = await readBalanceOf({
      client: args.client,
      token: args.token,
      owner: args.owner,
      stateOverride: [{ address: args.token, stateDiff: [{ slot, value: sentinelHex }] }],
      debug: args.debug,
      debugStep: "balanceSlot.verify",
      blockNumber: args.blockNumber,
      blockTag: args.blockTag,
    });
    if (balance === args.sentinel) return { token: args.token, slot };
  }

  return undefined;
}

export async function discoverAllowanceSlot(
  args: {
    client: PublicClient;
    token: Address;
    owner: Address;
    spender: Address;
    sentinel: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot | undefined> {
  const data = encodeFunctionData({
    abi: erc20ProbeAbi,
    functionName: "allowance",
    args: [args.owner, args.spender],
  });

  let storageKeys: Hex[];
  try {
    const accessList = await createAccessList({
      client: args.client,
      from: args.owner,
      to: args.token,
      data,
      debug: args.debug,
      debugStep: "allowanceSlot.accessList",
      blockNumber: args.blockNumber,
      blockTag: args.blockTag,
    });
    storageKeys = accessList
      .filter((entry) => addressKey(entry.address) === addressKey(args.token))
      .flatMap((entry) => entry.storageKeys);
  } catch {
    return undefined;
  }

  const currentAllowance = await readAllowance({
    client: args.client,
    token: args.token,
    owner: args.owner,
    spender: args.spender,
    debug: args.debug,
    debugStep: "allowanceSlot.currentAllowance",
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });
  if (currentAllowance === undefined) return undefined;

  const sentinelHex = uint256Hex(args.sentinel);
  for (const slot of storageKeys) {
    const allowance = await readAllowance({
      client: args.client,
      token: args.token,
      owner: args.owner,
      spender: args.spender,
      stateOverride: [{ address: args.token, stateDiff: [{ slot, value: sentinelHex }] }],
      debug: args.debug,
      debugStep: "allowanceSlot.verify",
      blockNumber: args.blockNumber,
      blockTag: args.blockTag,
    });
    if (allowance === args.sentinel) {
      return {
        token: args.token,
        spender: args.spender,
        slot,
        currentAllowance,
      };
    }
  }

  return undefined;
}

async function readUint256Call(
  args: {
    client: PublicClient;
    account: Address;
    to: Address;
    data: Hex;
    stateOverride?: StateOverride;
    debug?: SimulationDebug;
    debugStep: string;
  } & BlockOptions,
): Promise<bigint | undefined> {
  try {
    const result = await withRpcDebug(
      args.debug,
      {
        method: "eth_call",
        step: args.debugStep,
        details: {
          account: args.account,
          to: args.to,
          stateOverrides: args.stateOverride?.length ?? 0,
        },
      },
      () =>
        args.client.call(
          buildCallParameters({
            account: args.account,
            to: args.to,
            data: args.data,
            stateOverride: args.stateOverride,
            blockNumber: args.blockNumber,
            blockTag: args.blockTag,
          }),
        ),
    );
    const data = getCallData(result);
    if (data.length < 66) return undefined;
    return BigInt(data);
  } catch {
    return undefined;
  }
}

function buildCallParameters(
  args: {
    account: Address;
    to: Address;
    data: Hex;
    stateOverride?: StateOverride;
  } & BlockOptions,
): CallParameters {
  const base = {
    account: args.account,
    to: args.to,
    data: args.data,
    ...(args.stateOverride !== undefined ? { stateOverride: args.stateOverride } : {}),
  };
  return (
    args.blockNumber !== undefined
      ? { ...base, blockNumber: args.blockNumber }
      : { ...base, ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}) }
  ) satisfies CallParameters;
}
