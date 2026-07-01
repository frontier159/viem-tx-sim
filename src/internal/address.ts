import type { Address } from "viem";
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
