import type { Address, Hex, PublicClient, StateOverride } from "viem";
import { encodeFunctionData, erc20Abi } from "viem";

import type { AllowanceSlot, BalanceSlot, SimulationDebug } from "../types.js";
import { addressKey } from "./address.js";
import { withRpcDebug } from "./debug.js";
import { getCallData, uint256Hex } from "./hex.js";
import type { BlockOptions } from "./rpc.js";
import { blockOptionsSpread, buildCallParameters, createAccessList } from "./rpc.js";

async function readBalanceOf(
  args: {
    client: PublicClient;
    token: Address;
    owner: Address;
    stateOverride?: StateOverride;
    gas?: bigint;
    debug?: SimulationDebug;
    debugStep?: string;
  } & BlockOptions,
): Promise<bigint | undefined> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [args.owner],
  });

  return readUint256Call({
    client: args.client,
    account: args.owner,
    to: args.token,
    data,
    stateOverride: args.stateOverride,
    gas: args.gas,
    debug: args.debug,
    debugStep: args.debugStep ?? "erc20.balanceOf",
    ...blockOptionsSpread(args),
  });
}

export async function readAllowance(
  args: {
    client: PublicClient;
    token: Address;
    owner: Address;
    spender: Address;
    stateOverride?: StateOverride;
    gas?: bigint;
    debug?: SimulationDebug;
    debugStep?: string;
  } & BlockOptions,
): Promise<bigint | undefined> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [args.owner, args.spender],
  });

  return readUint256Call({
    client: args.client,
    account: args.owner,
    to: args.token,
    data,
    stateOverride: args.stateOverride,
    gas: args.gas,
    debug: args.debug,
    debugStep: args.debugStep ?? "erc20.allowance",
    ...blockOptionsSpread(args),
  });
}

export async function discoverBalanceSlot(
  args: {
    client: PublicClient;
    token: Address;
    owner: Address;
    sentinel: bigint;
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<BalanceSlot | undefined> {
  const data = encodeFunctionData({
    abi: erc20Abi,
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
      gas: args.gas,
      debug: args.debug,
      debugStep: "balanceSlot.accessList",
      ...blockOptionsSpread(args),
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
      gas: args.gas,
      debug: args.debug,
      debugStep: "balanceSlot.verify",
      ...blockOptionsSpread(args),
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
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot | undefined> {
  const data = encodeFunctionData({
    abi: erc20Abi,
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
      gas: args.gas,
      debug: args.debug,
      debugStep: "allowanceSlot.accessList",
      ...blockOptionsSpread(args),
    });
    storageKeys = accessList
      .filter((entry) => addressKey(entry.address) === addressKey(args.token))
      .flatMap((entry) => entry.storageKeys);
  } catch {
    return undefined;
  }

  const sentinelHex = uint256Hex(args.sentinel);
  for (const slot of storageKeys) {
    const allowance = await readAllowance({
      client: args.client,
      token: args.token,
      owner: args.owner,
      spender: args.spender,
      stateOverride: [{ address: args.token, stateDiff: [{ slot, value: sentinelHex }] }],
      gas: args.gas,
      debug: args.debug,
      debugStep: "allowanceSlot.verify",
      ...blockOptionsSpread(args),
    });
    if (allowance === args.sentinel) {
      return {
        token: args.token,
        spender: args.spender,
        slot,
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
    gas?: bigint;
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
            gas: args.gas,
            ...blockOptionsSpread(args),
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
