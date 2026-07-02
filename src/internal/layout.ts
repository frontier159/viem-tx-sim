import type { Address, Hex } from "viem";
import { encodeAbiParameters, keccak256 } from "viem";

export function mappingSlot(key: Address, baseSlot: Hex | bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [key, typeof baseSlot === "bigint" ? baseSlot : BigInt(baseSlot)],
    ),
  );
}

export function allowanceSlotFor(owner: Address, spender: Address, base: bigint): Hex {
  return mappingSlot(spender, mappingSlot(owner, base));
}

export function inferAllowanceBaseSlot(args: {
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
