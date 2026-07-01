import type { Address, CallParameters, Hex, PublicClient, StateOverride } from "viem";
import { decodeFunctionResult, encodeFunctionData } from "viem";

import type { AssetBalanceDelta, SimulatedCall, SimulationResult } from "../types.js";
import { StateOverrideUnsupportedError } from "../errors.js";
import { txSimulatorRuntimeBytecode } from "../generated/txSimulatorBytecode.js";
import { txSimulatorAbi } from "./abi.js";
import { uniqueAddresses } from "./address.js";
import { withRpcDebug } from "./debug.js";
import { getCallData } from "./hex.js";
import { decodeRevertReason } from "./revert.js";
import type { BlockOptions } from "./rpc.js";
import { formatRpcError } from "./rpc.js";
import {
  buildStateOverride,
  storageOverridesToStateDiff,
  type StateOverrideEntry,
  type StorageOverride,
} from "./stateOverride.js";

export type InternalSimulationResult = SimulationResult & {
  observedTokens: Address[];
};

export async function runSimulator(
  args: {
    client: PublicClient;
    from: Address;
    calls: readonly SimulatedCall[];
    candidates: readonly Address[];
    storageOverrides?: readonly StorageOverride[];
    extraStateOverrides?: readonly StateOverrideEntry[];
    gas?: bigint;
    debug?: import("../types.js").SimulationDebug;
    debugStep?: string;
  } & BlockOptions,
): Promise<InternalSimulationResult> {
  const data = encodeFunctionData({
    abi: txSimulatorAbi,
    functionName: "simulate",
    args: [
      args.calls.map((call) => ({
        to: call.to,
        value: call.value ?? 0n,
        data: call.calldata,
      })),
      uniqueAddresses(args.candidates),
    ],
  });

  const stateOverride = buildStateOverride([
    { address: args.from, code: txSimulatorRuntimeBytecode },
    ...storageOverridesToStateDiff(args.storageOverrides ?? []),
    ...(args.extraStateOverrides ?? []),
  ]);

  let callData: Hex;
  try {
    const result = await withRpcDebug(
      args.debug,
      {
        method: "eth_call",
        step: args.debugStep ?? "txSimulator.simulate",
        details: {
          from: args.from,
          calls: args.calls.length,
          candidates: uniqueAddresses(args.candidates).length,
          storageOverrides: args.storageOverrides?.length ?? 0,
          stateOverrideAccounts: stateOverride.length,
        },
      },
      () =>
        args.client.call(
          buildCallParameters({
            account: args.from,
            to: args.from,
            data,
            gas: args.gas,
            stateOverride,
            blockNumber: args.blockNumber,
            blockTag: args.blockTag,
          }),
        ),
    );
    callData = getCallData(result);
  } catch (cause) {
    throw new StateOverrideUnsupportedError(
      formatRpcError("eth_call with state override failed", cause),
    );
  }

  const decoded = decodeFunctionResult({
    abi: txSimulatorAbi,
    functionName: "simulate",
    data: callData,
  }) as unknown;
  const tuple = Array.isArray(decoded) ? decoded[0] : decoded;
  const result = tuple as {
    success: boolean;
    failingCallIndex: bigint;
    revertData: Hex;
    nativeDelta: bigint;
    observedTokens: Address[];
    deltaTokens: Address[];
    tokenDeltas: bigint[];
  };

  const assetBalanceDeltas: AssetBalanceDelta[] = [];
  if (result.nativeDelta !== 0n) {
    assetBalanceDeltas.push({ asset: "native", delta: result.nativeDelta });
  }

  for (let i = 0; i < result.deltaTokens.length; ++i) {
    const token = result.deltaTokens[i];
    const delta = result.tokenDeltas[i];
    if (token && delta !== undefined && delta !== 0n) {
      assetBalanceDeltas.push({ asset: token, delta });
    }
  }

  const status = result.success ? "success" : "reverted";
  const failingCallIndex =
    result.failingCallIndex === (1n << 256n) - 1n ? undefined : Number(result.failingCallIndex);
  const revertData = status === "reverted" ? result.revertData : undefined;

  return {
    status,
    assetBalanceDeltas,
    ...(revertData ? { revertData } : {}),
    ...(revertData ? { revertReason: decodeRevertReason(revertData) } : {}),
    ...(failingCallIndex !== undefined ? { failingCallIndex } : {}),
    observedTokens: uniqueAddresses(result.observedTokens),
  };
}

function buildCallParameters(
  args: {
    account: Address;
    to: Address;
    data: Hex;
    gas?: bigint;
    stateOverride: StateOverride;
  } & BlockOptions,
): CallParameters {
  const base = {
    account: args.account,
    to: args.to,
    data: args.data,
    ...(args.gas !== undefined ? { gas: args.gas } : {}),
    stateOverride: args.stateOverride,
  };
  return (
    args.blockNumber !== undefined
      ? { ...base, blockNumber: args.blockNumber }
      : { ...base, ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}) }
  ) satisfies CallParameters;
}
