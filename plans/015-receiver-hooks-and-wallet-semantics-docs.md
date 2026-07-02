# Plan 015: Add NFT receiver hooks to TxSimulator and document smart-contract-wallet simulation semantics

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8d9a02e..HEAD -- contracts/TxSimulator.sol test/simulate.test.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 014 also edits README.md —
> if it landed first, your README section simply goes alongside its changes.

## Status

- **Priority**: P2
- **Effort**: S-M
- **Risk**: LOW-MED (contract change → bytecode regeneration; additive functions only)
- **Depends on**: none (coordinate README edits with plan 014, either order)
- **Category**: bug + docs
- **Planned at**: commit `8d9a02e`, 2026-07-02

## Why this matters

Injecting `TxSimulator` at the `from` address changes how *inbound* transfers
behave. ERC-721/1155 `safeTransferFrom`/`safeMint` check
`to.code.length > 0` and, when code exists, call a receiver hook
(`onERC721Received` etc.) that must return a magic value. `TxSimulator`
implements no such hooks and has no fallback, so **any simulation in which the
`from` account receives an NFT via a safe-transfer reverts, while the real
transaction succeeds**. This bites two account types symmetrically: a real EOA
has no code (hook skipped in reality, but fired-and-reverted in simulation),
and a real Gnosis Safe has a fallback handler implementing the hooks (works in
reality, clobbered by the injected code in simulation). Implementing the three
standard hooks fixes both.

Separately, simulating smart-contract wallets (Safes) as `from` works today
for ERC-20 flows but carries assumptions nobody has written down. The
maintainer has decided these are **accepted limitations to document, not
fix**: (a) the injected `isValidSignature` replaces the wallet's own ERC-1271
validation, so flows requiring the wallet's real contract signature simulate
as reverted; (b) the wallet wrapper itself (guards, modules, threshold,
delegatecall batches, `tx.origin`) is not modeled — the wallet is treated as
a plain sender to test downstream protocol functionality. This plan writes
those down in the README.

## Current state

### The contract has no hooks and no fallback — `contracts/TxSimulator.sol` (at `8d9a02e`)

The contract's only externally callable members are `simulate(...)`,
`isValidSignature(bytes32,bytes)` (`:76-78`), and `receive()` (`:80`). Any
other selector — e.g. `onERC721Received` — hits no function and reverts
(no `fallback()` exists). Constants block for style reference (`:7-11`):

```solidity
bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
bytes4 internal constant ERC1271_INVALID_VALUE = 0xffffffff;
bytes4 internal constant BALANCE_OF_SELECTOR = 0x70a08231;
bytes4 internal constant ALLOWANCE_SELECTOR = 0xdd62ed3e;
```

### Bytecode pipeline

`pnpm build:contracts` = `forge build` + `scripts/generate-txsim-bytecode.mjs`,
which rewrites `src/generated/txSimulatorBytecode.ts` from the forge artifact.
Never hand-edit that file. `dist/` is committed; CI (plan 008, landed) fails
if committed artifacts are stale — run a full `pnpm build` so `dist/` and
`src/generated/` are regenerated and included in your changes.

### ERC-777 cannot be fixed the same way (document, don't attempt)

ERC-777 `send` to a contract requires the recipient to have a
`tokensReceived` implementer **registered in the ERC-1820 registry**
(on-chain storage lookup). Implementing `tokensReceived` on TxSimulator does
nothing without forging registry storage per recipient. Out of scope;
documented as a limitation.

### Documentation state

README.md now has a "## Known limitations" section (added 2026-07-02) that
already documents the ERC-1271 assumption, the wallet-wrapper posture,
ERC-777, and the NFT receiver-hook gap as a current limitation — Step 4 flips
that one bullet once the hooks land. No CLAUDE.md exists yet (plan 014
creates it).

### Test conventions

`test/simulate.test.ts`: per-test anvil (`startAnvil`), local
`deploy(contractFile, contractName, args)` helper, exact-value
`toContainEqual` assertions on `result.assetBalanceDeltas`. Test contracts in
`contracts/test/`, minimal style (see `Spender.sol`, `TestToken.sol`).
Useful fact for the new test: ERC-721 `balanceOf(address)` shares the ERC-20
selector `0x70a08231`, so an ERC-721 contract passes `_tryBalanceOf` and its
receipt shows up as a delta of `+1n`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Rebuild contract + bytecode + TS | `pnpm build` | exit 0 (needs `forge`) |
| Full gate | `pnpm verify` | exit 0 (lint, typecheck, build, test) |
| Focused | `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts` | all pass |

## Scope

**In scope**:

- `contracts/TxSimulator.sol` (add three hook functions only)
- `contracts/test/MockERC721.sol` (create — test fixture)
- `test/simulate.test.ts` (one new test)
- `README.md` (new section; one sentence adjusted)
- `src/generated/txSimulatorBytecode.ts` and `dist/` — **as build artifacts
  of `pnpm build` only**, never edited by hand
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `isValidSignature` and `_recover` — the ERC-1271 behavior is decided:
  document it, do not change it. No "optimistic 1271" mode in this plan.
- ERC-777 / ERC-1820 support.
- A catch-all `fallback()` — deliberately rejected: silently accepting every
  unknown selector would fake interfaces the account doesn't have and mask
  real reverts. Only the three standard hooks.
