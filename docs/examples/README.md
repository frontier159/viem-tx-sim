# Examples

These examples start from the data a wallet or application already has: a viem `PublicClient`, the sender address, and one or more encoded calls.

Create a simulator once for that client:

```ts
import { TxSimulator } from "viem-tx-sim";

const simulator = TxSimulator.create({ client });
```

Before using them, confirm that your RPC endpoint supports `eth_call` with state overrides. Discovery and token-override helpers also require `eth_createAccessList`.

## Choose an example

- [Observe known balances](./known-balances.md) — the shortest `simulate()` path.
- [Discover balances](./discover-balances.md) — find the sender's touched ERC-20 balances before simulating.
- [Simulate a sequential batch](./sequential-batch.md) — preserve state between approve and use.
- [Simulate an unfunded account](./unfunded-account.md) — estimate requirements or prepare explicit state overrides.
- [Handle reverts and debug RPC activity](./reverts-and-debugging.md) — decode protocol errors and inspect helper calls.

All amounts are raw `bigint` values in the asset's own units. Examples omit metadata and price lookup because those concerns are outside this package.

[Back to the project README](../../README.md)
