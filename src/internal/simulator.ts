import type { Abi, Address, Hex, StateOverride } from "viem";
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  slice,
  size,
  zeroAddress,
} from "viem";

import type { RevertError, SimulatedCall, TokenSlotOverride } from "../types.js";
import { InvalidSimulationInputError, StateOverrideUnsupportedError } from "../errors.js";
import { txSimulatorRuntimeBytecode } from "../generated/txSimulatorBytecode.js";
import { DEBUG_STEPS } from "./debugSteps.js";
import type { DebugStep } from "./debugSteps.js";
import {
  MAX_UINT256,
  addressKey,
  getCallData,
  normalizeAddress,
  uint256Hex,
  uniqueAddresses,
} from "./data.js";
import type { RpcCallArgs } from "./rpc.js";
import {
  blockOptionsSpread,
  buildCallParameters,
  createAccessList,
  formatRpcError,
  withRpcDebug,
} from "./rpc.js";

type ProbeData = {
  observedTokens: Address[];
  candidates: Address[];
  maxTokenOutflows: readonly bigint[];
  maxNativeOutflow: bigint;
  allowanceCheckpoints: readonly bigint[];
  balanceCheckpoints: readonly bigint[];
  balanceProbeOk: readonly boolean[];
};

type SimulatorBase = {
  probeData: ProbeData;
};

export type SimulatorResult =
  | (SimulatorBase & { status: "success" })
  | (SimulatorBase & {
      status: "reverted";
      revertData: Hex;
      revertReason?: string;
      revertError?: RevertError;
      revertSelector?: Hex;
      failingCallIndex: number;
    });

