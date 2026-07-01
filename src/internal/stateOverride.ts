import type { Address, Hex } from 'viem';

import { addressKey, normalizeAddress } from './address.js';

export type StorageOverride = {
  address: Address;
  slot: Hex;
  value: Hex;
};

export type StateOverrideEntry = {
  address: Address;
  code?: Hex;
  balance?: bigint;
  stateDiff?: {
    slot: Hex;
    value: Hex;
  }[];
};

export function buildStateOverride(entries: StateOverrideEntry[]): StateOverrideEntry[] {
  const merged = new Map<string, StateOverrideEntry>();

  for (const entry of entries) {
    const normalized = normalizeAddress(entry.address);
    const key = addressKey(normalized);
    const existing = merged.get(key) ?? { address: normalized, stateDiff: [] };

    if (entry.code) existing.code = entry.code;
    if (entry.balance !== undefined) existing.balance = entry.balance;
    if (entry.stateDiff) {
      const bySlot = new Map((existing.stateDiff ?? []).map((item) => [item.slot.toLowerCase(), item]));
      for (const diff of entry.stateDiff) bySlot.set(diff.slot.toLowerCase(), diff);
      existing.stateDiff = [...bySlot.values()];
    }

    merged.set(key, existing);
  }

  return [...merged.values()].map((entry) => {
    if (entry.stateDiff?.length === 0) {
      const { stateDiff, ...rest } = entry;
      void stateDiff;
      return rest;
    }
    return entry;
  });
}

export function storageOverridesToStateDiff(overrides: readonly StorageOverride[]): StateOverrideEntry[] {
  const byAddress = new Map<string, StateOverrideEntry>();

  for (const override of overrides) {
    const normalized = normalizeAddress(override.address);
    const key = addressKey(normalized);
    const entry = byAddress.get(key) ?? { address: normalized, stateDiff: [] };
    entry.stateDiff?.push({ slot: override.slot, value: override.value });
    byAddress.set(key, entry);
  }

  return [...byAddress.values()];
}
