import type { Hex } from 'viem';
import { decodeAbiParameters, hexToNumber, slice } from 'viem';

export function decodeRevertReason(data: Hex | undefined): string | undefined {
  if (!data || data === '0x') return undefined;

  try {
    const selector = slice(data, 0, 4);
    if (selector === '0x08c379a0') {
      const [reason] = decodeAbiParameters([{ type: 'string' }], slice(data, 4));
      return reason;
    }
    if (selector === '0x4e487b71') {
      return `Panic(${hexToNumber(slice(data, 4))})`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