/** @internal Also imported by test helpers to encode node-shaped simulator returndata. */
export const txSimulatorAbi = parseAbi([
  "struct SimulatedCall { address to; uint256 value; bytes data; }",
  "struct AllowanceProbe { address token; address spender; }",
  "struct BalanceProbe { address token; address account; }",
  "struct SimulationResult { bool success; uint256 failingCallIndex; bytes revertData; address[] observedTokens; uint256[] maxTokenOutflows; uint256 maxNativeOutflow; uint256[] allowanceCheckpoints; uint256[] balanceCheckpoints; bool[] balanceProbeOk; }",
  "function simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes, BalanceProbe[] balanceProbes) returns (SimulationResult)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);

export async function runSimulator(
  args: RpcCallArgs & {
    from: Address;
    calls: readonly SimulatedCall[];
    candidates: readonly Address[];
    tokenSlotOverrides?: readonly TokenSlotOverride[];
    extraStateOverrides?: readonly StateOverrideEntry[];
    allowanceProbes?: readonly { token: Address; spender: Address }[];
    balanceProbes?: readonly { token: Address | "native"; account: Address }[];
    debugStep?: DebugStep;
    errorAbi?: Abi;
  },
): Promise<SimulatorResult> {
  const candidates = uniqueAddresses(args.candidates);
  const balanceProbes = (args.balanceProbes ?? []).map((probe) => ({
    token: probe.token === "native" ? zeroAddress : probe.token,
    account: probe.account,
  }));
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
      balanceProbes,
    ],
  });

  const stateOverride = buildStateOverride([
    { address: args.from, code: txSimulatorRuntimeBytecode },
    ...tokenSlotOverridesToStateDiff(args.tokenSlotOverrides ?? []),
    ...(args.extraStateOverrides ?? []),
  ]);

  let callData: Hex;
  try {
    const result = await withRpcDebug(
      args.debug,
      {
        method: "eth_call",
        step: args.debugStep ?? DEBUG_STEPS.txSimulatorSimulate,
        details: {
          from: args.from,
          calls: args.calls.length,
          candidates: candidates.length,
          balanceProbes: balanceProbes.length,
          storageOverrides: args.tokenSlotOverrides?.length ?? 0,
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

  const probeData = {
    observedTokens: uniqueAddresses(result.observedTokens),
    candidates,
    maxTokenOutflows: result.maxTokenOutflows,
    maxNativeOutflow: result.maxNativeOutflow,
    allowanceCheckpoints: result.allowanceCheckpoints,
    balanceCheckpoints: result.balanceCheckpoints,
    balanceProbeOk: result.balanceProbeOk,
  };

  if (!result.success) {
    const decodedRevert = decodeRevert(result.revertData, args.errorAbi);
    return {
      status: "reverted",
      revertData: result.revertData,
      ...(decodedRevert.revertReason !== undefined
        ? { revertReason: decodedRevert.revertReason }
        : {}),
      ...(decodedRevert.revertError !== undefined
        ? { revertError: decodedRevert.revertError }
        : {}),
      ...(decodedRevert.revertSelector !== undefined
        ? { revertSelector: decodedRevert.revertSelector }
        : {}),
      failingCallIndex: Number(result.failingCallIndex),
      probeData,
    };
  }

  return {
    status: "success",
    probeData,
  };
}

export async function discoverCandidateAddresses(
  args: RpcCallArgs & {
    from: Address;
    calls: readonly SimulatedCall[];
  },
): Promise<Address[]> {
  const accessLists = await Promise.all(
    args.calls.map((call) =>
      createAccessList({
        client: args.client,
        from: args.from,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
        gas: args.gas,
        accessListGas: args.accessListGas,
        debug: args.debug,
        debugStep: DEBUG_STEPS.candidateDiscoveryAccessList,
        ...blockOptionsSpread(args),
      }),
    ),
  );
  const candidates = args.calls.flatMap((call, index) => [
    call.to,
    ...(accessLists[index] ?? []).map((entry) => entry.address),
  ]);

  return uniqueAddresses(candidates);
}

type DecodedRevert = {
  revertReason?: string;
  revertError?: { name: string; args: readonly unknown[] };
  revertSelector?: Hex;
};

function decodeRevert(data: Hex | undefined, errorAbi?: Abi): DecodedRevert {
  if (!data || data === "0x") return {};

  const revertSelector = size(data) >= 4 ? slice(data, 0, 4) : undefined;
  try {
    const decoded = decodeErrorResult({ abi: errorAbi ?? [], data });
    return {
      revertReason: formatReason(decoded.errorName, decoded.args ?? []),
      revertError: { name: decoded.errorName, args: decoded.args ?? [] },
      ...(revertSelector !== undefined ? { revertSelector } : {}),
    };
  } catch {
    return revertSelector !== undefined ? { revertSelector } : {};
  }
}

function formatReason(name: string, args: readonly unknown[]): string {
  if (name === "Error") return String(args[0]);
  if (name === "Panic") return `Panic(${String(args[0])})`;
  return `${name}(${args.map((arg) => String(arg)).join(", ")})`;
}

type StateOverrideEntry = StateOverride[number];

type MutableStateOverrideEntry = {
  address: Address;
  code?: Hex;
  balance?: bigint;
  stateDiff?: {
    slot: Hex;
    value: Hex;
  }[];
};

function buildStateOverride(entries: readonly StateOverrideEntry[]): StateOverride {
  const merged = new Map<string, MutableStateOverrideEntry>();

  for (const entry of entries) {
    const normalized = normalizeAddress(entry.address);
    const key = addressKey(normalized);
    const existing = merged.get(key) ?? { address: normalized, stateDiff: [] };

    if (entry.code) existing.code = entry.code;
    if (entry.balance !== undefined) existing.balance = entry.balance;
    if (entry.stateDiff) {
      const bySlot = new Map(
        (existing.stateDiff ?? []).map((item) => [item.slot.toLowerCase(), item]),
      );
      for (const diff of entry.stateDiff) bySlot.set(diff.slot.toLowerCase(), diff);
      existing.stateDiff = [...bySlot.values()];
    }

    merged.set(key, existing);
  }

  return [...merged.values()].map((entry): StateOverrideEntry => {
    if (entry.stateDiff?.length === 0) {
      return {
        address: entry.address,
        code: entry.code,
        balance: entry.balance,
      };
    }
    return entry;
  });
}

function tokenSlotOverridesToStateDiff(overrides: readonly TokenSlotOverride[]): StateOverride {
  const byAddress = new Map<string, MutableStateOverrideEntry>();

  for (const override of overrides) {
    if (override.amount === MAX_UINT256) {
      throw new InvalidSimulationInputError(
        "tokenSlotOverrides amount must be below uint256 max: max-allowance skips ERC-20 decrements and max-balance overflows incoming transfers. Use OVERRIDE_TOKEN_AMOUNT.",
      );
    }
    const normalized = normalizeAddress(override.token);
    const key = addressKey(normalized);
    const entry = byAddress.get(key) ?? { address: normalized, stateDiff: [] };
    entry.stateDiff?.push({
      slot: override.slot,
      value: uint256Hex(override.amount),
    });
    byAddress.set(key, entry);
  }

  return [...byAddress.values()];
}
