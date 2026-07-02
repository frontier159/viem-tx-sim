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

To run the opt-in mainnet RPC integration test:

```sh
MAINNET_RPC_URL=$MAINNET_RPC_URL pnpm test:mainnet
```

Set `MAINNET_BLOCK_NUMBER` to override the pinned default block.

You can also enable logging per simulation call:

```ts
import { simulate } from "viem-tx-sim";

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

V1 returns raw balance deltas only. Token metadata, token lists, indexers, centralized simulation APIs, approval UX, and price enrichment are intentionally out of scope.

Slot discovery is explicit and cacheable. Discover the slots you want to forge, then pass them into a single simulation run:

```ts
import { discoverAllowanceSlots, discoverBalanceSlots, simulate } from "viem-tx-sim";

const balanceSlots = await discoverBalanceSlots({
  client,
  owner: from,
  tokens: [token],
});
const allowanceSlots = await discoverAllowanceSlots({
  client,
  owner: from,
  pairs: [{ token, spender }],
});

const result = await simulate({
  client,
  from,
  calls: [{ to, calldata }],
  tokenSlotOverrides: [...balanceSlots, ...allowanceSlots],
});
```

`simulate()` does not retry or forge state by itself. Balance slots are reusable per token/owner, and allowance slots are reusable per token/owner/spender for the block/state you trust.

## Discovering requirements (optional)

`discoverRequirements()` measures required balances and approvals by forging generous state and observing per-call balance and allowance changes. Amounts are estimates measured under forged state; callers should pad them. Tokens that skip allowance decrements for large non-max allowances can under-report.

```ts
import { discoverRequirements, simulate } from "viem-tx-sim";

const requirements = await discoverRequirements({ client, from, calls });
// requirements.allowances -> [{ token, spender, amount }]
// requirements.balances   -> [{ token, amount }]
// requirements.slots      -> feed to simulate({ ..., tokenSlotOverrides })

const result = await simulate({
  client,
  from,
  calls,
  tokenSlotOverrides: requirements.slots,
});
```
