import type { Hex } from "viem";
import { hexToBytes } from "viem";

/**
 * Intrinsic + calldata gas for one call: `21_000 + max(4·z + 16·nz, 10·(z + 4·nz))`, where `z`/`nz`
 * are the zero/non-zero calldata byte counts. The second term is the post-Pectra EIP-7623 floor
 * (`TOTAL_COST_FLOOR_PER_TOKEN = 10` over `tokens = z + 4·nz`); it dominates for calldata-heavy,
 * low-execution legs, so the `max` never under-estimates them. Pure and node-free — the constants live
 * here (not in Solidity) so they stay auditable and revisable without a bytecode regen.
 *
 * This is intentionally NOT the exact EIP-7623 transaction total. The spec computes the whole
 * transaction as `max(21000 + standard_calldata + execution_gas, 21000 + floor_calldata)`; here the
 * caller adds measured `executionGas` on top of `21000 + max(standard, floor)`. When the floor binds,
 * that sum is `≥` the spec total — a deliberately conservative direction for a pre-buffer suggested
 * limit, never an under-estimate.
 */
export function intrinsicAndCalldataGas(data: Hex): bigint {
  let zero = 0n;
  let nonZero = 0n;
  for (const byte of hexToBytes(data)) {
    if (byte === 0) zero += 1n;
    else nonZero += 1n;
  }
  const standard = 4n * zero + 16n * nonZero;
  const floor = 10n * (zero + 4n * nonZero);
  return 21_000n + (standard > floor ? standard : floor);
}
