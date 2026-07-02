import type { Address, Hex } from "viem";
import { getAddress } from "viem";

export function normalizeAddress(address: Address): Address {
  return getAddress(address);
}

export function addressKey(address: Address): string {
  return address.toLowerCase();
}

export function uniqueAddresses(addresses: Iterable<Address>): Address[] {
  const seen = new Map<string, Address>();
  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    seen.set(addressKey(normalized), normalized);
  }
  return [...seen.values()];
}

export const MAX_UINT256 = (1n << 256n) - 1n;

export function uint256Hex(value: bigint): Hex {
  if (value < 0n || value > MAX_UINT256) {
    throw new RangeError("Value cannot be encoded as uint256.");
  }
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

export function getCallData(result: unknown): Hex {
  if (typeof result === "string") return result as Hex;
  if (result && typeof result === "object" && "data" in result && typeof result.data === "string") {
    return result.data as Hex;
  }
  return "0x";
}
