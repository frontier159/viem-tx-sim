# AGENTS.md

One agent guide for this repo. `CLAUDE.md` is a symlink to this file. Edit only this file.

## What this is

`viem-tx-sim` is an RPC-only TypeScript library. It previews the asset changes of a transaction or an ERC-5792 batch before the user signs.
The library injects a never-deployed ghost contract at the user's address during `eth_call`. Downstream contracts then see the same `msg.sender` as the real transaction.

## Architecture

The library has one runtime dependency, `viem`, and ships as an ESM package.
Root modules expose the public API and the shared types, errors, and constants. Internal modules may import the shared root modules. Public implementation modules may import internal helpers.
`simulate()` takes explicit `balanceQueries` and sends one `eth_call` with state overrides that put the `TxSimulator` bytecode at `from`. It must not run access-list discovery.
`balanceQueries.forUser()` does wallet-style discovery: it runs `eth_createAccessList` for each call, filters the touched addresses with one simulator call, and returns native plus token queries for `from`. `balanceQueries.discoverErc20s()` returns only the filtered token list.
The simulator runs at `from`, so `address(this)` is the user address, balance reads can target any account, and calls execute with `msg.sender == from`.
Batch calls execute in sequence inside one EVM context. Later calls see the state changes of earlier calls.
A non-empty `nftQueries` makes the contract record received NFTs through flag-gated receiver hooks, an ERC-721 Enumerable walk, and best-effort `tokenURI`/`uri` capture. The flag keeps the OFF path free of storage writes.

Foundry compiles `contracts/TxSimulator.sol`.
`scripts/generate-txsim-bytecode.mjs` extracts the runtime bytecode into `src/generated/txSimulatorBytecode.ts`.
Do not hand-edit files under `src/generated/`. Regenerate them with `pnpm build:contracts`.
`dist/` is gitignored. `prepublishOnly` rebuilds it at publish time, and it ships in the published package.

`tokenOverrides.*` preparation is explicit.
The preparers find balance and allowance slots by access-list probing `balanceOf`/`allowance` calldata, then verify each slot with a sentinel state override.
The sentinel is `OVERRIDE_TOKEN_AMOUNT` (`10^45`). It is not `uint256.max` because standard ERC-20 allowance decrements must stay observable. It fits below `type(uint160).max` so it also forges Permit2's packed amount.

`tokenOverrides.estimateRequirements()` runs candidate discovery, a recon simulation, override preparation, and a forged measurement simulation, in that order.
Allowance probes land in flattened checkpoints with stride `calls.length + 1`, row-major per probe.
The estimator measures gross outflows from per-call minimum balances, not from final net deltas.
Allowance base-slot inference lives in `src/internal/slots.ts`. Non-standard layouts fall back to probing.

## Key modules

- `src/index.ts`: public barrel.
- `src/txSimulator.ts`: public interface/factory and single-pass simulate action.
- `src/types.ts`: public parameter/result/config types.
- `src/errors.ts`: typed library errors.
- `src/constants.ts`: exported simulation defaults.
- `src/internal/data.ts`: address normalization and hex/calldata helpers.
- `src/internal/rpc.ts`: RPC wrappers, debug/error normalization, block/call parameter helpers.
- `src/internal/simulator.ts`: candidate discovery, state-override simulator execution, revert decoding.
- `src/internal/queryDiscovery.ts`: wallet-style balance query discovery.
- `src/internal/probes.ts`: balance/allowance reads and access-list-plus-sentinel slot verification.
- `src/internal/slots.ts`: balance/allowance override preparation, allowance layout inference, mapping slot math.
- `src/internal/requirements.ts`: optional asset-requirement estimation over forged state.
- `src/internal/checkpoints.ts`: checkpoint-grid layout; the only TypeScript home of the probe-row stride math and balance-delta reconstruction.
- `src/internal/debugSteps.ts`: the typed debug-step vocabulary every emit site imports (tests pin the names as literals per ADR-0001).
- `contracts/TxSimulator.sol`: ghost contract executed only through `eth_call` state overrides.

## Style guide

