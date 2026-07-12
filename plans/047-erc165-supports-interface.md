# Plan 047: Advertise ERC-165 receiver support on the ghost contract

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3bce89e..HEAD -- contracts/TxSimulator.sol src/generated/txSimulatorBytecode.ts test/simulate.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Exception: plan 044's expected edits
> (PROBE_GAS_LIMIT constant + gas-capped staticcalls) are anticipated drift —
> proceed if that is the only contract difference.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW-MED (bytecode regeneration)
- **Depends on**: execute AFTER plan 044 (both edit `contracts/TxSimulator.sol`)
- **Category**: bug
- **Planned at**: commit `3bce89e`, 2026-07-12

**This plan explicitly authorizes regenerating `src/generated/txSimulatorBytecode.ts` via `pnpm build:contracts`.** It adds a contract function but does NOT touch the hand-written `txSimulatorAbi` (`src/internal/simulator.ts:60-67`): the drift guard in `test/abi.test.ts` is one-directional (it checks that every *declared* function matches the artifact, not that every artifact function is declared), so an added contract function needs no TS-side ABI entry.

## Why this matters

On the real chain the user's EOA has no code, so senders skip receiver checks entirely. During simulation, `from` *has* code (the injected ghost), so a marketplace or router that probes `IERC165.supportsInterface` before `safeTransferFrom` hits the ghost's lack of a fallback and reverts — a false "simulated revert" for a transaction that succeeds on-chain. The library already accepted this class of fix when plan 015 added the receiver hooks themselves (`onERC721Received` etc.); ERC-165 is the same argument one selector wider, and walletchan ships it (see `docs/walletchan-learnings-2026-07-12.md` item 4). The no-`fallback()` posture stays: this is one explicit selector, not interface-faking.

## Current state

- `contracts/TxSimulator.sol:97-113` — the receiver hooks and `receive()`, with no `supportsInterface` and (deliberately) no `fallback()`:

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

receive() external payable {}
```

- Any call to an undeclared selector (like `supportsInterface(bytes4)` = `0x01ffc9a7`) currently reverts because there is no fallback.
- Interface ids to advertise: `0x01ffc9a7` (ERC-165 itself), `0x150b7a02` (ERC721TokenReceiver — the single-function interface id equals the function selector), `0x4e2312e0` (ERC1155TokenReceiver = `onERC1155Received.selector ^ onERC1155BatchReceived.selector`). Per ERC-165, `supportsInterface(0xffffffff)` MUST return false.
- Fixtures live in `contracts/test/`, deployed from vitest via `deploy(ctx, "<File>.sol", "<Name>", [...])` (`test/helpers/contracts.ts`); anvil simulation tests live in `test/simulate.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Rebuild contract + bytecode | `pnpm build:contracts` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | all pass |
| Full gate | `pnpm verify` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `contracts/TxSimulator.sol`
- `contracts/test/Erc165Gate.sol` (create)
- `src/generated/txSimulatorBytecode.ts` (regenerated only)
- `test/simulate.test.ts` (one new test)
- `.changeset/<new-file>.md` (create)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `src/internal/simulator.ts` (`txSimulatorAbi`) — see the note in Status; adding the function there would only widen the drift-guard surface for a function TypeScript never calls.
- A `fallback()` on the ghost — explicitly rejected posture (unknown selectors must keep reverting so simulation stays honest).
- ERC-1271-adjacent detection ids — no observed flow probes them; deferred until one is found.

## Git workflow

- Branch: `advisor/047-erc165-supports-interface`
- Message style: `fix: advertise ERC-165 receiver interfaces on the ghost contract`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add supportsInterface

In `contracts/TxSimulator.sol`, immediately after `onERC1155BatchReceived` and before `receive()`, add:

```solidity
/// ERC-165: advertise exactly the receiver interfaces this ghost implements, so senders that
/// pre-check supportsInterface before safeTransferFrom don't false-revert during simulation
/// (a real EOA has no code, so on-chain these checks are skipped entirely).
function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    return interfaceId == 0x01ffc9a7 || interfaceId == 0x150b7a02 || interfaceId == 0x4e2312e0;
}
```

**Verify**: `pnpm build:contracts` → exit 0; `git diff --stat src/generated/txSimulatorBytecode.ts` shows the regeneration.

### Step 2: Create the gate fixture

Create `contracts/test/Erc165Gate.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// Mimics a marketplace/router that pre-checks receiver support before a safe transfer.
contract Erc165Gate {
    error ReceiverCheckFailed();

    function requireReceiver(address account) external view {
        IERC165 target = IERC165(account);
        if (!target.supportsInterface(0x01ffc9a7)) revert ReceiverCheckFailed();
        if (!target.supportsInterface(0x150b7a02)) revert ReceiverCheckFailed();
        if (!target.supportsInterface(0x4e2312e0)) revert ReceiverCheckFailed();
        if (target.supportsInterface(0xffffffff)) revert ReceiverCheckFailed();
    }
}
```

**Verify**: `pnpm build:contracts` → exit 0.

### Step 3: Regression test

In `test/simulate.test.ts`, add a test modeled on the existing anvil cases:

1. Deploy `Erc165Gate`.
2. `sim.simulate({ from, calls: [{ to: gate, data: encodeFunctionData(requireReceiver(from)) }], balanceQueries: [{ asset: "native", account: from }] })`.
3. Assert `status === "success"`.

To prove the regression: with the Step 1 edit temporarily reverted (and `pnpm build:contracts` re-run), this test must report `status === "reverted"` (the ghost has no `supportsInterface`, the gate's staticcall reverts). Re-apply Step 1 and regenerate afterwards.

**Verify**: `pnpm test -- test/simulate.test.ts` → all pass with the fix; documented `reverted` observed without it.

### Step 4: Changeset and index

Patch changeset (`.changeset/erc165-receiver-support.md`):

```markdown
---
"viem-tx-sim": patch
---

The ghost contract now answers ERC-165 `supportsInterface` for the ERC-721/ERC-1155 receiver interfaces it implements, so safe-transfer flows that pre-check receiver support no longer false-revert during simulation.
```

Update this plan's row in `plans/README.md`.

**Verify**: `pnpm verify` → exit 0.

## Test plan

- New test: ERC-165-gated flow succeeds against the ghost (Step 3), proven to revert pre-fix, including the mandatory-false `0xffffffff` case via the fixture.
- Entire existing suite green unchanged (`test/abi.test.ts` in particular — it must not require a `supportsInterface` entry in `txSimulatorAbi`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "supportsInterface" contracts/TxSimulator.sol` → 1 function; `grep -n "supportsInterface" src/internal/simulator.ts` → no matches
- [ ] `src/generated/txSimulatorBytecode.ts` regenerated (in the diff)
- [ ] `pnpm verify` exits 0
- [ ] New test exists and passes; no existing test modified
- [ ] Patch changeset present
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The contract no longer matches "Current state" beyond plan 044's expected edits.
- `test/abi.test.ts` fails after Step 1 — that means the drift guard is not one-directional as this plan asserts; reconcile before touching `txSimulatorAbi`.
- The pre-fix check in Step 3 does not revert (the test isn't exercising the gate).

## Maintenance notes

- If a future plan adds more receiver-shaped functions to the ghost, extend `supportsInterface` in the same commit — a hook without its ERC-165 bit recreates this bug for pre-checking senders.
- The selector list is deliberately closed. Resist adding ids "to be safe": advertising an interface the ghost doesn't implement flips the failure mode from false-revert to false-success.
- Plans 044 and 047 both regenerate bytecode; if released together they share one Version Packages cycle harmlessly (both patch).
