import type { Address, Hex } from "viem";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

import type { AssetBalanceDelta, SimulatedCall, SimulationResult } from "../types.js";
import { StateOverrideUnsupportedError } from "../errors.js";
import { txSimulatorRuntimeBytecode } from "../generated/txSimulatorBytecode.js";
import { uniqueAddresses } from "./address.js";
import { withRpcDebug } from "./debug.js";
import { getCallData } from "./hex.js";
import { decodeRevertReason } from "./revert.js";
import type { RpcCallArgs } from "./rpc.js";
import { blockOptionsSpread, buildCallParameters, formatRpcError } from "./rpc.js";
import {
  buildStateOverride,
  storageOverridesToStateDiff,
  type StateOverrideEntry,
  type StorageOverride,
} from "./stateOverride.js";

type ProbeData = {
  observedTokens: Address[];
  candidates: Address[];
  maxTokenOutflows: readonly bigint[];
  maxNativeOutflow: bigint;
  allowanceCheckpoints: readonly bigint[];
};

export type SimulatorResult = SimulationResult & {
  probeData: ProbeData;
};

const txSimulatorAbi = parseAbi([
  "struct SimulatedCall { address to; uint256 value; bytes data; }",
  "struct AllowanceProbe { address token; address spender; }",
  "struct SimulationResult { bool success; uint256 failingCallIndex; bytes revertData; int256 nativeDelta; address[] observedTokens; address[] deltaTokens; int256[] tokenDeltas; uint256[] maxTokenOutflows; uint256 maxNativeOutflow; uint256[] allowanceCheckpoints; }",
  "function simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes) returns (SimulationResult)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

export async function runSimulator(
  args: RpcCallArgs & {
    from: Address;
    calls: readonly SimulatedCall[];
    candidates: readonly Address[];
    storageOverrides?: readonly StorageOverride[];
    extraStateOverrides?: readonly StateOverrideEntry[];
    allowanceProbes?: readonly { token: Address; spender: Address }[];
    debugStep?: string;
  },
): Promise<SimulatorResult> {
  const candidates = uniqueAddresses(args.candidates);
  const data = encodeFunctionData({
    abi: txSimulatorAbi,
    functionName: "simulate",
    args: [
      args.calls.map((call) => ({
        to: call.to,
        value: call.value ?? 0n,
        data: call.data,
      })),
      candidates,
      args.allowanceProbes ?? [],
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
          candidates: candidates.length,
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
            ...blockOptionsSpread(args),
          }),
        ),
    );
    callData = getCallData(result);
  } catch (cause) {
    throw new StateOverrideUnsupportedError(
      formatRpcError("eth_call with state override failed", cause),
    );
  }

  let result;
  try {
    result = decodeFunctionResult({
      abi: txSimulatorAbi,
      functionName: "simulate",
      data: callData,
    });
  } catch (cause) {
    throw new StateOverrideUnsupportedError(
      formatRpcError("eth_call returned undecodable simulator output", cause),
    );
  }

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

  const probeData = {
    observedTokens: uniqueAddresses(result.observedTokens),
    candidates,
    maxTokenOutflows: result.maxTokenOutflows,
    maxNativeOutflow: result.maxNativeOutflow,
    allowanceCheckpoints: result.allowanceCheckpoints,
  };

  if (!result.success) {
    const revertReason = decodeRevertReason(result.revertData);
    return {
      status: "reverted",
      assetBalanceDeltas,
      revertData: result.revertData,
      ...(revertReason !== undefined ? { revertReason } : {}),
      failingCallIndex: Number(result.failingCallIndex),
      probeData,
    };
  }

  return {
    status: "success",
    assetBalanceDeltas,
    probeData,
  };
}
