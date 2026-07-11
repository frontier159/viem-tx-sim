# Observe known balances

Use explicit queries when your application already knows which assets and accounts matter. This keeps the simulation to one `eth_call` and avoids access-list discovery.

```ts
import { TxSimulator } from "viem-tx-sim";
import { createPublicClient, http } from "viem";

const client = createPublicClient({ transport: http("https://your-rpc.example") });
const simulator = TxSimulator.create({ client });

const result = await simulator.simulate({
  from,
  calls,
  balanceQueries: [
    { asset: "native", account: from },
    { asset: tokenAddress, account: from },
    { asset: tokenAddress, account: recipient },
  ],
});

for (const change of result.balanceDeltas) {
  console.log({
    asset: change.asset,
    account: change.account,
    before: change.before,
    after: change.after,
    delta: change.delta,
    byCall: change.byCall,
  });
}

if (result.unresolved.length > 0) {
  console.warn("Unreadable balance queries", result.unresolved);
}
```

`balanceDeltas` preserves the relative order of successfully read queries and includes zero changes. Failed reads are omitted and returned in `unresolved`. `byCall[i]` corresponds to `calls[i]`, and all `byCall` entries sum to `delta`.

[Back to examples](./README.md)
