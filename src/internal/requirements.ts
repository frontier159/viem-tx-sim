import type { Address, Hex } from "viem";
import { decodeFunctionData, parseAbi } from "viem";

import { InvalidSimulationInputError } from "../errors.js";
import type {
  AllowanceSlotPair,
  EstimatedAssetRequirements,
  EstimateAssetRequirementsArgs,
  SimulatedCall,
} from "../types.js";
import { OVERRIDE_TOKEN_AMOUNT } from "../constants.js";
import { probeRow } from "./checkpoints.js";
import { prepareAllowanceOverrides, prepareBalanceOverrides } from "./slots.js";
import { addressKey, uniqueAddresses } from "./data.js";
import type { ClientArgs } from "./rpc.js";
import { blockOptionsSpread } from "./rpc.js";
import { discoverCandidateAddresses, runSimulator } from "./simulator.js";

const allowanceSettingAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

type AllowanceProbe = {
  token: Address;
  spender: Address;
};

/** @internal Implements {@link TxSimulator.tokenOverrides.estimateRequirements}. Prefer the instance API from the package root. */
export async function estimateAssetRequirements(
  args: EstimateAssetRequirementsArgs & ClientArgs,
): Promise<EstimatedAssetRequirements> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("estimateAssetRequirements requires at least one call.");
  }

  const calls = args.calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
  let candidateAddresses: Address[];
  try {
    candidateAddresses = await discoverCandidateAddresses({
      client: args.client,
      from: args.from,
      calls,
      gas: args.gas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    });
  } catch (cause) {
    if (!isInsufficientFunds(cause)) throw cause;
    candidateAddresses = uniqueAddresses(calls.map((call) => call.to));
  }
  const recon = await runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: candidateAddresses,
    allowanceProbes: [],
    gas: args.gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
    ...(args.errorAbi !== undefined ? { errorAbi: args.errorAbi } : {}),
  });
  const tokens = recon.probeData.observedTokens;
  const spenders = uniqueAddresses([...calls.map((call) => call.to), ...candidateAddresses]).filter(
    (address) => addressKey(address) !== addressKey(args.from),
  );

  const [balanceOverrides, allowanceOverrides] = await Promise.all([
    prepareBalanceOverrides({
      client: args.client,
      from: args.from,
      tokens,
      gas: args.gas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    }),
    prepareAllowanceOverrides({
      client: args.client,
      from: args.from,
      pairs: allowancePairs(tokens, spenders),
      gas: args.gas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    }),
  ]);
  const balanceSlots = balanceOverrides.slots;
  const allowanceSlots = allowanceOverrides.slots;
  const allowanceProbes = allowanceSlots.map((slot) => ({
    token: slot.token,
    spender: slot.spender,
  }));
  const tokenSlotOverrides = [...balanceSlots, ...allowanceSlots];
  const measurement = await runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: candidateAddresses,
    tokenSlotOverrides,
    extraStateOverrides: [{ address: args.from, balance: OVERRIDE_TOKEN_AMOUNT }],
    allowanceProbes,
    gas: args.gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
    ...(args.errorAbi !== undefined ? { errorAbi: args.errorAbi } : {}),
  });
  const measuredAllowances = requiredAllowances(
    args.from,
    calls,
    allowanceProbes,
    measurement.probeData.allowanceCheckpoints,
    measurement.probeData.candidates,
    measurement.probeData.maxTokenOutflows,
  );

  const shared = {
    native: measurement.probeData.maxNativeOutflow,
    balances: requiredBalances(
      measurement.probeData.candidates,
      tokens,
      measurement.probeData.maxTokenOutflows,
    ),
    allowances: measuredAllowances.allowances,
    slots: tokenSlotOverrides,
    unresolved: {
      balanceSlots: balanceOverrides.unresolved,
      allowanceSlots: allowanceOverrides.unresolved,
      allowances: measuredAllowances.discarded,
    },
  };

  if (measurement.status === "reverted") {
    return {
      status: "reverted",
      ...shared,
      revertData: measurement.revertData,
      ...(measurement.revertReason !== undefined ? { revertReason: measurement.revertReason } : {}),
      ...(measurement.revertError !== undefined ? { revertError: measurement.revertError } : {}),
      ...(measurement.revertSelector !== undefined
        ? { revertSelector: measurement.revertSelector }
        : {}),
      failingCallIndex: measurement.failingCallIndex,
    };
  }

  return { status: "success", ...shared };
}

