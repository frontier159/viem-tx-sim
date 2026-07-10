import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { buildBalanceResults, probeRow } from "../src/internal/checkpoints.js";
import type { BalanceQuery } from "../src/types.js";

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;

const query = (asset: BalanceQuery["asset"]): BalanceQuery => ({ asset, account: ACCOUNT });

describe("probeRow", () => {
  it("reads a probe's row, row-major with stride callsLength + 1", () => {
    // two probes, 2 calls each → stride 3
    const grid = [10n, 11n, 12n, 20n, 21n, 22n];
    expect(probeRow(grid, 0, 2)).toEqual([10n, 11n, 12n]);
    expect(probeRow(grid, 1, 2)).toEqual([20n, 21n, 22n]);
  });

  it("fills missing entries with 0n", () => {
    expect(probeRow([5n], 0, 2)).toEqual([5n, 0n, 0n]);
  });
});

describe("buildBalanceResults", () => {
  it("reconstructs before/after and byCall with sum(byCall) === delta", () => {
    // 3 calls → stride 4. Single probe: 100 → 90 → 80 → 70
    const { balanceDeltas, unresolved } = buildBalanceResults(
      [query(TOKEN)],
      { balanceCheckpoints: [100n, 90n, 80n, 70n], balanceProbeOk: [true] },
      3,
    );
    expect(unresolved).toEqual([]);
    const [delta] = balanceDeltas;
    expect(delta?.before).toBe(100n);
    expect(delta?.after).toBe(70n);
    expect(delta?.delta).toBe(-30n);
    expect(delta?.byCall).toEqual([-10n, -10n, -10n]);
    expect(delta?.byCall.reduce((a, b) => a + b, 0n)).toBe(delta?.delta);
  });

  it("yields 0n byCall entries from a failing call onward (flat tail)", () => {
    // call 3 fails: grid holds flat after it → byCall[2] === 0n, sum still === delta
    const { balanceDeltas } = buildBalanceResults(
      [query(TOKEN)],
      { balanceCheckpoints: [100n, 90n, 80n, 80n], balanceProbeOk: [true] },
      3,
    );
    const [delta] = balanceDeltas;
    expect(delta?.byCall).toEqual([-10n, -10n, 0n]);
    expect(delta?.delta).toBe(-20n);
    expect(delta?.byCall.reduce((a, b) => a + b, 0n)).toBe(delta?.delta);
  });

  it("routes probes with balanceProbeOk false to unresolved", () => {
    const q0 = query(TOKEN);
    const q1 = query("native");
    const { balanceDeltas, unresolved } = buildBalanceResults(
      [q0, q1],
      { balanceCheckpoints: [1n, 2n, 5n, 5n], balanceProbeOk: [true, false] },
      1,
    );
    expect(balanceDeltas).toHaveLength(1);
    expect(balanceDeltas[0]?.asset).toBe(TOKEN);
    expect(unresolved).toEqual([q1]);
  });
});
