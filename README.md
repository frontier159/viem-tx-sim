# viem-tx-sim

RPC-only transaction simulation helpers for viem applications.

The library uses `eth_createAccessList` for token discovery and `eth_call` state overrides to run a never-deployed `TxSimulator` contract at the user's address. See [docs/motivation.md](./docs/motivation.md) for the source thread and design motivation.

## Setup

Use Node.js 20 or newer with pnpm 10. With `proto`:

```sh
proto use pnpm 10.18.3 --pin
pnpm install
```

Or, if your Node installation has Corepack:

```sh
corepack enable
corepack prepare pnpm@10.18.3 --activate
pnpm install
```

If your version manager still selects pnpm 11 under Node 20, either switch pnpm to 10 or switch Node to 22.13+.

Run the checks:

```sh
pnpm build
pnpm test
```

To see every RPC call the simulator makes during tests:

```sh
pnpm test:debug
```

You can also enable logging per simulation call:

```ts
import { simulate } from 'viem-tx-sim';

const result = await simulate({
  client,
  from,
  calls: [{ to, calldata, value: 0n }],
  debug: true,
});
```

Or pass a callback to collect structured events:

```ts
await simulate({
  client,
  from,
  calls: [{ to, calldata }],
  debug: (event) => {
    console.debug(event.method, event.step, event.phase, event.durationMs);
  },
});
```

V1 returns raw balance deltas and allowance gaps only. Token metadata, token lists, indexers, centralized simulation APIs, and price enrichment are intentionally out of scope.

When a high-allowance retry is needed, the negative ERC-20 delta may include `spender` and `currentAllowance`; the required allowance is the absolute value of that negative delta.
