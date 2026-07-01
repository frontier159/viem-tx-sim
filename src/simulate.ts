import type { Address } from 'viem';

import { InvalidSimulationInputError } from './errors.js';
import type { SimulateArgs, SimulatedCall, SimulationResult } from './types.js';
import { addressKey, uniqueAddresses } from './internal/address.js';
import { withRpcDebug } from './internal/debug.js';
import { discoverCandidateAddresses } from './internal/discovery.js';
import { OVERRIDE_TOKEN_AMOUNT, uint256Hex } from './internal/hex.js';
import { discoverAllowanceSlot, discoverBalanceSlot, type AllowanceSlot, type TokenBalanceSlot } from './internal/probes.js';
import { runSimulator, type InternalSimulationResult } from './internal/simulator.js';
import type { StorageOverride } from './internal/stateOverride.js';

export async function simulate(args: SimulateArgs): Promise<SimulationResult> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError('simulate requires at least one call.');
  }

  const calls = args.calls.map((call) => ({
    to: call.to,
    calldata: call.calldata,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
  const candidateAddresses = await discoverCandidateAddresses({
    client: args.client,
    from: args.from,
    calls,
    ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
    ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
    ...(args.gas !== undefined ? { gas: args.gas } : {}),
    ...(args.debug !== undefined ? { debug: args.debug } : {}),
  });

  const base = await runWithOverrides(args, calls, candidateAddresses, []);
  if (base.status === 'success') return publicResult(base);

  const tokenCandidates = base.observedTokens;
  const balanceSlots = await discoverBalanceSlots(args, tokenCandidates);
  const balanceOverrides = balanceSlots.map((slot) => storageOverride(slot.token, slot.slot, OVERRIDE_TOKEN_AMOUNT));

  const withBalances = balanceOverrides.length > 0
    ? await runWithOverrides(args, calls, candidateAddresses, balanceOverrides)
    : base;
  if (withBalances.status === 'success') return publicResult(withBalances);

  const allowanceSlots = await discoverAllowanceSlots(args, tokenCandidates, candidateSpenders(candidateAddresses, calls, args.from, tokenCandidates));
  if (allowanceSlots.length === 0) return publicResult(withBalances);

  const highAllowanceOverrides = allowanceSlots.map((slot) => storageOverride(slot.token, slot.slot, OVERRIDE_TOKEN_AMOUNT));
  const withAllowances = await runWithOverrides(args, calls, candidateAddresses, [...balanceOverrides, ...highAllowanceOverrides]);
  if (withAllowances.status !== 'success') return publicResult(withAllowances);

  withAllowances.assetBalanceDeltas = withSpenderAttribution(
    withAllowances.assetBalanceDeltas,
    inferApprovalAttributionsFromDeltas(withAllowances, allowanceSlots),
  );
  return publicResult(withAllowances);
}

async function runWithOverrides(
  args: SimulateArgs,
  calls: readonly SimulatedCall[],
  candidateAddresses: readonly Address[],
  storageOverrides: readonly StorageOverride[],
): Promise<InternalSimulationResult> {
  return runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: candidateAddresses,
    storageOverrides,
    debug: args.debug,
    ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
    ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
    ...(args.gas !== undefined ? { gas: args.gas } : {}),
  });
}

async function discoverBalanceSlots(args: SimulateArgs, tokens: readonly Address[]): Promise<TokenBalanceSlot[]> {
  const slots: TokenBalanceSlot[] = [];
  for (const token of tokens) {
    const slot = await discoverBalanceSlot({
      client: args.client,
      token,
      owner: args.from,
      sentinel: OVERRIDE_TOKEN_AMOUNT,
      debug: args.debug,
      ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
      ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
    });
    if (slot) slots.push(slot);
  }
  return slots;
}

async function discoverAllowanceSlots(
  args: SimulateArgs,
  tokens: readonly Address[],
  spenders: readonly Address[],
): Promise<AllowanceSlot[]> {
  const slots: AllowanceSlot[] = [];
  for (const token of tokens) {
    for (const spender of spenders) {
      if (addressKey(token) === addressKey(spender)) continue;
      if (!(await hasContractCode(args, spender))) continue;
      const slot = await discoverAllowanceSlot({
        client: args.client,
        token,
        owner: args.from,
        spender,
        sentinel: OVERRIDE_TOKEN_AMOUNT,
        debug: args.debug,
        ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
        ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
      });
      if (slot) slots.push(slot);
    }
  }
  return slots;
}

async function hasContractCode(args: SimulateArgs, address: Address): Promise<boolean> {
  try {
    const code = await withRpcDebug(
      args.debug,
      {
        method: 'eth_getCode',
        step: 'spenderFilter.getCode',
        details: { address },
      },
      () => (args.client as any).getCode({
        address,
        ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
        ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
      }),
    );
    return code !== undefined && code !== '0x';
  } catch {
    return false;
  }
}

type ApprovalAttribution = {
  token: Address;
  spender: Address;
  currentAllowance: bigint;
};

function inferApprovalAttributionsFromDeltas(
  result: InternalSimulationResult,
  allowanceSlots: readonly AllowanceSlot[],
): ApprovalAttribution[] {
  const attributions: ApprovalAttribution[] = [];

  for (const delta of result.assetBalanceDeltas) {
    const asset = delta.asset;
    if (asset === 'native' || delta.delta >= 0n) continue;

    const outflow = -delta.delta;
    const matches = allowanceSlots.filter(
      (slot) => addressKey(slot.token) === addressKey(asset) && slot.currentAllowance < outflow,
    );
    if (matches.length === 1) {
      attributions.push({
        token: matches[0]!.token,
        spender: matches[0]!.spender,
        currentAllowance: matches[0]!.currentAllowance,
      });
    }
  }

  return attributions;
}

function withSpenderAttribution(
  deltas: readonly SimulationResult['assetBalanceDeltas'][number][],
  attributions: readonly ApprovalAttribution[],
): SimulationResult['assetBalanceDeltas'] {
  const attributionsByToken = new Map<string, ApprovalAttribution[]>();
  for (const attribution of attributions) {
    const key = addressKey(attribution.token);
    attributionsByToken.set(key, [...(attributionsByToken.get(key) ?? []), attribution]);
  }

  return deltas.map((delta) => {
    if (delta.asset === 'native' || delta.delta >= 0n) return delta;

    const tokenAttributions = attributionsByToken.get(addressKey(delta.asset));
    if (tokenAttributions?.length !== 1) return delta;

    return {
      ...delta,
      spender: tokenAttributions[0]!.spender,
      currentAllowance: tokenAttributions[0]!.currentAllowance,
    };
  });
}

function candidateSpenders(
  candidateAddresses: readonly Address[],
  calls: readonly SimulatedCall[],
  from: Address,
  tokens: readonly Address[],
): Address[] {
  const tokenKeys = new Set(tokens.map(addressKey));
  return uniqueAddresses([...calls.map((call) => call.to), ...candidateAddresses]).filter((address) => {
    const key = addressKey(address);
    return key !== addressKey(from) && !tokenKeys.has(key);
  });
}

function storageOverride(address: Address, slot: string, amount: bigint): StorageOverride {
  return {
    address,
    slot: slot as `0x${string}`,
    value: uint256Hex(amount),
  };
}

function publicResult(result: InternalSimulationResult): SimulationResult {
  const { observedTokens, ...rest } = result;
  void observedTokens;
  return rest;
}
