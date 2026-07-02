import type {
  AllowanceSlot,
  AllowanceSlotDiscovery,
  BalanceSlot,
  BalanceSlotDiscovery,
  DiscoverAllowanceSlotsArgs,
  DiscoverBalanceSlotsArgs,
} from "../types.js";
import { discoverAllowanceSlotsWithInference } from "./allowanceDiscovery.js";
import { OVERRIDE_TOKEN_AMOUNT } from "./hex.js";
import { discoverBalanceSlot } from "./probes.js";
import type { ClientArgs } from "./rpc.js";
import { blockOptionsSpread } from "./rpc.js";

/** @internal Implements `TxSimulator.discoverBalanceSlots`. Prefer the instance API from the package root. */
export async function discoverBalanceSlots(
  args: DiscoverBalanceSlotsArgs & ClientArgs,
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

/** @internal Implements `TxSimulator.discoverAllowanceSlots`. Prefer the instance API from the package root. */
export async function discoverAllowanceSlots(
  args: DiscoverAllowanceSlotsArgs & ClientArgs,
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