- **Write types out.** Avoid `ReturnType<>`, `Parameters<>`, indexed-access types, and `as` casts. A named type that says what it is beats one derived from an implementation. Use `satisfies` to check conformance without changing a type. An internal derived type needs a comment that says why it must be derived; `WithNormalizedCalls` in `src/types.ts` is the one current exception.
- **Make illegal states unrepresentable** in interfaces and APIs. Model exclusive options as union branches, not as optional fields plus a precedence rule; `BlockOptions` is the exemplar. Where the type system cannot reach (duplicate array entries, bigint ranges), throw a typed error before any RPC.
- **No mocks in tests.** Inject test data through the same seams production code uses. Integration tests run one real Anvil node per test. Error-path tests use `test/helpers/fakeClient.ts`, a real `PublicClient` with scripted responses at the transport seam. Do not stub methods.
- **Match viem.** Reuse viem's exported types and names before you invent local ones (`Call`, `Client`, `*Parameters`). Mirror viem behavior where the library overlaps it (`getAction`, the `sendCalls` encode). Record the reason for each deliberate divergence. Current divergences: `from` (matches the `eth_call` and `wallet_sendCalls` wire format), the `"native"` asset literal (a true discriminant; viem's `0xeee…` pseudo-address is assignable anywhere an address goes), and reverts as result status (viem's `simulateCalls` also reports per-call failure as data).
- **Throw only `TxSimError` subclasses from public methods.** Wrap third-party throws at the boundary; see `normalizeCalls` in `src/txSimulator.ts`.

## Invariants tests pin

Tests pin exact RPC call counts through debug events. Do not add hidden RPC calls in a refactor.
Public `simulate()` emits zero `eth_createAccessList` calls and exactly one `txSimulator.simulate` `eth_call`. Discovery lives in the helpers.
Tests pin exact before/after/delta observations, estimated requirement amounts, and reverted-call reporting.
Checkpoint math depends on `checkpoints[probeIndex * (calls.length + 1) + callIndex]`.
`BalanceDelta.byCall` is index-aligned with calls. Entries from a failing call onward are `0n`, and `sum(byCall) === delta`.
Candidate and result order stays deterministic when RPC calls run in parallel.
Keep `OVERRIDE_TOKEN_AMOUNT` (`10^45`) below `uint256.max` so `transferFrom` allowance decreases stay observable, and below `type(uint160).max` so it also forges Permit2's packed amount.
Transaction reverts return as result status. Infrastructure failures throw typed errors. Results stay plain serializable data so they survive `postMessage`/`structuredClone` across wallet process boundaries. Do not wrap them in a class-based `Result` container.
`BlockOptions` is a mutually exclusive union that mirrors viem's `CallParameters`, with three branches: `blockNumber`, `blockTag`, and `blockHash` + `requireCanonical` (EIP-1898). Setting more than one selector is a type error. For untyped JS callers, `blockOptionsSpread` and `buildCallParameters` resolve by precedence `blockHash` > `blockNumber` > `blockTag`.
`calls` accepts viem's `Call` union, the same array `sendCalls` takes, including the `{ abi, functionName, args }` form. The `create()` bindings normalize it once to the internal `SimulatedCall` shape, typed with `WithNormalizedCalls`. Internal code sees only normalized calls.
Duplicate `tokenSlotOverrides` (same token and slot) or `nativeBalanceOverrides` (same account) throw `InvalidSimulationInputError` before any RPC. `buildStateOverride` still merges internal sources (ghost code, native balance, and token slots on one address); it validates nothing because it never sees raw user input.
`TxSimulatorConfig.client` accepts any viem `Client`. Internal `eth_call` sites route through viem's `getAction`, which prefers the client's decorated method and falls back to the tree-shakable action.

## Commands

Use Node.js 24+ with pnpm 10. `packageManager` pins pnpm to an exact version because Corepack rejects semver ranges; Dependabot moves that pin.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm verify
```

`tsc` is the TypeScript 7 native compiler, installed as per-platform binaries. It needs no extra tooling, and the tsconfig files are unchanged from 5.x.
`pnpm verify` runs the local CI gate: lint, typecheck, build, and tests.
Tests spawn one Anvil instance per test.
Use Foundry nightly. Local access-list-on-revert behavior must match production RPCs.
`pnpm test:mainnet` is opt-in and requires `MAINNET_RPC_URL`. `MAINNET_BLOCK_NUMBER` can override the pinned block.

## Releasing

Include a changeset (`pnpm changeset`) in every behavior-changing PR.
The release has two phases, both human-gated:

1. A push of changesets to `master` makes the `version-pr` job open or update the Version Packages PR.
2. A merge of that PR triggers the `publish` job under the `npm-publish` GitHub Environment. The job waits until a required reviewer approves it (Actions, run page, "Review deployments", Approve). It then runs `pnpm release` and publishes to npm with provenance through OIDC Trusted Publishing.

Ordinary master pushes never prompt. The `detect` job compares the local `package.json` version with the published one and skips `publish` on a match.
Keep the foundry nightly, node pin, and action SHA pins in `release.yml` in lockstep with `ci.yml`.
Do not enable "require review from Code Owners" while the repo has one maintainer. GitHub blocks self-approval, so the sole owner would block their own workflow changes. Enable it when a second maintainer has merge rights.
The package is pre-1.0. Minor versions may break the API until 1.0.0.

## Plans workflow

Planned work lives in `plans/`.
Read the relevant plan in full. Honor its drift checks and STOP conditions. Update the plan row in `plans/README.md` when done.
Do not change public exports, debug step names, RPC counts, or generated bytecode unless the active plan says so.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Record them as `Status:` lines in issue files. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
