import { InvalidSimulationInputError } from "./errors.js";
import type { SimulateArgs, SimulatedCall, SimulationResult } from "./types.js";
import { uniqueAddresses } from "./internal/address.js";
import { discoverCandidateAddresses } from "./internal/discovery.js";
import { OVERRIDE_TOKEN_AMOUNT, uint256Hex } from "./internal/hex.js";
import { runSimulator } from "./internal/simulator.js";
import type { StorageOverride } from "./internal/stateOverride.js";

const DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n;

export async function simulate(args: SimulateArgs): Promise<SimulationResult> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("simulate requires at least one call.");
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
    ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
    ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
    gas,
    ...(args.debug !== undefined ? { debug: args.debug } : {}),
  });

  const tokenSlotOverrides = args.tokenSlotOverrides ?? [];
  const storageOverrides: StorageOverride[] = tokenSlotOverrides.map((override) => ({
    address: override.token,
    slot: override.slot,
    value: uint256Hex(override.amount ?? OVERRIDE_TOKEN_AMOUNT),
  }));

  return runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: uniqueAddresses([
      ...candidateAddresses,
      ...tokenSlotOverrides.map((slot) => slot.token),
    ]),
    storageOverrides,
    debug: args.debug,
    ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
    ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
    gas,
  });
}
