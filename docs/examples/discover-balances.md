# Discover balances

Use `balanceQueries.forUser()` when the application does not know which ERC-20 contracts a call may touch.

```ts
const balanceQueries = await simulator.balanceQueries.forUser({
  from,
  calls,
});

const result = await simulator.simulate({
  from,
  calls,
  balanceQueries,
});
```

`forUser()` returns the sender's native balance plus touched contracts that answer `balanceOf(from)`. It does not add recipient or protocol accounts. Append those queries yourself when they matter:

```ts
balanceQueries.push({ asset: tokenAddress, account: recipient });
```

If you need only token addresses, call:

```ts
const tokens = await simulator.balanceQueries.discoverErc20s({ from, calls });
```

Discovery uses `eth_createAccessList` for each call and a filtering simulation. If a dry run reverts before touching a token, that token may be absent. Prefer explicit queries when the assets are known.

[Back to examples](./README.md)
