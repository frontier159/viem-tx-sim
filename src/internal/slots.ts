import type { Address, Hex } from "viem";
import { encodeAbiParameters, keccak256 } from "viem";

import { OVERRIDE_TOKEN_AMOUNT } from "../constants.js";
import type {
  AllowanceSlot,
  AllowanceSlotDiscovery,
  BalanceSlot,
  BalanceSlotDiscovery,
  DiscoverAllowanceSlotsArgs,
  DiscoverBalanceSlotsArgs,
} from "../types.js";
import { addressKey, uint256Hex } from "./data.js";
import { discoverAllowanceSlot, discoverBalanceSlot, readAllowance } from "./probes.js";
import type { ClientArgs, RpcCallArgs } from "./rpc.js";
import { blockOptionsSpread } from "./rpc.js";

// Orchestration
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

// Inference internals
type AllowancePair = {
  token: Address;
  spender: Address;
};

type IndexedAllowancePair = AllowancePair & {
  index: number;
};

async function discoverAllowanceSlotsWithInference(
  args: RpcCallArgs & {
    from: Address;
    pairs: readonly AllowancePair[];
    sentinel: bigint;
  },
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
  args: RpcCallArgs & {
    from: Address;
    token: Address;
    spender: Address;
    sentinel: bigint;
  },
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
  args: RpcCallArgs & {
    from: Address;
    token: Address;
    spender: Address;
    baseSlot: bigint;
    sentinel: bigint;
  },
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

// Layout math
function mappingSlot(key: Address, baseSlot: Hex | bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [key, typeof baseSlot === "bigint" ? baseSlot : BigInt(baseSlot)],
    ),
  );
}

function allowanceSlotFor(owner: Address, spender: Address, base: bigint): Hex {
  return mappingSlot(spender, mappingSlot(owner, base));
}

function inferAllowanceBaseSlot(args: {
  probedSlot: Hex;
  owner: Address;
  spender: Address;
}): bigint | undefined {
  const target = args.probedSlot.toLowerCase();
  for (let base = 0n; base <= 64n; ++base) {
    if (allowanceSlotFor(args.owner, args.spender, base).toLowerCase() === target) return base;
  }
  return undefined;
}
