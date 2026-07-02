# viem-tx-sim

RPC-only transaction simulation helpers for [viem](https://viem.sh) applications: preview the asset changes of a transaction (or an ERC-5792 batch) before anyone signs it, using nothing but standard JSON-RPC.

## Motivation

Credit to [apoorv X thread](https://x.com/apoorveth/status/2041544070481449266)
Transcribed in [motivation.md](./docs/motivation.md)

Every wallet shows "asset changes" before you sign. Most do it by sending your calldata to a centralized simulation API — a single point of failure and a privacy leak. viem-tx-sim makes the EVM do the work itself:

1. `eth_createAccessList` dry-runs each call and returns every contract the transaction touches — those become candidate tokens, with no token lists or indexers.
2. One `eth_call` with state overrides injects a never-deployed `TxSimulator` contract **at the user's own address** and executes the calls. Because the simulator runs as the user, `address(this)` and `msg.sender` are the real account, so balance reads, allowance checks, and `msg.sender`-gated logic behave exactly as they would in the real transaction. Batch calls run sequentially in one EVM context, so an approval in call 1 is visible to a swap in call 2.

Two RPC calls for a single-call transaction (one access list per call plus one `eth_call` for a batch), zero servers, zero trust assumptions. See [docs/motivation.md](./docs/motivation.md) for the design's origin story, including how Permit2's ERC-1271 path and proxy-token storage are handled.

## Getting started

```sh
pnpm add viem-tx-sim viem
```

Simulate depositing 1,000 USDS into the sUSDS ERC-4626 vault on mainnet — an approve followed by a deposit, as one atomic batch:

```ts
import { createPublicClient, encodeFunctionData, http, parseAbi, parseUnits } from "viem";
import { mainnet } from "viem/chains";
import { simulate } from "viem-tx-sim";

const USDS = "0xdC035D45d973E3EC169d2276DDab16f1e407384F";
const SUSDS = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD";

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });

const user = "0xYourAddress"; // no key or signing involved — any address can be simulated
const assets = parseUnits("1000", 18);

const result = await simulate({
  client,
  from: user,
  calls: [
    {
      to: USDS,
      calldata: encodeFunctionData({
        abi: parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]),
        functionName: "approve",
        args: [SUSDS, assets],
      }),
    },
    {
      to: SUSDS,
      calldata: encodeFunctionData({
        abi: parseAbi(["function deposit(uint256 assets, address receiver) returns (uint256 shares)"]),
        functionName: "deposit",
        args: [assets, user],
      }),
    },
  ],
});

console.log(result.status); // "success"
console.log(result.assetBalanceDeltas);
// [
//   { asset: "0xdC03...384F", delta: -1000000000000000000000n }, // 1,000 USDS out
//   { asset: "0xa393...7fbD", delta: 9xx...n },                  // sUSDS shares in
// ]
```

Deltas are raw `bigint` amounts in each token's own units, discovered from chain state alone. A revert is returned as `status: "reverted"` with the revert data, never thrown.

`simulate()` runs against the account's real balances and does not retry or forge state by itself. If `user` doesn't actually hold 1,000 USDS (say you're previewing for a view-only address), forge the balance explicitly with a slot override — see the next section.

## Forging balances and allowances

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

Balance slots are reusable per token/owner, and allowance slots are reusable per token/owner/spender for the block/state you trust.

## Discovering requirements (optional)

When you don't already know which balances and approvals a transaction needs, `discoverRequirements()` measures them by forging generous state and observing per-call balance and allowance changes. Amounts are estimates measured under forged state and should be padded; pairs whose allowance is set inside the batch (approve or permit) are excluded, and measured allowance decreases are sanity-bounded by the token's gross outflow.

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

## Debugging

Enable logging per simulation call:

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

## Known limitations

Situations the simulation does not cover, or where the preview can differ from real execution. None of these throw — they show up as wrong or missing deltas, or as a simulated revert where the real transaction would succeed (or vice versa).

**The account has code during simulation.** Injecting `TxSimulator` at `from` is the core trick, and it is visible on-chain logic:

- Contracts that gate on "is the caller an EOA" via `extcodesize(msg.sender) == 0` see a contract during simulation and may take a different branch than the real transaction.
- Receiving ERC-721/1155 tokens via `safeTransferFrom`/`safeMint` succeeds: `TxSimulator` implements `onERC721Received`, `onERC1155Received`, and `onERC1155BatchReceived`, so safe transfers into the simulated account match real execution for EOAs and contract wallets.
- ERC-777 `send` to the simulated account reverts unless the account has a real ERC-1820 registration on-chain.
- Permit2-style signature checks are handled for EOAs: the injected `isValidSignature` performs the same ECDSA recovery the real `ecrecover` path would.

**Smart-contract wallets (e.g. a Gnosis Safe) are treated as plain senders.** Using a Safe as `from` works: the code override replaces the wallet's bytecode but keeps its storage, ETH, and token balances, and every call executes with `msg.sender` = the wallet. What is *not* modeled is the wallet itself:

- The injected `isValidSignature` **replaces the wallet's own ERC-1271 validation** and only accepts EOA-style signatures recovering to `from`. Flows that require the wallet's real contract-signature logic (Permit2 permits or orders signed by the Safe itself) simulate as reverted. This is intentional — the goal is simulating downstream protocol behavior, not the wallet's signing machinery.
- Guards, modules, owner thresholds, nonces, and `operation=DELEGATECALL` batches are outside the simulation. A transaction guard that would block the real execution is invisible to the preview.
- `tx.origin` is the `from` address during simulation; in real execution it is the submitting EOA.

**An adversarial contract can detect it is being simulated** — via the code at `from`, the recognizable forged balances, or `eth_call` context — and behave differently in the real transaction. This is inherent to state-override simulation (centralized simulation APIs share it). Treat the preview as best-effort insight, not a security guarantee against malicious contracts.

**Results are estimates against one block's state.** Deltas and discovered requirements reflect the chosen block; prices, liquidity, and allowances move before the real transaction lands. Pad amounts accordingly. Amounts from `discoverRequirements()` are additionally measured under forged (very large) balances, so contracts that branch on the account's real balance can be measured on the wrong branch.

**Asset coverage is native + `balanceOf(address)`.** Deltas track ETH and anything answering ERC-20-style `balanceOf` (an ERC-721 shows up as a count delta, without token IDs). ERC-1155 balances (`balanceOf(address,uint256)`) are not tracked. Tokens whose balance is computed rather than stored in one slot per holder (rebasing/share-based tokens like stETH) cannot be forged — slot discovery verifies before overriding and omits them.

**Candidate discovery follows the dry run.** Token candidates come from `eth_createAccessList` on the *unforged* calls; if that dry run reverts early, contracts that would only be touched later are not discovered, and their deltas are missed. Forging (or `discoverRequirements()`, which measures after forging) avoids most of this.

**RPC provider requirements.** The provider must support `eth_createAccessList` (including returning the access list for reverting calls) and `eth_call` with state overrides. Missing support surfaces as `AccessListUnsupportedError` / `StateOverrideUnsupportedError`.

**Not a gas estimator.** The simulation runs under a generous gas budget (16M default) and the injected code changes gas accounting; use `eth_estimateGas` on the real transaction for gas.

## Development

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

Building and testing requires [Foundry](https://getfoundry.sh) (`forge` compiles `TxSimulator.sol`, `anvil` backs the test suite):

```sh
pnpm build
pnpm test
```

Run `pnpm verify` to execute the full local gate that CI runs: lint, typecheck, build, and tests.

To see every RPC call the simulator makes during tests:

```sh
pnpm test:debug
```

To run the opt-in mainnet RPC integration test:

```sh
MAINNET_RPC_URL=$MAINNET_RPC_URL pnpm test:mainnet
```

Set `MAINNET_BLOCK_NUMBER` to override the pinned default block.

## Scope

V1 returns raw balance deltas only. Token metadata, token lists, indexers, centralized simulation APIs, approval UX, and price enrichment are intentionally out of scope.
