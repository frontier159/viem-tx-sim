import type { Address, Hex } from "viem";
import { decodeFunctionData, parseAbi } from "viem";

import { DEFAULT_SIMULATION_GAS_LIMIT } from "./constants.js";
import { InvalidSimulationInputError } from "./errors.js";
import type {
  AllowanceSlot,
  AllowanceSlotPair,
  BalanceSlot,
  DiscoveredRequirements,
  DiscoverRequirementsArgs,
  SimulatedCall,
  TokenSlotOverride,
} from "./types.js";
import { discoverAllowanceSlots, discoverBalanceSlots } from "./internal/slotDiscovery.js";
import { addressKey, uniqueAddresses } from "./internal/address.js";
import { discoverCandidateAddresses } from "./internal/discovery.js";
import { OVERRIDE_TOKEN_AMOUNT, uint256Hex } from "./internal/hex.js";
import type { ClientArgs } from "./internal/rpc.js";
import { blockOptionsSpread } from "./internal/rpc.js";
import { runSimulator } from "./internal/simulator.js";
import type { StorageOverride } from "./internal/stateOverride.js";

const allowanceSettingAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

type AllowanceProbe = {
  token: Address;
  spender: Address;
};

/** @internal Implements {@link TxSimulator.discoverRequirements}. Prefer the instance API from the package root. */
export async function discoverRequirements(
  args: DiscoverRequirementsArgs & ClientArgs,
): Promise<DiscoveredRequirements> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("discoverRequirements requires at least one call.");
  }

  const gas = args.gas ?? DEFAULT_SIMULATION_GAS_LIMIT;
  const calls = args.calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
  const candidateAddresses = await discoverCandidateAddresses({
    client: args.client,
    from: args.from,
    calls,
    gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
  const recon = await runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: candidateAddresses,
    allowanceProbes: [],
    gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
  const tokens = recon.probeData.observedTokens;
  const spenders = uniqueAddresses([...calls.map((call) => call.to), ...candidateAddresses]).filter(
    (address) => addressKey(address) !== addressKey(args.from),
  );

  const balanceDiscovery = await discoverBalanceSlots({
    client: args.client,
    from: args.from,
    tokens,
    gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
  const allowanceDiscovery = await discoverAllowanceSlots({
    client: args.client,
    from: args.from,
    pairs: allowancePairs(tokens, spenders),
    gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
  const balanceSlots = balanceDiscovery.slots;
  const allowanceSlots = allowanceDiscovery.slots;
  const allowanceProbes = allowanceSlots.map((slot) => ({
    token: slot.token,
    spender: slot.spender,
  }));
  const storageOverrides = [...balanceSlots, ...allowanceSlots].map(slotOverride);
  const measurement = await runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: candidateAddresses,
    storageOverrides,
    allowanceProbes,
    gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
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
    slots: [...balanceSlots, ...allowanceSlots].map(tokenSlotOverride),
    unresolved: {
      balanceSlots: balanceDiscovery.unresolved,
      allowanceSlots: allowanceDiscovery.unresolved,
      allowances: measuredAllowances.discarded,
    },
  };

  if (measurement.status === "reverted") {
    return {
      status: "reverted",
      ...shared,
      revertData: measurement.revertData,
      ...(measurement.revertReason !== undefined ? { revertReason: measurement.revertReason } : {}),
      failingCallIndex: measurement.failingCallIndex,
    };
  }

  return { status: "success", ...shared };
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
): DiscoveredRequirements["balances"] {
  const tokenKeys = new Set(tokens.map(addressKey));
  const balances: DiscoveredRequirements["balances"] = [];
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
  allowances: DiscoveredRequirements["allowances"];
  discarded: AllowanceSlotPair[];
} {
  const allowances: DiscoveredRequirements["allowances"] = [];
  const discarded: AllowanceSlotPair[] = [];
  const stride = calls.length + 1;

  for (let probeIndex = 0; probeIndex < probes.length; ++probeIndex) {
    const probe = probes[probeIndex];
    if (probe === undefined) continue;

    const firstAllowanceSetIndex = firstInBatchAllowanceSetIndex(calls, owner, probe);
    const limit = firstAllowanceSetIndex ?? calls.length;
    let amount = 0n;
    for (let callIndex = 0; callIndex < limit; ++callIndex) {
      const before = checkpoints[probeIndex * stride + callIndex] ?? 0n;
      const after = checkpoints[probeIndex * stride + callIndex + 1] ?? 0n;
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

function slotOverride(slot: BalanceSlot | AllowanceSlot): StorageOverride {
  return {
    address: slot.token,
    slot: slot.slot,
    value: uint256Hex(OVERRIDE_TOKEN_AMOUNT),
  };
}

function tokenSlotOverride(slot: BalanceSlot | AllowanceSlot): TokenSlotOverride {
  return { token: slot.token, slot: slot.slot };
}
