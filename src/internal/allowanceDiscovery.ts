import type { Address, PublicClient } from "viem";

import type { AllowanceSlot, SimulationDebug } from "../types.js";
import { addressKey } from "./address.js";
import { uint256Hex } from "./hex.js";
import { allowanceSlotFor, inferAllowanceBaseSlot } from "./layout.js";
import { discoverAllowanceSlot, readAllowance } from "./probes.js";
import type { BlockOptions } from "./rpc.js";
import { blockOptionsSpread } from "./rpc.js";

type AllowancePair = {
  token: Address;
  spender: Address;
};

type IndexedAllowancePair = AllowancePair & {
  index: number;
};

export async function discoverAllowanceSlotsWithInference(
  args: {
    client: PublicClient;
    from: Address;
    pairs: readonly AllowancePair[];
    sentinel: bigint;
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<(AllowanceSlot | undefined)[]> {
  const slots: (AllowanceSlot | undefined)[] = Array.from({ length: args.pairs.length });
  const groups = groupPairsByToken(args.pairs);

  await Promise.all(
    groups.map(async (pairs) => {
      const firstPair = pairs[0];
      if (firstPair === undefined) return;

      const firstSlot = await probeAllowanceSlot({ ...args, ...firstPair });
      slots[firstPair.index] = firstSlot;
      const baseSlot =
        firstSlot === undefined
          ? undefined
          : inferAllowanceBaseSlot({
              probedSlot: firstSlot.slot,
              owner: args.from,
              spender: firstPair.spender,
            });

      await Promise.all(
        pairs.slice(1).map(async (pair) => {
          slots[pair.index] =
            baseSlot === undefined
              ? await probeAllowanceSlot({ ...args, ...pair })
              : await computeAllowanceSlot({ ...args, ...pair, baseSlot });
        }),
      );
    }),
  );

  return slots;
}

function groupPairsByToken(pairs: readonly AllowancePair[]): IndexedAllowancePair[][] {
  const groupsByToken = new Map<string, IndexedAllowancePair[]>();
  for (let index = 0; index < pairs.length; ++index) {
    const pair = pairs[index];
    if (pair === undefined) continue;
    const key = addressKey(pair.token);
    const group = groupsByToken.get(key) ?? [];
    group.push({ ...pair, index });
    groupsByToken.set(key, group);
  }
  return [...groupsByToken.values()];
}

async function probeAllowanceSlot(
  args: {
    client: PublicClient;
    from: Address;
    token: Address;
    spender: Address;
    sentinel: bigint;
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<AllowanceSlot | undefined> {
  return discoverAllowanceSlot({
    client: args.client,
    token: args.token,
    owner: args.from,
    spender: args.spender,
    sentinel: args.sentinel,
    gas: args.gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
}

async function computeAllowanceSlot(
  args: {
    client: PublicClient;
    from: Address;
    token: Address;
    spender: Address;
    baseSlot: bigint;
    sentinel: bigint;
    gas?: bigint;
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
      { address: args.token, stateDiff: [{ slot, value: uint256Hex(args.sentinel) }] },
    ],
    gas: args.gas,
    debug: args.debug,
    debugStep: "allowanceSlot.computedVerify",
    ...blockOptionsSpread(args),
  });
  if (allowance === args.sentinel) return { token: args.token, spender: args.spender, slot };
  return probeAllowanceSlot(args);
}
