import type { Address, Hex, StateOverride } from "viem";
import { encodeFunctionData, erc20Abi } from "viem";

import { addressKey } from "./data.js";
import { DEBUG_STEPS } from "./debugSteps.js";
import type { DebugStep } from "./debugSteps.js";
import { withRpcDebug } from "./rpc.js";
import { getCallData, uint256Hex } from "./data.js";
import type { RpcCallArgs } from "./rpc.js";
import { blockOptionsSpread, buildCallParameters, createAccessList } from "./rpc.js";

type ProbedSlot = {
  token: Address;
  slot: Hex;
};

type ProbedAllowanceSlot = ProbedSlot & {
  spender: Address;
};

export async function readAllowance(
  args: RpcCallArgs & {
    token: Address;
    owner: Address;
    spender: Address;
    stateOverride?: StateOverride;
    debugStep: DebugStep;
  },
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
    debugStep: args.debugStep,
    ...blockOptionsSpread(args),
  });
}

async function discoverSlot(
  args: RpcCallArgs & {
    token: Address;
    owner: Address;
    data: Hex;
    sentinel: bigint;
    steps: { accessList: DebugStep; verify: DebugStep };
  },
): Promise<Hex | undefined> {
  let storageKeys: Hex[];
  try {
    const accessList = await createAccessList({
      client: args.client,
      from: args.owner,
      to: args.token,
      data: args.data,
      gas: args.gas,
      debug: args.debug,
      debugStep: args.steps.accessList,
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
    const value = await readUint256Call({
      client: args.client,
      account: args.owner,
      to: args.token,
      data: args.data,
      stateOverride: [{ address: args.token, stateDiff: [{ slot, value: sentinelHex }] }],
      gas: args.gas,
      debug: args.debug,
      debugStep: args.steps.verify,
      ...blockOptionsSpread(args),
    });
    if (value === args.sentinel) return slot;
  }

  return undefined;
}

export async function discoverBalanceSlot(
  args: RpcCallArgs & {
    token: Address;
    owner: Address;
    sentinel: bigint;
  },
): Promise<ProbedSlot | undefined> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [args.owner],
  });

  const slot = await discoverSlot({
    ...args,
    data,
    steps: { accessList: DEBUG_STEPS.balanceSlotAccessList, verify: DEBUG_STEPS.balanceSlotVerify },
  });
  return slot === undefined ? undefined : { token: args.token, slot };
}

export async function discoverAllowanceSlot(
  args: RpcCallArgs & {
    token: Address;
    owner: Address;
    spender: Address;
    sentinel: bigint;
  },
): Promise<ProbedAllowanceSlot | undefined> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "allowance",
    args: [args.owner, args.spender],
  });

  const slot = await discoverSlot({
    ...args,
    data,
    steps: {
      accessList: DEBUG_STEPS.allowanceSlotAccessList,
      verify: DEBUG_STEPS.allowanceSlotVerify,
    },
  });
  return slot === undefined ? undefined : { token: args.token, spender: args.spender, slot };
}

async function readUint256Call(
  args: RpcCallArgs & {
    account: Address;
    to: Address;
    data: Hex;
    stateOverride?: StateOverride;
    debugStep: DebugStep;
  },
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
