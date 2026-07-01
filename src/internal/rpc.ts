import type { Address, BlockTag, Hex, PublicClient } from 'viem';

import { AccessListUnsupportedError } from '../errors.js';
import type { SimulationDebug } from '../types.js';
import { withRpcDebug } from './debug.js';

export type BlockOptions = {
  blockNumber?: bigint;
  blockTag?: BlockTag;
};

export type AccessListEntry = {
  address: Address;
  storageKeys: Hex[];
};

export async function createAccessList(args: {
  client: PublicClient;
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  gas?: bigint;
  debug?: SimulationDebug;
  debugStep?: string;
} & BlockOptions): Promise<AccessListEntry[]> {
  const request = {
    account: args.from,
    to: args.to,
    data: args.data,
    value: args.value ?? 0n,
    gas: args.gas,
    blockNumber: args.blockNumber,
    blockTag: args.blockTag,
  };

  try {
    const result = await withRpcDebug<{ accessList?: AccessListEntry[] }>(
      args.debug,
      {
        method: 'eth_createAccessList',
        step: args.debugStep ?? 'createAccessList',
        details: {
          from: args.from,
          to: args.to,
          hasValue: (args.value ?? 0n) > 0n,
          hasGas: args.gas !== undefined,
        },
      },
      () => (args.client as any).createAccessList(request),
    );
    return (result?.accessList ?? []) as AccessListEntry[];
  } catch (cause) {
    if (isExecutionRevert(cause)) return [];
    throw new AccessListUnsupportedError(formatRpcError('eth_createAccessList failed', cause));
  }
}

export function formatRpcError(prefix: string, cause: unknown): string {
  if (cause instanceof Error && cause.message) return `${prefix}: ${cause.message}`;
  return prefix;
}

function isExecutionRevert(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return /execution reverted|Execution reverted/i.test(cause.message);
}
