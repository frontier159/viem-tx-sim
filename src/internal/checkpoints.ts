import type { BalanceDelta, BalanceQuery } from "../types.js";

/**
 * @internal Checkpoint-grid layout: the flat `uint256[]` the ghost contract returns is a grid of one
 * row per probe with `callsLength + 1` readings (before each call plus one after the last). This
 * module is the only place in TypeScript that knows the row stride.
 */

/**
 * Returns one probe's row of readings: `callsLength + 1` values, row-major per probe. Missing entries
 * read as `0n`. This is the sole home of the checkpoint stride math.
 */
export function probeRow(
  checkpoints: readonly bigint[],
  probeIndex: number,
  callsLength: number,
): bigint[] {
  const stride = callsLength + 1;
  const base = probeIndex * stride;
  return Array.from({ length: stride }, (_, i) => checkpoints[base + i] ?? 0n);
}

type BalanceResultFields = {
  balanceDeltas: BalanceDelta[];
  unresolved: BalanceQuery[];
};

/** @internal Reconstructs before/after/by-call balance deltas from the checkpoint grid. */
export function buildBalanceResults(
  queries: readonly BalanceQuery[],
  probeData: {
    balanceCheckpoints: readonly bigint[];
    balanceProbeOk: readonly boolean[];
  },
  callsLength: number,
): BalanceResultFields {
  const balanceDeltas: BalanceDelta[] = [];
  const unresolved: BalanceQuery[] = [];

  for (let i = 0; i < queries.length; ++i) {
    const query = queries[i];
    if (query === undefined) continue;
    if (probeData.balanceProbeOk[i] !== true) {
      unresolved.push(query);
      continue;
    }
    const row = probeRow(probeData.balanceCheckpoints, i, callsLength);
    const before = row[0] ?? 0n;
    const after = row[callsLength] ?? 0n;
    const byCall = Array.from(
      { length: callsLength },
      (_, callIndex) => (row[callIndex + 1] ?? 0n) - (row[callIndex] ?? 0n),
    );
    balanceDeltas.push({
      asset: query.asset,
      account: query.account,
      before,
      after,
      delta: after - before,
      byCall,
    });
  }

  return { balanceDeltas, unresolved };
}