- `src/**/*.ts` source files (bytecode regeneration aside), all other tests.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the hooks to `TxSimulator.sol`

Next to `isValidSignature` (external surface area grouped together), add:

```solidity
function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
    return 0x150b7a02;
}

function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
    return 0xf23a6e61;
}

function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
    external
    pure
    returns (bytes4)
{
    return 0xbc197c81;
}
```

(The magic values are the standard selector constants:
`onERC721Received.selector`, `onERC1155Received.selector`,
`onERC1155BatchReceived.selector` — returning the literals keeps the
contract's explicit-selector style; either form is acceptable.)

**Verify**: `pnpm build` → exit 0; `git status --porcelain` shows
`src/generated/txSimulatorBytecode.ts` and `dist/` files regenerated.

### Step 2: MockERC721 fixture

Create `contracts/test/MockERC721.sol` — minimal ERC-721-shaped contract, in
the repo's fixture style (0.8.24, no OpenZeppelin):

- `mapping(uint256 => address) public ownerOf;`
  `mapping(address => uint256) public balanceOf;`
- `function safeMint(address to, uint256 id) external` — sets owner, bumps
  balance, and if `to.code.length > 0` calls
  `onERC721Received(msg.sender, address(0), id, "")` on `to`, reverting
  unless the return equals `0x150b7a02`.

That single function reproduces the exact divergence: minting to a
code-injected account fires the hook.

**Verify**: `pnpm build:contracts` → exit 0.

### Step 3: New test in `test/simulate.test.ts`

`"supports safe NFT receipt at the injected account"`:

1. `const nft = await deploy("MockERC721.sol", "MockERC721");`
2. `simulate({ client, from: ctx.account.address, calls: [{ to: nft.address, calldata: encodeFunctionData(safeMint(ctx.account.address, 1n)) }] })`
3. Expect `status === "success"` and `assetBalanceDeltas` to contain
   `{ asset: nft.address, delta: 1n }` (ERC-721 `balanceOf` shares the ERC-20
   selector, so the receipt is visible as a delta).

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts`
→ all pass including the new test. (Sanity: if you temporarily revert Step 1,
this test must FAIL with a revert — confirms it pins the fix; re-apply Step 1
after checking, or skip this sanity check if re-building twice is impractical
and say so.)

### Step 4: README — update the existing "Known limitations" section

README.md already has a "## Known limitations" section (added 2026-07-02,
after this plan was first written) that documents the ERC-1271 assumption,
the wallet-wrapper posture, ERC-777, and — as a *current limitation* — the
NFT receiver-hook revert. Do NOT add a new section. Instead:

1. Under "**The account has code during simulation.**", replace the bullet
   stating that receiving ERC-721/1155 tokens **reverts in simulation** with
   one stating it now works: the simulator implements the standard receiver
   hooks (`onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`),
   so safe transfers into the simulated account succeed, matching real
   execution for both EOAs and contract wallets.
2. Leave the ERC-777, ERC-1271, and smart-contract-wallet bullets as they
   are (they describe decided, unchanged behavior).
3. Confirm the section still reads coherently after the edit.

**Verify**: `pnpm lint` → exit 0;
`grep -n "reverts in simulation" README.md` → the NFT bullet no longer
matches (ERC-777's "reverts unless" may remain);
`grep -c "onERC721Received" README.md` → ≥1.

### Step 5: Full gate

**Verify**: `pnpm verify` → exit 0.

## Test plan

One new anvil test (Step 3) pinning the NFT-receipt fix via exact delta;
existing suite as regression (the added contract functions must not disturb
any pinned RPC counts or amounts — they're pure additions to the external
surface).

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `grep -c "onERC" contracts/TxSimulator.sol` → 3 hook functions present
- [ ] `git diff --exit-code -- dist src/generated` FAILS before commit only because artifacts were regenerated (i.e. they are updated, not stale)
- [ ] New test present and passing; deltas assertion includes the NFT `+1n`
- [ ] README's "Known limitations" NFT bullet now says receiver hooks are implemented (and no longer says NFT receipt "reverts in simulation")
- [ ] `git status --porcelain` shows changes only to in-scope files (+ regenerated artifacts)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Adding the hooks changes any existing test's behavior (pinned RPC counts or
  amounts) — pure additions must be invisible; investigate and report.
- The regenerated bytecode fails to inject (simulator tests start failing
  wholesale) — likely a build-pipeline issue; report rather than hand-editing
  `src/generated/`.
- You find yourself wanting a `fallback()` to make some other flow pass —
  that's explicitly rejected in Scope; report the flow instead.

## Maintenance notes

- If an "optimistic ERC-1271 mode" is ever requested (return magic value
  unconditionally so Safe-signed flows preview as success), it should be an
  explicit opt-in on `SimulateArgs` with a display-integrity warning — a
  deliberate follow-up, not part of this plan.
- The hook additions grow the injected bytecode slightly; nothing depends on
  its size, but the regenerated `src/generated/` + `dist/` must ship in the
  same change (CI freshness gate).
- If a future plan adds ERC-1820/ERC-777 support, it needs registry storage
  forging (state override on the registry address), not more TxSimulator
  functions.
