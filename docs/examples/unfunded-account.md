# Simulate an unfunded account

Use state overrides for view-only accounts or paths that require hypothetical balances and allowances.

## Estimate unknown requirements

```ts
const requirements = await simulator.tokenOverrides.estimateRequirements({
  from,
  calls,
});

console.log(requirements.native);
console.log(requirements.balances);
console.log(requirements.allowances);
console.log(requirements.unresolved);
```

The estimator discovers candidates, performs a reconnaissance simulation, prepares verified storage overrides, and measures gross outflows under forged state. Treat returned amounts as estimates and add application-appropriate padding.

## Prepare known token state

```ts
const [balances, allowances] = await Promise.all([
  simulator.tokenOverrides.forBalances({ from, tokens: [token] }),
  simulator.tokenOverrides.forAllowances({
    from,
    pairs: [{ token, spender }],
  }),
]);

if (balances.unresolved.length || allowances.unresolved.length) {
  console.warn("Some token storage layouts could not be verified");
}

const result = await simulator.simulate({
  from,
  calls,
  balanceQueries,
  tokenSlotOverrides: [...balances.slots, ...allowances.slots],
});
```

Use `nativeBalanceOverrides` for native currency. It can target `from` or another account and requires no slot discovery:

```ts
const result = await simulator.simulate({
  from,
  calls,
  balanceQueries: [{ asset: "native", account: from }],
  nativeBalanceOverrides: [{ account: from, amount: 10n ** 20n }],
});
```

An override becomes the observed `before` value. Query every forged balance whose change you want to display.

[Back to examples](./README.md)
