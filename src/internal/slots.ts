import type { Address, Hex, StateOverride } from "viem";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem";

import { OVERRIDE_PERMIT2_AMOUNT, OVERRIDE_TOKEN_AMOUNT } from "../constants.js";
import type {
  AllowanceSlotPair,
  ForPermit2AllowancesArgs,
  PreparedAllowanceOverrides,
  PreparedBalanceOverrides,
  PreparedPermit2Overrides,
  PrepareAllowanceOverridesArgs,
  PrepareBalanceOverridesArgs,
  TokenSlotOverride,
} from "../types.js";
import { addressKey, getCallData, normalizeAddress, uint256Hex } from "./data.js";
import { DEBUG_STEPS } from "./debugSteps.js";
import type { DebugStep } from "./debugSteps.js";
import { StateOverrideUnsupportedError } from "../errors.js";
import { discoverAllowanceSlot, discoverBalanceSlot, readAllowance } from "./probes.js";
import type { ClientArgs, RpcCallArgs } from "./rpc.js";
import {
  blockOptionsSpread,
  buildCallParameters,
  formatRpcError,
  isExecutionRevert,
  withRpcDebug,
} from "./rpc.js";

type SlotFact = {
  token: Address;
  slot: Hex;
};

type AllowanceSlotFact = SlotFact & {
  spender: Address;
};

// Orchestration
/** @internal Implements `TxSimulator.tokenOverrides.forBalances`. Prefer the instance API from the package root. */
export async function prepareBalanceOverrides(
  args: PrepareBalanceOverridesArgs & ClientArgs,
): Promise<PreparedBalanceOverrides> {
  const slots = await Promise.all(
    args.tokens.map((token) =>
      discoverBalanceSlot({
        client: args.client,
        token,
        owner: args.from,
        sentinel: OVERRIDE_TOKEN_AMOUNT,
        gas: args.gas,
        accessListGas: args.accessListGas,
        debug: args.debug,
        ...blockOptionsSpread(args),
      }),
    ),
  );
  return {
    slots: slots.filter(isDefined).map(withOverrideAmount),
    unresolved: args.tokens.filter((_, index) => slots[index] === undefined),
  };
}

