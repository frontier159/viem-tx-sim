import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, numberToHex } from "viem";

import { OVERRIDE_PERMIT2_AMOUNT, TxSimulator } from "../src/index.js";
import { deploy, write } from "./helpers/contracts.js";
import { type AnvilTestContext, startAnvil } from "./helpers/anvil.js";

const EXPIRATION_MAX = 2 ** 48 - 1;

describe("tokenOverrides.forPermit2Allowances", () => {
  let ctx: AnvilTestContext;
  let sim: TxSimulator;

  beforeEach(async () => {
    ctx = await startAnvil();
    sim = TxSimulator.create({ client: ctx.publicClient });
  });

  afterEach(() => {
    ctx?.stop();
  });

  it("makes a Permit2-routed pull simulate under a forged internal allowance (ERC-20 approved via write)", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const permit2 = await deploy(ctx, "MockPermit2.sol", "MockPermit2");
    const from = ctx.account.address;
    const recipient = ctx.secondAccount.address;
    await write(ctx, token, "mint", [from, 1_000n]);
    // Real ERC-20 approval so Permit2 can pull; the Permit2-internal allowance is left unset.
    await write(ctx, token, "approve", [permit2.address, 1_000n]);

    const transferFrom = encodeFunctionData({
      abi: permit2.abi,
      functionName: "transferFrom",
      // ghost at `from` is msg.sender inside Permit2, i.e. the spender.
      args: [from, recipient, 500n, token.address],
    });

    // Control: without the override the internal allowance is expired/zero, so the pull reverts.
    const control = await sim.simulate({
      from,
      calls: [{ to: permit2.address, data: transferFrom }],
      balanceQueries: [{ asset: token.address, account: from }],
    });
    expect(control.status).toBe("reverted");

    const prepared = await sim.tokenOverrides.forPermit2Allowances({
      from,
      pairs: [{ token: token.address, spender: from }],
      permit2Address: permit2.address,
    });
    expect(prepared.slots).toHaveLength(1);
    expect(prepared.unresolved).toHaveLength(0);
    expect(prepared.slots[0]?.token).toBe(permit2.address);

    const result = await sim.simulate({
      from,
      calls: [{ to: permit2.address, data: transferFrom }],
      balanceQueries: [{ asset: token.address, account: from }],
      tokenSlotOverrides: prepared.slots,
    });
    expect(result.status).toBe("success");
    expect(result.balanceDeltas[0]?.delta).toBe(-500n);
  });

  it("preserves the on-chain nonce while forging amount and expiration", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const permit2 = await deploy(ctx, "MockPermit2.sol", "MockPermit2");
    const from = ctx.account.address;
    await write(ctx, permit2, "setNonce", [from, token.address, from, 7]);

    const prepared = await sim.tokenOverrides.forPermit2Allowances({
      from,
      pairs: [{ token: token.address, spender: from }],
      permit2Address: permit2.address,
    });
    const override = prepared.slots[0];
    if (override === undefined) throw new Error("expected a prepared Permit2 override");

    // Loose-`Abi` artifact means viem returns `unknown`; the getter yields (uint160, uint48, uint48).
    const [amount, expiration, nonce] = (await ctx.publicClient.readContract({
      address: permit2.address,
      abi: permit2.abi,
      functionName: "allowance",
      args: [from, token.address, from],
      stateOverride: [
        {
          address: permit2.address,
          stateDiff: [{ slot: override.slot, value: numberToHex(override.amount, { size: 32 }) }],
        },
      ],
    })) as readonly [bigint, number, number];

    expect(amount).toBe(OVERRIDE_PERMIT2_AMOUNT);
    expect(expiration).toBe(EXPIRATION_MAX);
    expect(nonce).toBe(7);
  });

  it("reports the pair as unresolved when the target has no Permit2 allowance getter", async () => {
    const token = await deploy(ctx, "TestToken.sol", "TestToken", ["Token", "TKN", 18]);
    const from = ctx.account.address;

    const prepared = await sim.tokenOverrides.forPermit2Allowances({
      from,
      pairs: [{ token: token.address, spender: from }],
      permit2Address: token.address, // TestToken has allowance(address,address), not the 3-arg getter
    });

    expect(prepared.slots).toHaveLength(0);
    expect(prepared.pairs).toHaveLength(0);
    expect(prepared.unresolved).toEqual([{ token: token.address, spender: from }]);
  });
});
