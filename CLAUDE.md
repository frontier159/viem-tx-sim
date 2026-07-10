# CLAUDE.md

## What this is

`viem-tx-sim` is an RPC-only TypeScript library for previewing transaction and ERC-5792 batch asset changes before signing.
Its core trick is injecting a never-deployed ghost contract at the user's own address during `eth_call`, so downstream contracts see the same `msg.sender` as the real transaction would.

## Architecture

The library uses `viem` as its only runtime dependency and ships as an ESM package.
Root modules expose the public API and shared types/errors/constants; internal modules may import those shared root modules, while public implementation modules may import internal helpers.
`simulate()` takes explicit `balanceQueries` and performs one `eth_call` with state overrides that place `TxSimulator` bytecode at `from`; it must not run access-list discovery.
`balanceQueries.forUser()` is the wallet-style discovery helper: it runs `eth_createAccessList` for each call, filters touched addresses with one simulator call, then returns native + token queries for `from`; `balanceQueries.discoverErc20s()` exposes just the filtered token list.
Because the simulator runs at `from`, `address(this)` is the user address, queried token balance reads can target any account, and calls execute with `msg.sender == from`.
Batch calls execute sequentially inside one EVM context, so state changes from earlier calls are visible to later calls.

Foundry compiles `contracts/TxSimulator.sol`.
`scripts/generate-txsim-bytecode.mjs` extracts the runtime bytecode and writes `src/generated/txSimulatorBytecode.ts`.
Never hand-edit files under `src/generated/`; regenerate them with `pnpm build:contracts`.
`dist/` is committed and is part of the published package output.

`tokenOverrides.*` preparation is explicit.
Balance and allowance overrides are prepared by access-list probing `balanceOf` / `allowance` data, then verifying a sentinel state override.
The sentinel is `OVERRIDE_TOKEN_AMOUNT` (`10^50`), deliberately not `uint256.max`, because allowance decrements must still fire for standard ERC-20 implementations.

`tokenOverrides.estimateRequirements()` runs access-list candidate discovery, a recon simulation, prepares balance and allowance overrides, then runs a forged measurement simulation.
Allowance probes are recorded as flattened checkpoints with stride `calls.length + 1`, row-major per probe.
Gross token/native outflows are measured from per-call minimum balances, not final net deltas.
Allowance base-slot inference lives in `src/internal/slots.ts`; non-standard layouts fall back to probing.

## Key modules

- `src/index.ts`: public barrel.
- `src/txSimulator.ts`: public interface/factory and single-pass simulate action.
- `src/types.ts`: public argument/result/config types.
- `src/errors.ts`: typed library errors.
- `src/constants.ts`: exported simulation defaults.
- `src/internal/data.ts`: address normalization and hex/calldata helpers.
- `src/internal/rpc.ts`: RPC wrappers, debug/error normalization, block/call parameter helpers.
- `src/internal/simulator.ts`: candidate discovery, state-override simulator execution, revert decoding.
- `src/internal/queryDiscovery.ts`: wallet-style balance query discovery.
- `src/internal/probes.ts`: balance/allowance reads and access-list-plus-sentinel slot verification.
- `src/internal/slots.ts`: balance/allowance override preparation, allowance layout inference, mapping slot math.
- `src/internal/requirements.ts`: optional asset-requirement estimation over forged state.
- `contracts/TxSimulator.sol`: ghost contract executed only through `eth_call` state overrides.

## Invariants tests pin

Tests pin exact RPC call counts through debug events; refactors must not add hidden RPC calls.
Public `simulate()` emits zero `eth_createAccessList` calls and exactly one `txSimulator.simulate` `eth_call`; discovery lives in helpers.
Tests pin exact balance before/after/delta observations, estimated requirement amounts, and reverted-call reporting.
Checkpoint math for allowance and balance probes depends on `checkpoints[probeIndex * (calls.length + 1) + callIndex]`.
`BalanceDelta.byCall` is index-aligned with calls, entries from a failing call onward are 0n, and `sum(byCall) === delta`.
Candidate/result ordering must stay deterministic even when RPC calls are parallelized.
The `10^50` sentinel must remain non-max so `transferFrom` allowance decreases are observable.
Transaction reverts are returned as result status; infrastructure failures throw typed errors.

## Commands

Use Node.js 20+ with pnpm 10.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm verify
```

`pnpm verify` runs the local CI gate: lint, typecheck, build, and tests.
Tests spawn one Anvil instance per test.
Foundry nightly is expected because local access-list-on-revert behavior must match production RPCs.
`pnpm test:mainnet` is opt-in and requires `MAINNET_RPC_URL`; `MAINNET_BLOCK_NUMBER` can override the pinned block.

## Releasing

Every behavior-changing PR should include a changeset (`pnpm changeset`).
The release is two-phase and human-gated:

1. Pushing changesets to `master` makes `release.yml`'s `version-pr` job open/update the **Version Packages** bot PR.
2. Merging that PR triggers the `publish` job, which runs under the `npm-publish` GitHub Environment: it parks in **Waiting** until a required reviewer approves it (Actions → run page → "Review deployments" → Approve). On approval it runs `pnpm release` and publishes to npm with provenance through OIDC Trusted Publishing.

Ordinary (non-version) master pushes never prompt: the `detect` job compares the local `package.json` version against the published one and skips `publish` when they match.

`release.yml`'s foundry nightly, node pin, and action SHA pins stay in lockstep with `ci.yml`.

Do NOT enable branch protection's "require review from Code Owners" while the repo has a single maintainer — GitHub forbids authors approving their own PRs, so the sole owner would block their own workflow changes. Enable it the day a second maintainer has merge rights.

This package is pre-1.0, so minor versions may include breaking changes until 1.0.0.

## Plans workflow

Planned work lives in `plans/`.
Executors should read the relevant plan fully, honor drift checks and STOP conditions, then update the plan row in `plans/README.md`.
Do not change public exports, debug step names, RPC counts, or generated bytecode unless the active plan explicitly says to.
