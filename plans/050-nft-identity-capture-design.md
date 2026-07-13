# Plan 050: Design spike — NFT tokenId/tokenURI capture (opt-in probe family)

> **Executor instructions**: This is a DESIGN plan: the deliverable is a design
> document, not code. Do not modify anything under `src/`, `contracts/`, or
> `test/`. Follow the steps, honor STOP conditions, and update the status row
> for this plan in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 3bce89e..HEAD -- contracts/TxSimulator.sol src/internal/checkpoints.ts src/types.ts`
> Material drift in these files changes the design constraints — re-read them
> before writing, and note the drift in the design doc.

## Status

- **Priority**: P3
- **Effort**: L (design only; implementation would be its own L plan)
- **Risk**: LOW (no code changes)
- **Depends on**: none (but read plan 044's outcome — probe gas budgeting interacts with metadata gas budgeting)
- **Category**: direction
- **Planned at**: commit `3bce89e`, 2026-07-12

## Why this matters

The library reports NFTs only as balance-count deltas: a wallet built on it cannot answer "*which* position NFT will I receive from this Uniswap V3/V4 mint", and post-state `tokenURI` metadata (on-chain SVGs reflecting the simulated outcome) is **unrecoverable after the eth_call returns** — capturing it inside the ghost during simulation is the only way to get it. walletchan implements the full machinery: storage-accumulating receiver hooks, ERC-721 Enumerable and `nextTokenId()` enumeration fallbacks (each capped at 50 iterations), and post-state `tokenURI`/`uri` capture under a 5M gas budget with a 500k return reserve (see `docs/walletchan-learnings-2026-07-12.md` item 7 and `docs/walletchan-comparison-2026-07-12.md` section C for the mechanics with citations).

This is additive scope, not a correctness gap (README documents token-ID ownership as unmodeled) — hence P3 and hence a design spike first: the implementation changes the contract ABI, the result shape, and the bytecode, and deserves a settled design before an implementation plan is written.

## Current state (constraints the design must honor)

- `contracts/TxSimulator.sol` — the ghost has stateless `pure` receiver hooks (lines 97-111); walletchan's capture requires them to *record* into storage/memory instead. The result struct `SimulationResult` (lines 28-38) is mirrored byte-for-byte in `src/internal/simulator.ts:60-67` (`txSimulatorAbi`) and `test/helpers/fakeClient.ts:33-43`, all guarded by `test/abi.test.ts` — any struct change touches all three.
- Pinned invariants (CLAUDE.md): public `simulate()` = exactly one `eth_call`, zero access lists; deterministic ordering; reverts as result status. An **opt-in probe family** (modeled on how `balanceQueries` became an explicit argument) keeps the default path lean and the invariants intact.
- `src/internal/checkpoints.ts` owns all checkpoint-grid math; any per-call NFT attribution must live there.
- Plan 044 (if landed) sets `PROBE_GAS_LIMIT = 150_000` for balance probes; metadata calls need a separate, larger budget (walletchan: 5M + 500k return reserve, regression-tested against a 3,000-round-keccak "heavy metadata" NFT).

## Scope

**In scope**: create `docs/design/nft-capture-design-<YYYY-MM-DD>.md` (create the `docs/design/` directory); update `plans/README.md` status row.

**Out of scope**: ALL code (`src/`, `contracts/`, `test/`), the comparison/learnings docs (read-only inputs), writing the follow-up implementation plan (the design doc *proposes* it; a human decides).

## Steps

### Step 1: Read the inputs

Read fully: `docs/walletchan-comparison-2026-07-12.md` (section C), `docs/walletchan-learnings-2026-07-12.md` (item 7), `contracts/TxSimulator.sol`, `src/internal/checkpoints.ts`, `src/types.ts`, and the walletchan contract via GitHub (https://github.com/apoorvlathey/walletchan/blob/main/apps/contracts/src/utils/TxSimulator.sol — the receiver hooks, enumeration fallbacks, and `tokenURI` capture, roughly lines 246-544) plus its Foundry tests (https://github.com/apoorvlathey/walletchan/blob/main/apps/contracts/test/TxSimulator.t.sol).

### Step 2: Write the design document

The document must answer, with a decided recommendation each (not option lists):

1. **Opt-in surface**: what the new argument looks like (e.g. `nftQueries` beside `balanceQueries`), and what the result section contains (received/sent tokenIds per collection, per-call attribution or aggregate, optional post-state `tokenURI` strings).
2. **Contract mechanics**: which of walletchan's three detection layers to adopt (receiver hooks / Enumerable walk / `nextTokenId()` walk), iteration caps, and how recording hooks interact with our stateless-hook posture. Where the data lands in `SimulationResult` (struct extension vs a parallel array) and the cost to the three-way ABI lockstep + `test/abi.test.ts`.
3. **Gas budgeting**: metadata gas budget and return-reserve numbers, interaction with `PROBE_GAS_LIMIT` (plan 044), and the hostile-metadata regression test to mirror.
4. **Attribution math**: whether tokenId capture joins the checkpoint grid (stride math in `checkpoints.ts`) or stays aggregate-only in v1, and what `byCall`-style invariants tests would pin.
5. **What we deliberately skip** vs walletchan (e.g. ERC-1155 outgoing, plain-`_mint` non-enumerable ERC-721s — their documented blind spots) with the honest limitation wording for the README.
6. **Cost accounting**: expected bytecode-size growth, extra gas per simulation when the feature is OFF (must be ~zero), and when ON.
7. **A sketch of the follow-up implementation plan**: step list, in-scope files, and the pinned-invariant review items (bytecode regen authorization, ABI guard updates, new debug steps if any).

Every claim about walletchan cites the GitHub URL + line range; every claim about this repo cites `file:line`.

### Step 3: Index

Update this plan's row in `plans/README.md` to DONE with a pointer to the design doc. Add the proposed implementation plan to the "Deferred findings" section as "awaiting maintainer decision" — do NOT create the implementation plan file.

## Done criteria

- [ ] `docs/design/nft-capture-design-<date>.md` exists and answers all 7 questions with decided recommendations and citations
- [ ] No files under `src/`, `contracts/`, or `test/` modified (`git status`)
- [ ] No changeset (docs only)
- [ ] `plans/README.md` updated (status row + deferred entry)

## STOP conditions

- Any step appears to require a code change — this plan cannot authorize one.
- The walletchan GitHub paths have moved/changed materially since `470c2767` (the pinned analysis commit) — note the commit-pinned URLs (`.../blob/470c2767/...`) and continue with those.

## Maintenance notes

- The design doc is the input to a future implementation plan; it goes stale if plans 044/047 change the contract substantially after it's written — stamp the HEAD SHA it was written against.
