import type { Address, Hex } from "viem";
import { decodeFunctionData, parseAbi } from "viem";

import { InvalidSimulationInputError } from "../errors.js";
import type {
  AllowanceSlotPair,
  EstimatedAssetRequirements,
  EstimateAssetRequirementsArgs,
  PreparedPermit2Overrides,
  RequiredAllowance,
  SimulatedCall,
} from "../types.js";
import { OVERRIDE_TOKEN_AMOUNT } from "../constants.js";
import { probeRow } from "./checkpoints.js";
import {
  CANONICAL_PERMIT2,
  prepareAllowanceOverrides,
  prepareBalanceOverrides,
  preparePermit2Overrides,
} from "./slots.js";
import { addressKey, normalizeAddress, uniqueAddresses } from "./data.js";
import type { ClientArgs } from "./rpc.js";
import { blockOptionsSpread, isInsufficientFunds } from "./rpc.js";
import { discoverCandidateAddresses, runSimulator } from "./simulator.js";

const allowanceSettingAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

// Permit2 in-batch grant detection. `PermitBatch`/`permitTransferFrom` variants are out of scope, so
// a batch that grants via those is not detected here and its requirement may be over-reported.
const permit2GrantAbi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }",
  "struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }",
  "function permit(address owner, PermitSingle permitSingle, bytes signature)",
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
      accessListGas: args.accessListGas,
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

  // Permit2 measurement engages only when the resolved singleton is actually touched by the batch;
  // otherwise the prepare below is skipped entirely (zero extra RPC) and the probes stay empty, which
  // the ghost contract treats as a no-op — byte-identical to a Permit2-free estimate.
  const permit2Address = normalizeAddress(args.permit2Address ?? CANONICAL_PERMIT2);
  const permit2Involved = [...candidateAddresses, ...calls.map((call) => call.to)].some(
    (address) => addressKey(address) === addressKey(permit2Address),
  );
  const permit2Pairs = permit2Involved
    ? allowancePairs(
        tokens,
        spenders.filter((spender) => addressKey(spender) !== addressKey(permit2Address)),
      )
    : [];

  const emptyPermit2: PreparedPermit2Overrides = { slots: [], pairs: [], unresolved: [] };
  const [balanceOverrides, allowanceOverrides, permit2Overrides] = await Promise.all([
    prepareBalanceOverrides({
      client: args.client,
      from: args.from,
      tokens,
      gas: args.gas,
      accessListGas: args.accessListGas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    }),
    prepareAllowanceOverrides({
      client: args.client,
      from: args.from,
      pairs: allowancePairs(tokens, spenders),
      gas: args.gas,
      accessListGas: args.accessListGas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    }),
    permit2Involved
      ? preparePermit2Overrides({
          client: args.client,
          from: args.from,
          pairs: permit2Pairs,
          permit2Address,
          gas: args.gas,
          debug: args.debug,
          ...blockOptionsSpread(args),
        })
      : Promise.resolve(emptyPermit2),
  ]);
  const balanceSlots = balanceOverrides.slots;
  const allowanceSlots = allowanceOverrides.slots;
  const allowanceProbes = allowanceSlots.map((slot) => ({
    token: slot.token,
    spender: slot.spender,
  }));
  const permit2Probes = permit2Overrides.pairs.map((pair) => ({
    token: pair.token,
    spender: pair.spender,
  }));
  const tokenSlotOverrides = [...balanceSlots, ...allowanceSlots, ...permit2Overrides.slots];
  const measurement = await runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: candidateAddresses,
    tokenSlotOverrides,
    extraStateOverrides: [{ address: args.from, balance: OVERRIDE_TOKEN_AMOUNT }],
    allowanceProbes,
    permit2: permit2Address,
    permit2Probes,
    gas: args.gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
    ...(args.errorAbi !== undefined ? { errorAbi: args.errorAbi } : {}),
  });
  const candidates = measurement.probeData.candidates;
  const maxTokenOutflows = measurement.probeData.maxTokenOutflows;
  const measuredAllowances = measureAllowanceRow(
    allowanceProbes,
    measurement.probeData.allowanceCheckpoints,
    calls.length,
    candidates,
    maxTokenOutflows,
    (probe) => firstInBatchAllowanceSetIndex(calls, args.from, probe),
  );
  const measuredPermit2 = measureAllowanceRow(
    permit2Probes,
    measurement.probeData.permit2Checkpoints,
    calls.length,
    candidates,
    maxTokenOutflows,
    (probe) => firstInBatchPermit2GrantIndex(calls, args.from, permit2Address, probe),
  );

  const shared = {
    native: measurement.probeData.maxNativeOutflow,
    balances: requiredBalances(candidates, tokens, maxTokenOutflows),
    allowances: measuredAllowances.allowances,
    permit2Allowances: measuredPermit2.allowances,
    slots: tokenSlotOverrides,
    unresolved: {
      balanceSlots: balanceOverrides.unresolved,
      allowanceSlots: allowanceOverrides.unresolved,
      allowances: measuredAllowances.discarded,
      permit2Slots: permit2Overrides.unresolved,
      permit2Allowances: measuredPermit2.discarded,
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

// Shared by ERC-20 and Permit2 allowance measurement: sum per-call decreases up to the first
// in-batch grant, then clamp against the pair's gross token outflow. Only the grant-index resolver
// differs between the two (ERC-20 approve/permit on the token vs. Permit2 approve/permit on the
// singleton), so it is injected.
function measureAllowanceRow(
  probes: readonly AllowanceProbe[],
  checkpoints: readonly bigint[],
  callsLength: number,
  candidates: readonly Address[],
  maxTokenOutflows: readonly bigint[],
  grantIndexFor: (probe: AllowanceProbe) => number | undefined,
): {
  allowances: RequiredAllowance[];
  discarded: AllowanceSlotPair[];
} {
  const allowances: RequiredAllowance[] = [];
  const discarded: AllowanceSlotPair[] = [];

  for (let probeIndex = 0; probeIndex < probes.length; ++probeIndex) {
    const probe = probes[probeIndex];
    if (probe === undefined) continue;

    const row = probeRow(checkpoints, probeIndex, callsLength);
    const limit = grantIndexFor(probe) ?? callsLength;
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

// The analog of firstInBatchAllowanceSetIndex, but the grant target is the Permit2 singleton, not
// the token, and the grant is a Permit2 `approve`/`permit` (not the ERC-20 one).
function firstInBatchPermit2GrantIndex(
  calls: readonly SimulatedCall[],
  owner: Address,
  permit2: Address,
  probe: AllowanceProbe,
): number | undefined {
  for (let i = 0; i < calls.length; ++i) {
    const call = calls[i];
    if (call === undefined || addressKey(call.to) !== addressKey(permit2)) continue;
    if (isPermit2GrantForPair(call.data, owner, probe)) return i;
  }
  return undefined;
}

function isPermit2GrantForPair(data: Hex, owner: Address, probe: AllowanceProbe): boolean {
  try {
    const decoded = decodeFunctionData({ abi: permit2GrantAbi, data });
    if (decoded.functionName === "approve") {
      return (
        addressKey(decoded.args[0]) === addressKey(probe.token) &&
        addressKey(decoded.args[1]) === addressKey(probe.spender)
      );
    }
    const [permitOwner, permitSingle] = decoded.args;
    return (
      addressKey(permitOwner) === addressKey(owner) &&
      addressKey(permitSingle.details.token) === addressKey(probe.token) &&
      addressKey(permitSingle.spender) === addressKey(probe.spender)
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
