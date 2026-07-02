import type { Address, Hex, PublicClient } from "viem";
import { decodeFunctionData, erc20Abi } from "viem";

import { InvalidSimulationInputError } from "./errors.js";
import type {
  AllowanceSlot,
  BalanceSlot,
  DiscoveredRequirements,
  SimulatedCall,
  SimulationDebug,
  TokenSlotOverride,
} from "./types.js";
import { addressKey, uniqueAddresses } from "./internal/address.js";
import { discoverCandidateAddresses } from "./internal/discovery.js";
import { OVERRIDE_TOKEN_AMOUNT, uint256Hex } from "./internal/hex.js";
import { allowanceSlotFor, inferAllowanceBaseSlot } from "./internal/layout.js";
import { discoverAllowanceSlot, discoverBalanceSlot, readAllowance } from "./internal/probes.js";
import type { BlockOptions } from "./internal/rpc.js";
import { runSimulator } from "./internal/simulator.js";
import type { StorageOverride } from "./internal/stateOverride.js";

const DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n;

type AllowanceProbe = {
  token: Address;
  spender: Address;
};

export async function discoverRequirements(
  args: {
    client: PublicClient;
    from: Address;
    calls: readonly SimulatedCall[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<DiscoveredRequirements> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("discoverRequirements requires at least one call.");
  }

  const gas = args.gas ?? DEFAULT_SIMULATION_GAS_LIMIT;
  const calls = args.calls.map((call) => ({
    to: call.to,
    calldata: call.calldata,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
  const candidateAddresses = await discoverCandidateAddresses({
    client: args.client,
    from: args.from,
    calls,
    gas,
    debug: args.debug,
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });
  const recon = await runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: candidateAddresses,
    allowanceProbes: [],
    gas,
    debug: args.debug,
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });
  const tokens = recon.probeData.observedTokens;
  const spenders = uniqueAddresses([...calls.map((call) => call.to), ...candidateAddresses]).filter(
    (address) => addressKey(address) !== addressKey(args.from),
  );

  const balanceSlots = await discoverBalanceSlots({ ...args, tokens, gas });
  const allowanceSlots = await discoverAllAllowanceSlots({ ...args, tokens, spenders, gas });
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
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });

  return {
    status: measurement.status,
    native: measurement.probeData.maxNativeOutflow,
    balances: requiredBalances(
      measurement.probeData.candidates,
      tokens,
      measurement.probeData.maxTokenOutflows,
    ),
    allowances: requiredAllowances(
      calls,
      allowanceProbes,
      measurement.probeData.allowanceCheckpoints,
    ),
    slots: [...balanceSlots, ...allowanceSlots].map(tokenSlotOverride),
    revertData: measurement.revertData,
    revertReason: measurement.revertReason,
    failingCallIndex: measurement.failingCallIndex,
  };
}

async function discoverBalanceSlots(
  args: {
    client: PublicClient;
    from: Address;
    tokens: readonly Address[];
    gas: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<BalanceSlot[]> {
  const slots: BalanceSlot[] = [];
  for (const token of args.tokens) {
    const slot = await discoverBalanceSlot({
      client: args.client,
      token,
      owner: args.from,
      sentinel: OVERRIDE_TOKEN_AMOUNT,
      gas: args.gas,
      debug: args.debug,
      blockNumber: args.blockNumber,
      blockTag: args.blockTag,
    });
    if (slot !== undefined) slots.push(slot);
  }
  return slots;
}

async function discoverAllAllowanceSlots(
  args: {
    client: PublicClient;
    from: Address;
    tokens: readonly Address[];
    spenders: readonly Address[];
    gas: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot[]> {
  const slots: AllowanceSlot[] = [];
  for (const token of args.tokens) {
    let baseSlot: bigint | undefined;
    let triedBaseInference = false;

    for (const spender of args.spenders) {
      if (addressKey(token) === addressKey(spender)) continue;

      const slot =
        triedBaseInference && baseSlot !== undefined
          ? await discoverComputedAllowanceSlot({ ...args, token, spender, baseSlot })
          : await discoverProbedAllowanceSlot({ ...args, token, spender });

      if (!triedBaseInference) {
        triedBaseInference = true;
        if (slot !== undefined) {
          baseSlot = inferAllowanceBaseSlot({ probedSlot: slot.slot, owner: args.from, spender });
        }
      }

      if (slot !== undefined) slots.push(slot);
    }
  }
  return slots;
}

async function discoverProbedAllowanceSlot(
  args: {
    client: PublicClient;
    from: Address;
    token: Address;
    spender: Address;
    gas: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot | undefined> {
  return discoverAllowanceSlot({
    client: args.client,
    token: args.token,
    owner: args.from,
    spender: args.spender,
    sentinel: OVERRIDE_TOKEN_AMOUNT,
    gas: args.gas,
    debug: args.debug,
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });
}

async function discoverComputedAllowanceSlot(
  args: {
    client: PublicClient;
    from: Address;
    token: Address;
    spender: Address;
    baseSlot: bigint;
    gas: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot | undefined> {
  const slot = allowanceSlotFor(args.from, args.spender, args.baseSlot);
  const allowance = await readAllowance({
    client: args.client,
    token: args.token,
    owner: args.from,
    spender: args.spender,
    stateOverride: [
      { address: args.token, stateDiff: [{ slot, value: uint256Hex(OVERRIDE_TOKEN_AMOUNT) }] },
    ],
    gas: args.gas,
    debug: args.debug,
    debugStep: "allowanceSlot.computedVerify",
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  });
  if (allowance === OVERRIDE_TOKEN_AMOUNT)
    return { token: args.token, spender: args.spender, slot };
  return discoverProbedAllowanceSlot(args);
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
  calls: readonly SimulatedCall[],
  probes: readonly AllowanceProbe[],
  checkpoints: readonly bigint[],
): DiscoveredRequirements["allowances"] {
  const allowances: DiscoveredRequirements["allowances"] = [];
  const stride = calls.length + 1;

  for (let probeIndex = 0; probeIndex < probes.length; ++probeIndex) {
    const probe = probes[probeIndex];
    if (probe === undefined) continue;

    const firstApproveIndex = firstInBatchApproveIndex(calls, probe);
    const limit = firstApproveIndex ?? calls.length;
    let amount = 0n;
    for (let callIndex = 0; callIndex < limit; ++callIndex) {
      const before = checkpoints[probeIndex * stride + callIndex] ?? 0n;
      const after = checkpoints[probeIndex * stride + callIndex + 1] ?? 0n;
      if (before > after) amount += before - after;
    }
    if (amount > 0n) allowances.push({ token: probe.token, spender: probe.spender, amount });
  }

  return allowances;
}

function firstInBatchApproveIndex(
  calls: readonly SimulatedCall[],
  probe: AllowanceProbe,
): number | undefined {
  for (let i = 0; i < calls.length; ++i) {
    const call = calls[i];
    if (call === undefined || addressKey(call.to) !== addressKey(probe.token)) continue;
    if (isApproveForSpender(call.calldata, probe.spender)) return i;
  }
  return undefined;
}

function isApproveForSpender(calldata: Hex, spender: Address): boolean {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: calldata });
    return (
      decoded.functionName === "approve" && addressKey(decoded.args[0]) === addressKey(spender)
    );
  } catch {
    return false;
  }
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