function isInsufficientFunds(cause: unknown): boolean {
  return cause instanceof Error && /insufficient (funds|balance)/i.test(cause.message);
}

function allowancePairs(
  tokens: readonly Address[],
  spenders: readonly Address[],
): AllowanceSlotPair[] {
  return tokens.flatMap((token) =>
    spenders
      .filter((spender) => addressKey(token) !== addressKey(spender))
      .map((spender) => ({ token, spender })),
  );
}

function requiredBalances(
  candidates: readonly Address[],
  tokens: readonly Address[],
  maxTokenOutflows: readonly bigint[],
): EstimatedAssetRequirements["balances"] {
  const tokenKeys = new Set(tokens.map(addressKey));
  const balances: EstimatedAssetRequirements["balances"] = [];
  for (let i = 0; i < candidates.length; ++i) {
    const amount = maxTokenOutflows[i] ?? 0n;
    const token = candidates[i];
    if (token !== undefined && amount > 0n && tokenKeys.has(addressKey(token))) {
      balances.push({ token, amount });
    }
  }
  return balances;
}

function requiredAllowances(
  owner: Address,
  calls: readonly SimulatedCall[],
  probes: readonly AllowanceProbe[],
  checkpoints: readonly bigint[],
  candidates: readonly Address[],
  maxTokenOutflows: readonly bigint[],
): {
  allowances: EstimatedAssetRequirements["allowances"];
  discarded: AllowanceSlotPair[];
} {
  const allowances: EstimatedAssetRequirements["allowances"] = [];
  const discarded: AllowanceSlotPair[] = [];

  for (let probeIndex = 0; probeIndex < probes.length; ++probeIndex) {
    const probe = probes[probeIndex];
    if (probe === undefined) continue;

    const row = probeRow(checkpoints, probeIndex, calls.length);
    const firstAllowanceSetIndex = firstInBatchAllowanceSetIndex(calls, owner, probe);
    const limit = firstAllowanceSetIndex ?? calls.length;
    let amount = 0n;
    for (let callIndex = 0; callIndex < limit; ++callIndex) {
      const before = row[callIndex] ?? 0n;
      const after = row[callIndex + 1] ?? 0n;
      if (before > after) amount += before - after;
    }
    if (amount > tokenOutflow(probe.token, candidates, maxTokenOutflows)) {
      discarded.push({ token: probe.token, spender: probe.spender });
      continue;
    }
    if (amount > 0n) allowances.push({ token: probe.token, spender: probe.spender, amount });
  }

  return { allowances, discarded };
}

function firstInBatchAllowanceSetIndex(
  calls: readonly SimulatedCall[],
  owner: Address,
  probe: AllowanceProbe,
): number | undefined {
  for (let i = 0; i < calls.length; ++i) {
    const call = calls[i];
    if (call === undefined || addressKey(call.to) !== addressKey(probe.token)) continue;
    if (isAllowanceSetForSpender(call.data, owner, probe.spender)) return i;
  }
  return undefined;
}

function isAllowanceSetForSpender(data: Hex, owner: Address, spender: Address): boolean {
  try {
    const decoded = decodeFunctionData({ abi: allowanceSettingAbi, data });
    if (decoded.functionName === "approve")
      return addressKey(decoded.args[0]) === addressKey(spender);
    return (
      addressKey(decoded.args[0]) === addressKey(owner) &&
      addressKey(decoded.args[1]) === addressKey(spender)
    );
  } catch {
    return false;
  }
}

function tokenOutflow(
  token: Address,
  candidates: readonly Address[],
  maxTokenOutflows: readonly bigint[],
): bigint {
  const index = candidates.findIndex((candidate) => addressKey(candidate) === addressKey(token));
  return index === -1 ? 0n : (maxTokenOutflows[index] ?? 0n);
}
