import type { Address, PublicClient } from "viem";

import type { AllowanceSlot, BalanceSlot, SimulationDebug } from "./types.js";
import { OVERRIDE_TOKEN_AMOUNT } from "./internal/hex.js";
import { discoverAllowanceSlot, discoverBalanceSlot } from "./internal/probes.js";
import type { BlockOptions } from "./internal/rpc.js";

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
  const slots: BalanceSlot[] = [];

  for (const token of args.tokens) {
    const slot = await discoverBalanceSlot({
      client: args.client,
      token,
      owner: args.owner,
      sentinel: OVERRIDE_TOKEN_AMOUNT,
      gas: args.gas,
      debug: args.debug,
      ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
      ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
    });
    if (slot !== undefined) slots.push(slot);
  }

  return slots;
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
  const slots: AllowanceSlot[] = [];

  for (const pair of args.pairs) {
    const slot = await discoverAllowanceSlot({
      client: args.client,
      token: pair.token,
      owner: args.owner,
      spender: pair.spender,
      sentinel: OVERRIDE_TOKEN_AMOUNT,
      gas: args.gas,
      debug: args.debug,
      ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
      ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}),
    });
    if (slot !== undefined) slots.push(slot);
  }

  return slots;
}
