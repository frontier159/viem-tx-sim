import type { Address, PublicClient } from "viem";

import type {
  AllowanceSlot,
  AllowanceSlotDiscovery,
  BalanceSlot,
  BalanceSlotDiscovery,
  SimulationDebug,
} from "./types.js";
import { discoverAllowanceSlotsWithInference } from "./internal/allowanceDiscovery.js";
import { OVERRIDE_TOKEN_AMOUNT } from "./internal/hex.js";
import { discoverBalanceSlot } from "./internal/probes.js";
import type { BlockOptions } from "./internal/rpc.js";
import { blockOptionsSpread } from "./internal/rpc.js";

/** @internal Implements {@link TxSimulator.discoverBalanceSlots}. Prefer the instance API from the package root. */
export async function discoverBalanceSlots(
  args: {
    client: PublicClient;
    from: Address;
    tokens: readonly Address[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<BalanceSlotDiscovery> {
  const slots = await Promise.all(
    args.tokens.map((token) =>
      discoverBalanceSlot({
        client: args.client,
        token,
        owner: args.from,
        sentinel: OVERRIDE_TOKEN_AMOUNT,
        gas: args.gas,
        debug: args.debug,
        ...blockOptionsSpread(args),
      }),
    ),
  );
  return {
    slots: slots.filter((slot): slot is BalanceSlot => slot !== undefined),
    unresolved: args.tokens.filter((_, index) => slots[index] === undefined),
  };
}

/** @internal Implements {@link TxSimulator.discoverAllowanceSlots}. Prefer the instance API from the package root. */
export async function discoverAllowanceSlots(
  args: {
    client: PublicClient;
    from: Address;
    pairs: readonly {
      token: Address;
      spender: Address;
    }[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlotDiscovery> {
  const slots = await discoverAllowanceSlotsWithInference({
    client: args.client,
    from: args.from,
    pairs: args.pairs,
    sentinel: OVERRIDE_TOKEN_AMOUNT,
    gas: args.gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
  return {
    slots: slots.filter((slot): slot is AllowanceSlot => slot !== undefined),
    unresolved: args.pairs.filter((_, index) => slots[index] === undefined),
  };
}
