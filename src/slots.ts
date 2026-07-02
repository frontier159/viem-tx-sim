import type { Address, PublicClient } from "viem";

import type { AllowanceSlot, BalanceSlot, SimulationDebug } from "./types.js";
import { OVERRIDE_TOKEN_AMOUNT } from "./internal/hex.js";
import { discoverAllowanceSlot, discoverBalanceSlot } from "./internal/probes.js";
import type { BlockOptions } from "./internal/rpc.js";
import { blockOptionsSpread } from "./internal/rpc.js";

/** Discovers balance storage slots and omits tokens whose slot cannot be verified. */
export async function discoverBalanceSlots(
  args: {
    client: PublicClient;
    owner: Address;
    tokens: readonly Address[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<BalanceSlot[]> {
  const slots = await Promise.all(
    args.tokens.map((token) =>
      discoverBalanceSlot({
        client: args.client,
        token,
        owner: args.owner,
        sentinel: OVERRIDE_TOKEN_AMOUNT,
        gas: args.gas,
        debug: args.debug,
        ...blockOptionsSpread(args),
      }),
    ),
  );
  return slots.filter((slot): slot is BalanceSlot => slot !== undefined);
}

/** Discovers allowance storage slots and omits pairs whose slot cannot be verified. */
export async function discoverAllowanceSlots(
  args: {
    client: PublicClient;
    owner: Address;
    pairs: readonly {
      token: Address;
      spender: Address;
    }[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot[]> {
  const slots = await Promise.all(
    args.pairs.map((pair) =>
      discoverAllowanceSlot({
        client: args.client,
        token: pair.token,
        owner: args.owner,
        spender: pair.spender,
        sentinel: OVERRIDE_TOKEN_AMOUNT,
        gas: args.gas,
        debug: args.debug,
        ...blockOptionsSpread(args),
      }),
    ),
  );
  return slots.filter((slot): slot is AllowanceSlot => slot !== undefined);
}