/** @internal Implements `TxSimulator.tokenOverrides.forAllowances`. Prefer the instance API from the package root. */
export async function prepareAllowanceOverrides(
  args: PrepareAllowanceOverridesArgs & ClientArgs,
): Promise<PreparedAllowanceOverrides> {
  const slots = await prepareAllowanceOverridesWithInference({
    client: args.client,
    from: args.from,
    pairs: args.pairs,
    sentinel: OVERRIDE_TOKEN_AMOUNT,
    gas: args.gas,
    accessListGas: args.accessListGas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
  return {
    slots: slots.filter(isDefined).map(withOverrideAmount),
    unresolved: args.pairs.filter((_, index) => slots[index] === undefined),
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function withOverrideAmount<T extends SlotFact>(slot: T): T & TokenSlotOverride {
  return { ...slot, amount: OVERRIDE_TOKEN_AMOUNT };
}

// Inference internals
type AllowancePair = {
  token: Address;
  spender: Address;
};

type IndexedAllowancePair = AllowancePair & {
  index: number;
};

async function prepareAllowanceOverridesWithInference(
  args: RpcCallArgs & {
    from: Address;
    pairs: readonly AllowancePair[];
    sentinel: bigint;
  },
): Promise<(AllowanceSlotFact | undefined)[]> {
  const slots: (AllowanceSlotFact | undefined)[] = Array.from({ length: args.pairs.length });
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
): Promise<AllowanceSlotFact | undefined> {
  return discoverAllowanceSlot({
    client: args.client,
    token: args.token,
    owner: args.from,
    spender: args.spender,
    sentinel: args.sentinel,
    gas: args.gas,
    accessListGas: args.accessListGas,
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
): Promise<AllowanceSlotFact | undefined> {
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
    debugStep: DEBUG_STEPS.allowanceSlotComputedVerify,
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

// Permit2 internal allowances
/** Canonical Permit2 singleton, same address on every chain. */
export const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

/** Permit2 packs `{uint160 amount; uint48 expiration; uint48 nonce}` into one slot. */
const EXPIRATION_MAX = 2n ** 48n - 1n;

/** Base-slot search order; `1` first (canonical `AllowanceTransfer.allowance` slot). Ordered, never raced. */
const PERMIT2_BASE_SLOTS = [1n, 0n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];

const PERMIT2_ALLOWANCE_ABI = parseAbi([
  "function allowance(address, address, address) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

type Permit2Allowance = { amount: bigint; expiration: bigint; nonce: bigint };

/**
 * @internal Implements `TxSimulator.tokenOverrides.forPermit2Allowances`. Prefer the instance API
 * from the package root. Overridden slots target the Permit2 contract's storage, not the ERC-20.
 */
export async function preparePermit2Overrides(
  args: ForPermit2AllowancesArgs & ClientArgs,
): Promise<PreparedPermit2Overrides> {
  const permit2 = normalizeAddress(args.permit2Address ?? CANONICAL_PERMIT2);
  const slots: TokenSlotOverride[] = [];
  const pairs: AllowanceSlotPair[] = [];
  const unresolved: AllowanceSlotPair[] = [];
  let cachedBase: bigint | undefined;

  // Sequential: the base-slot layout is a per-contract constant, so caching the first hit lets the
  // remaining pairs skip discovery. Ordered on purpose — the verification reads are never raced.
  for (const pair of args.pairs) {
    const resolved = await resolvePermit2Slot({
      client: args.client,
      permit2,
      owner: args.from,
      token: pair.token,
      spender: pair.spender,
      cachedBase,
      gas: args.gas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    });
    if (resolved === undefined) {
      unresolved.push({ token: pair.token, spender: pair.spender });
      continue;
    }
    cachedBase = resolved.base;
    slots.push(resolved.override);
    pairs.push({ token: pair.token, spender: pair.spender });
  }

  return { slots, pairs, unresolved };
}

async function resolvePermit2Slot(
  args: RpcCallArgs & {
    permit2: Address;
    owner: Address;
    token: Address;
    spender: Address;
    cachedBase: bigint | undefined;
  },
): Promise<{ override: TokenSlotOverride; base: bigint } | undefined> {
  const current = await readPermit2Allowance({
    ...args,
    debugStep: DEBUG_STEPS.permit2AllowanceRead,
  });
  if (current === undefined) return undefined;

  // Preserve the on-chain nonce: `permit()` verifies the signed nonce against storage.
  const packed = (current.nonce << 208n) | (EXPIRATION_MAX << 160n) | OVERRIDE_PERMIT2_AMOUNT;
  const bases =
    args.cachedBase === undefined
      ? PERMIT2_BASE_SLOTS
      : [args.cachedBase, ...PERMIT2_BASE_SLOTS.filter((base) => base !== args.cachedBase)];

  for (const base of bases) {
    const slot = permit2AllowanceSlot(args.owner, args.token, args.spender, base);
    const verified = await readPermit2Allowance({
      ...args,
      stateOverride: [{ address: args.permit2, stateDiff: [{ slot, value: uint256Hex(packed) }] }],
      debugStep: DEBUG_STEPS.permit2AllowanceVerify,
    });
    if (
      verified !== undefined &&
      verified.amount === OVERRIDE_PERMIT2_AMOUNT &&
      verified.nonce === current.nonce
    ) {
      return { override: { token: args.permit2, slot, amount: packed }, base };
    }
  }
  return undefined;
}

async function readPermit2Allowance(
  args: RpcCallArgs & {
    permit2: Address;
    owner: Address;
    token: Address;
    spender: Address;
    stateOverride?: StateOverride;
    debugStep: DebugStep;
  },
): Promise<Permit2Allowance | undefined> {
  const data = encodeFunctionData({
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [args.owner, args.token, args.spender],
  });
  try {
    const result = await withRpcDebug(
      args.debug,
      {
        method: "eth_call",
        step: args.debugStep,
        details: {
          account: args.owner,
          to: args.permit2,
          stateOverrides: args.stateOverride?.length ?? 0,
        },
      },
      () =>
        args.client.call(
          buildCallParameters({
            account: args.owner,
            to: args.permit2,
            data,
            stateOverride: args.stateOverride,
            gas: args.gas,
            ...blockOptionsSpread(args),
          }),
        ),
    );
    const [amount, expiration, nonce] = decodeFunctionResult({
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: "allowance",
      data: getCallData(result),
    });
    return { amount: BigInt(amount), expiration: BigInt(expiration), nonce: BigInt(nonce) };
  } catch (cause) {
    // A reverting read is a non-Permit2 target (unresolved); anything else is infrastructure.
    if (isExecutionRevert(cause)) return undefined;
    throw new StateOverrideUnsupportedError(
      formatRpcError("eth_call during override preparation failed", cause),
    );
  }
}

function permit2AllowanceSlot(owner: Address, token: Address, spender: Address, base: bigint): Hex {
  return mappingSlot(spender, mappingSlot(token, mappingSlot(owner, base)));
}
