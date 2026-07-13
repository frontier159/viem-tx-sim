# Plan 053: NFT tokenId/tokenURI capture (implement the decided design)

> **Executor instructions**: FIRST read `docs/design/nft-capture-design-2026-07-12.md`
> in full — it is the decided design this plan implements, and its sections are
> referenced below as D§1–D§7. Do not re-litigate its decisions. Then follow this
> plan step by step, run every verification command, and honor every STOP
> condition. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d002535..HEAD -- contracts/TxSimulator.sol src/internal/simulator.ts src/types.ts src/txSimulator.ts src/internal/checkpoints.ts test/helpers/fakeClient.ts`
> **Anticipated drift**: plan 052 lands before this plan and extends `simulate`
> with two trailing params (`address permit2, AllowanceProbe[] permit2Probes`)
> and `SimulationResult` with a trailing `uint256[] permit2Checkpoints` field,
> mirrored in `txSimulatorAbi` and `fakeClient.ts`. Confirm those additions are
> present and treat them as the current base. Any OTHER divergence from the
> excerpts referenced here is a STOP condition. If 052 has NOT landed, STOP.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED-HIGH (largest contract change since 031; struct + signature + hooks-behavior change; bytecode regen)
- **Depends on**: plan 052 (same contract/ABI files; this plan's signature additions append after 052's)
- **Category**: direction
- **Planned at**: commit `d002535`, 2026-07-12 (maintainer scheduled the design's proposed follow-up on 2026-07-12)

**This plan explicitly authorizes regenerating `src/generated/txSimulatorBytecode.ts` via `pnpm build:contracts`.**

## Why this matters

See the design doc's Problem section (D-intro): the library reports NFTs only as count deltas; "which position NFT will I receive from this Uniswap V3 mint" is unanswerable, and post-state `tokenURI` metadata is unrecoverable after the `eth_call` returns. The design (D§1–§6) decided: opt-in `nftQueries` on `SimulateArgs`, received-only aggregate `nftReceipts` on both result variants, recording receiver hooks + ERC-721 Enumerable walk (the `nextTokenId()` walk deferred), flag-gated so the OFF path is behavior-identical, walletchan's 5M/500k metadata budget, `PROBE_GAS_LIMIT` reuse for probes, 50-per-collection enumeration cap, dedup, deterministic order.

## Current state

- The contract post-052: `simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes, BalanceProbe[] balanceProbes, address permit2, AllowanceProbe[] permit2Probes)`; `SimulationResult` ends with `uint256[] permit2Checkpoints`. Receiver hooks are `pure` selector-returners (pre-052 lines 102–116); `PROBE_GAS_LIMIT = 150_000` (line 15); `supportsInterface` already advertises the receiver interfaces (lines 118–123 pre-052) — no ERC-165 change needed (D-drift note). The contract currently has **zero storage variables** (constants only) — this plan introduces the first two.
- `src/internal/simulator.ts` — `txSimulatorAbi` (line 60 pre-052) and `runSimulator`; `probeData` type at lines 34–42.
- `src/types.ts` — `SimulateArgs` (146–165), `SimulationSuccess`/`SimulationReverted` (283–309).
- `src/internal/checkpoints.ts` — `buildBalanceResults`; result assembly for `runSimulate` lives in `src/txSimulator.ts:222-268`. NFT receipts do NOT join the checkpoint grid (D§4) — decode them in `runSimulator`/`runSimulate`, not here.
- `test/helpers/fakeClient.ts` — `SimulationResultStruct` + `encodeSimulationResult`.
- Fixtures available: `contracts/test/MockERC721.sol` (safe-mint receipts), `contracts/test/GasBurner.sol` (hostile), `test/simulate.test.ts` (anvil exemplars, incl. the plan-044 gas-burner tests).

## Design parameters (from the design doc — implement exactly)

- Contract struct: `struct NftReceipt { address collection; uint256 tokenId; uint256 amount; bool erc1155; bytes tokenUriRaw; }` → TS `NftReceipt = { collection: Address; tokenId: bigint; amount: bigint; standard: "erc721" | "erc1155"; tokenUri?: string }` (D§1; the contract's `erc1155` bool maps to `standard`; `tokenUriRaw` ABI-decodes to `tokenUri`, best-effort, undefined on failure).
- Storage: `NftReceipt[] private _nftReceipts;` (slot 0 — guaranteed empty per `eth_call`, D§2) and `bool private _nftCaptureEnabled;` (slot 1). `simulate` sets the flag iff `nftCollections.length > 0` (its new trailing 7th param, `address[] calldata nftCollections`); hooks check the flag and early-return today's exact selector behavior when unset (D§2 "flag-gate recording").
- Hooks record: `onERC721Received` pushes `(msg.sender, tokenId, 1, false, "")`; `onERC1155Received` pushes `(msg.sender, id, value, true, "")`; `onERC1155BatchReceived` loops. Hooks lose `pure` — they are NOT in `txSimulatorAbi`, so `test/abi.test.ts` is unaffected by the mutability change (verify this claim: grep `onERC721Received` in `src/internal/simulator.ts` → no match expected).
- Enumerable walk (D§2b): snapshot `_tryBalanceOf(collection, address(this))` per queried collection before the batch; after the batch (regardless of success — receipts and the walk describe state at the halt point, matching the balance `after` semantics), for each collection with an ok before-read and `0 < after − before ≤ 50` (`MAX_ENUMERATE_PER_COLLECTION = 50`), staticcall `tokenOfOwnerByIndex(address(this), idx)` (selector `0x2f745c59`, verify with `cast sig`) for `idx` in `[before, after)` with `{gas: PROBE_GAS_LIMIT}`; dedup against existing receipts by (collection, tokenId) via linear scan (D§4); record as erc721.
- Metadata capture (D§3): after the walk, for each receipt: `budget = gasleft() > METADATA_RETURN_GAS_RESERVE ? min(gasleft() − METADATA_RETURN_GAS_RESERVE, METADATA_GAS_LIMIT) : break`; staticcall `tokenURI(id)` (`0xc87b56dd`) for erc721 / `uri(id)` (`0x0e89341c`) for erc1155 with that budget; on success store the raw returndata in `tokenUriRaw`; never revert. Constants `METADATA_GAS_LIMIT = 5_000_000`, `METADATA_RETURN_GAS_RESERVE = 500_000`.
- Result: copy `_nftReceipts` into a new trailing `SimulationResult` field `NftReceipt[] nftReceipts`.
- TS surface (D§1): `nftQueries?: readonly Address[]` on `SimulateArgs` (JSDoc from D§1), passed as `uniqueAddresses` to the contract param; `nftReceipts: NftReceipt[]` on BOTH result variants (empty when off); `NftReceipt` exported from the barrel; TS decodes `tokenUriRaw` with `decodeAbiParameters([{ type: "string" }], raw)` in a try/catch (malformed/empty → `tokenUri` undefined).
- Ordering invariant (D§4): receipt order (hooks first, in receipt order), then walk order (per queried collection in input order, ascending index). Dedup means a hook-captured id never reappears from the walk.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Selector checks | `cast sig "tokenOfOwnerByIndex(address,uint256)"` / `"tokenURI(uint256)"` / `"uri(uint256)"` | `0x2f745c59` / `0xc87b56dd` / `0x0e89341c` (STOP on mismatch) |
| Rebuild | `pnpm build:contracts` | exit 0 |
| Gate | `pnpm verify` | exit 0 |

## Scope

**In scope**: `contracts/TxSimulator.sol`; `src/generated/txSimulatorBytecode.ts` (regenerated); `src/internal/simulator.ts`; `src/types.ts`; `src/txSimulator.ts`; `src/index.ts` (export `NftReceipt`); `test/helpers/fakeClient.ts`; `contracts/test/EnumerableMint721.sol` + `contracts/test/HeavyMetadataNft.sol` (create); `test/simulate.test.ts` (or a new `test/nft.test.ts`); README (Known-limitations wording verbatim from D§5); CLAUDE.md (one architecture sentence); `.changeset/<new>.md` (minor); `plans/README.md`.

**Out of scope** (D§5's deliberate skips — do NOT implement): the `nextTokenId()` walk; per-call NFT attribution (`src/internal/checkpoints.ts` untouched); sent-NFT detection; any NFT discovery helper (`nftQueries.forUser` etc.); new debug steps (capture rides the existing `txSimulator.simulate` call — D§7 invariant); `estimateRequirements` (no NFT awareness there).

## Git workflow

- Branch: `advisor/053-nft-identity-capture` (or master if the operator says so); message `feat: opt-in NFT tokenId/tokenURI capture (plan 053)`.
- Do NOT push unless instructed.

## Steps

### Step 1: Contract

Implement the Design parameters: structs, the two storage vars, the flag set in `simulate`, recording hooks, snapshot array for `nftCollections`, post-batch walk + dedup + metadata capture, result copy. Keep the existing checkpoint/outflow logic byte-identical. Match the contract's existing style (`_try*` helpers, forge-lint disables on low-level calls).

**Verify**: `pnpm build:contracts` → exit 0.

### Step 2: ABI lockstep

`txSimulatorAbi`: add the `NftReceipt` struct line, append `NftReceipt[] nftReceipts` to the `SimulationResult` line, append `address[] nftCollections` to the `simulate` line. `fakeClient.ts`: extend the struct type + default (`nftReceipts: []`).

**Verify**: `pnpm test -- test/abi.test.ts` → passes.

### Step 3: TS surface

`runSimulator`: accept `nftCollections?: readonly Address[]`, encode (default `[]`), surface raw receipts in `probeData`. `runSimulate` (`src/txSimulator.ts`): map `args.nftQueries` in, decode receipts (tokenUriRaw → tokenUri) into both result variants. Types + barrel export + JSDoc.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0; **full existing suite passes unchanged** (`pnpm test`) — the OFF path (no `nftQueries`) must not move a single pinned value.

### Step 4: Fixtures

Create `contracts/test/EnumerableMint721.sol` — minimal hand-rolled plain-`_mint` Enumerable ERC-721 (no OZ import): `mint(address to, uint256 n)` assigns sequential ids updating `ownerOf`/`balanceOf`/`tokenOfOwnerByIndex` arrays, **without** any receiver callback (that's the point), plus `transferFrom`. Create `contracts/test/HeavyMetadataNft.sol` — safe-minting ERC-721 whose `tokenURI` burns ~3000 keccak rounds in a loop before returning a `data:application/json;base64,...` string (mirror walletchan's regression, D§3).

**Verify**: `pnpm build:contracts` → exit 0.

### Step 5: Tests

Anvil tests (new `test/nft.test.ts`, harness modeled on `test/simulate.test.ts`):

1. **OFF path**: simulate without `nftQueries` → `nftReceipts` is `[]`; and with `nftQueries: []` → `[]`. (The D§6 zero-cost guarantee's observable half.)
2. **Safe-transfer receipt**: MockERC721 safeMint/safeTransfer into `from` with `nftQueries: [collection]` → one receipt, correct tokenId, `standard: "erc721"`, `tokenUri` defined if MockERC721 has a tokenURI (assert presence only if it does — read the fixture first).
3. **Flagship plain-mint Enumerable**: batch calls `EnumerableMint721.mint(from, 2)` → two receipts via the walk, ascending ids, no hook involved.
4. **Dedup**: a collection that safe-mints (hook fires) and is Enumerable — assert each (collection, tokenId) appears exactly once. (Extend EnumerableMint721 with a `safeMint` variant, or safeTransfer a walked token — pick the simpler and note it.)
5. **Heavy metadata**: HeavyMetadataNft mint → `tokenUri` captured non-empty.
6. **Hostile collection**: `nftQueries: [gasBurner]` alongside a real transfer → simulation succeeds, burner contributes nothing, other queries unaffected (mirror the plan-044 test shape).
7. **Revert path**: a batch whose 2nd call reverts after the 1st safe-mints → the receipt from call 1 is present, `status: "reverted"`.

**Verify**: `pnpm test -- test/nft.test.ts` → all pass.

### Step 6: Docs, changeset, index

README Known-limitations paragraph verbatim from D§5; one CLAUDE.md sentence (contract now records opt-in NFT receipts; hooks flag-gated). Minor changeset. Update the 053 row + strike the "NFT capture implementation awaiting decision" deferred entry in `plans/README.md` (it is now this plan).

**Verify**: `pnpm verify` → exit 0.

## Done criteria

- [ ] `grep -c "nftReceipts" contracts/TxSimulator.sol src/internal/simulator.ts src/types.ts test/helpers/fakeClient.ts` → ≥1 each
- [ ] All three selector checks match; bytecode regenerated in the diff
- [ ] `pnpm verify` exits 0; all 7 new tests pass; zero pre-existing test modifications
- [ ] `grep -n "nextTokenId" contracts/TxSimulator.sol` → no matches (deferred layer stayed deferred)
- [ ] README + CLAUDE.md lines present; minor changeset present
- [ ] No files outside the in-scope list modified; `plans/README.md` updated

## STOP conditions

- Plan 052 has not landed, or the contract diverges from 052's expected shape in any way beyond 052's own additions.
- Any pre-existing test fails with `nftQueries` absent (the OFF-path guarantee is broken — this is the plan's core invariant, D§6).
- `test/abi.test.ts` cannot be made green with a struct-append + signature-append (suggests parseAbi's nested-struct handling disagrees with forge's artifact — report the two ABI JSON shapes).
- The dedup or ordering assertions in tests 3/4 require nondeterministic fixes.
- Bytecode growth exceeds ~5 KB (D§6 predicted 2–3 KB; a big overshoot means something is off — report the before/after byte sizes).

## Maintenance notes

- Plan 054 appends a new external function to the same contract/ABI files — run it after this plan.
- Deferred fast-follows recorded in D§5: `nextTokenId()` walk (Uniswap V4), per-call attribution, sent NFTs. Add on demand.
- The hooks' storage write is behind `_nftCaptureEnabled`; anyone touching the hooks later must preserve that gate or the OFF-path cost guarantee dies silently — the OFF-path test (5.1) is the tripwire.
