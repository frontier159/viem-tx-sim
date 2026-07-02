import type { Address, Hex, StateOverride } from "viem";

import { addressKey, normalizeAddress } from "./address.js";

/** Internal materialized form of public TokenSlotOverride: amount defaulted and hex-encoded, then converted to viem StateOverride by storageOverridesToStateDiff. */
export type StorageOverride = {
  address: Address;
  slot: Hex;
  value: Hex;
};

export type StateOverrideEntry = StateOverride[number];

type MutableStateOverrideEntry = {
  address: Address;
  code?: Hex;
  balance?: bigint;
  stateDiff?: {
    slot: Hex;
    value: Hex;
  }[];
};

export function buildStateOverride(entries: readonly StateOverrideEntry[]): StateOverride {
  const merged = new Map<string, MutableStateOverrideEntry>();

  for (const entry of entries) {
    const normalized = normalizeAddress(entry.address);
    const key = addressKey(normalized);
    const existing = merged.get(key) ?? { address: normalized, stateDiff: [] };

    if (entry.code) existing.code = entry.code;
    if (entry.balance !== undefined) existing.balance = entry.balance;
    if (entry.stateDiff) {
      const bySlot = new Map(
        (existing.stateDiff ?? []).map((item) => [item.slot.toLowerCase(), item]),
      );
      for (const diff of entry.stateDiff) bySlot.set(diff.slot.toLowerCase(), diff);
      existing.stateDiff = [...bySlot.values()];
    }

    merged.set(key, existing);
  }

  return [...merged.values()].map((entry): StateOverrideEntry => {
    if (entry.stateDiff?.length === 0) {
      return {
        address: entry.address,
        code: entry.code,
        balance: entry.balance,
      };
    }
    return entry;
  });
}

export function storageOverridesToStateDiff(overrides: readonly StorageOverride[]): StateOverride {
  const byAddress = new Map<string, MutableStateOverrideEntry>();

  for (const override of overrides) {
    const normalized = normalizeAddress(override.address);
    const key = addressKey(normalized);
    const entry = byAddress.get(key) ?? { address: normalized, stateDiff: [] };
    entry.stateDiff?.push({ slot: override.slot, value: override.value });
    byAddress.set(key, entry);
  }

  return [...byAddress.values()];
}
