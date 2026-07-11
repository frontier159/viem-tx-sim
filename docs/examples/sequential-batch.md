# Simulate a sequential batch

Pass calls in execution order. They run in one EVM context, so state written by one call is visible to the next.

```ts
const result = await simulator.simulate({
  from,
  calls: [approveCall, depositCall],
  balanceQueries: [
    { asset: assetToken, account: from },
    { asset: shareToken, account: from },
  ],
});
```

For an approve-then-deposit batch, the asset token could report:

```ts
{
  delta: -amount,
  byCall: [0n, -amount]
}
```

If a call reverts, `status` is `"reverted"`. The result keeps balance changes from the executed prefix, sets `failingCallIndex` to the zero-based failing call, and fills `byCall` with zeroes from that call onward.

This execution model matches ordered ERC-5792-style calls. It does not model wallet guards, signer thresholds, or wallet-specific `delegatecall` behavior.

[Back to examples](./README.md)
