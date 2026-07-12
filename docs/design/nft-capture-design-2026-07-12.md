# Design spike: NFT tokenId / tokenURI capture (opt-in probe family)

> **Deliverable of plan 050** (`plans/050-nft-identity-capture-design.md`). This is a
> design document, not code. It proposes a follow-up implementation plan; a human decides
> whether to schedule it.
>
> **Written against HEAD** `3af9d0e` (plan 050 was stamped at `3bce89e`).
> **walletchan** analysed at commit `470c2767`; citations use the commit-pinned GitHub
> form `https://github.com/apoorvlathey/walletchan/blob/470c2767/<path>#Lxx-Lyy`.

## Drift since the plan was stamped (`3bce89e` → `3af9d0e`)

Plans 044–049 landed in between. Two of them already changed `contracts/TxSimulator.sol`
in ways this design must treat as fact, not "if landed":

- **Plan 044 (probe gas caps) HAS landed.** `PROBE_GAS_LIMIT = 150_000` now exists and is
  applied to `_tryBalanceOf`/`_tryAllowance` via `staticcall{gas: PROBE_GAS_LIMIT}`
  (`contracts/TxSimulator.sol:12-15,260-267,278-289`). The plan text hedged "Plan 044 (if
  landed)" — it has, and this design reuses that constant for the NFT probes rather than
  introducing a second one. Note it is `150_000`, not walletchan's `100_000`.
- **Plan 047 (ERC-165) HAS landed.** `supportsInterface(bytes4)` already returns true for
  `0x01ffc9a7 / 0x150b7a02 / 0x4e2312e0` (`contracts/TxSimulator.sol:118-123`). The NFT
  work needs no ERC-165 change — the receiver interfaces are already advertised.
- **Plan 048 (Permit2 overrides) landed as TS-only** and added `PreparedPermit2Overrides` /
  `ForPermit2AllowancesArgs` to `src/types.ts:123-201`. Independent of NFT capture; noted
  only because the `SimulationResult` struct (`contracts/TxSimulator.sol:33-43`) and its
  three-way ABI lockstep are unchanged by 048, so the lockstep analysis below still holds.

`src/internal/checkpoints.ts` is byte-identical to `3bce89e` (empty diff). The checkpoint
stride math this design refers to is unchanged.

## Problem

The library reports NFTs only as `balanceOf` count deltas (`contracts/TxSimulator.sol:127-142`;
README documents token-ID ownership as unmodeled). A wallet built on it cannot answer
"*which* position NFT will I receive from this Uniswap V3 mint", and post-state `tokenURI`
metadata (on-chain SVGs that render the simulated outcome) is **unrecoverable after the
`eth_call` returns** — capturing it inside the ghost during simulation is the only way.

walletchan implements the full machinery: storage-recording receiver hooks, an ERC-721
Enumerable walk, a `nextTokenId()` counter walk, and post-state `tokenURI`/`uri` capture
under a metadata gas budget
(https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L240-L544).

This is **additive scope, not a correctness gap** (P3, no consumer request on record). The
design therefore recommends the smallest v1 that covers the flagship case, and defers the
rest behind documented limitations.

---

## 1. Opt-in surface

**Recommendation.** Add one optional argument to `SimulateArgs`:

```ts
/** ERC-721/1155 collections to watch for tokens received by `from` during simulation.
 *  Omit or pass [] to skip NFT capture entirely (zero added cost). */
nftQueries?: readonly Address[];
```

This mirrors how `balanceQueries` became an explicit list rather than in-contract discovery
(`src/types.ts:145-165`): the caller supplies the collections (typically the token
candidates already surfaced by `balanceQueries.forUser`), and the default path stays lean.
It is a plain `Address[]` — an NFT collection has no per-query account (capture always
targets `from == address(this)`), so the richer `BalanceQuery { asset, account }` shape
(`src/types.ts:14-18`) is not needed here. Discovery of *which* collections to pass belongs
in a later `nftQueries.forUser`-style helper, not in `simulate()` (out of v1 scope; see §7).

**Result section.** Add to both `SimulationSuccess` and `SimulationReverted`
(`src/types.ts:283-309`) a single field:

```ts
/** NFTs received by `from` during simulation, one entry per (collection, tokenId).
 *  Empty unless `nftQueries` was supplied. Order is deterministic (receipt order,
 *  then enumeration order). */
nftReceipts: NftReceipt[];
```

```ts
export type NftReceipt = {
  collection: Address;
  tokenId: bigint;
  amount: bigint;              // 1 for ERC-721; transferred value for ERC-1155
  standard: "erc721" | "erc1155";
  tokenUri?: string;           // decoded post-state tokenURI(id)/uri(id); absent if capture failed/off
};
```

v1 is **received-only and aggregate** (no per-call attribution, no sent NFTs) — see §4/§5
for why. `tokenUri` is captured whenever `nftQueries` is non-empty; a separate flag to
suppress metadata is unnecessary complexity for v1 (a caller who wants counts only can
ignore the field). walletchan returns `tokenUriRaw` bytes and decodes TS-side
(https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L22-L31);
we do the same — the contract returns raw ABI bytes, TS decodes the `string` (typically a
`data:application/json;base64,...` URI). Malformed/oversized metadata leaves `tokenUri`
undefined, never throws.

---

## 2. Contract mechanics

walletchan has three detection layers
(https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L155-L161):
(a) recording receiver hooks, (b) an ERC-721 Enumerable walk over `tokenOfOwnerByIndex`,
(c) a `nextTokenId()` counter walk with `ownerOf` filtering.

**Recommendation: adopt (a) + (b) in v1, defer (c).**

- **(a) Recording receiver hooks** — required. Catches safe transfers and `_safeMint`.
  Today our hooks are `pure` selector-returners (`contracts/TxSimulator.sol:102-116`);
  walletchan's push `NftReceived` into a storage array
  (https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L246-L299).
- **(b) ERC-721 Enumerable walk** — required to cover the **flagship case**. Uniswap V3's
  NonfungiblePositionManager uses plain `_mint`, not `_safeMint`, so the receiver hook never
  fires — but it *is* ERC-721 Enumerable. The walk reads `tokenOfOwnerByIndex(this, idx)`
  over `[before, after)` for collections with a positive balance delta ≤ cap
  (https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L407-L438).
  Without this layer, "which position NFT will I receive from a V3 mint" — the exact
  question the plan cites — stays unanswered. So it is in v1, not deferred.
- **(c) `nextTokenId()` walk** — **deferred.** Catches counter-based ERC-721s that are
  neither safe-minting nor Enumerable (Uniswap V4 PositionManager)
  (https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L488-L511).
  It costs an extra `nextTokenId()` snapshot array in pre-state, a per-id `ownerOf` probe
  loop, and two extra selectors. V4 is newer and lower-volume than V3; ship v1 without it,
  document V4 as a known gap (§5), and add it in a fast-follow only if a consumer hits it.

### Recording vs the stateless-hook posture

Making the hooks record is a real change to our "hooks record nothing" posture
(`contracts/TxSimulator.sol:102-116`). The tension is **cost when the feature is OFF**: if
hooks always SSTORE, a normal `simulate()` that happens to move an NFT into `from` pays for
recording nobody asked for.

**Recommendation: flag-gate recording.** `simulate()` writes a one-word capture sentinel to
a fixed storage slot at entry **only when `nftCollections.length > 0`**; the hooks read it
and early-return the selector (today's exact behavior) when it is unset. This keeps the OFF
path byte-for-byte equivalent to today — no SSTORE, hooks stay effectively pure — while ON
records into a slot-0 dynamic array (empty at the start of every `eth_call`, per the same
guarantee walletchan relies on,
https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L69-L72).
This is stricter than walletchan, which always records; the flag is worth the few extra
bytes to protect the pinned "default path stays lean" invariant.

### Where the data lands in `SimulationResult`

**Recommendation: extend the struct with one field**, not a parallel return array. Append
`NftReceipt[] nftReceipts` to `SimulationResult` (`contracts/TxSimulator.sol:33-43`). A
struct with a trailing dynamic-array field is the natural home, keeps the single-return-value
shape, and the ABI decoder tolerates it.

**Three-way ABI lockstep cost.** The struct is mirrored in exactly three places, all guarded
by `test/abi.test.ts` (which compares the hand-written `parseAbi` to the compiled artifact):

1. `contracts/TxSimulator.sol:33-43` — the Solidity struct (+ a new `NftReceipt` struct).
2. `src/internal/simulator.ts:60-67` — the `txSimulatorAbi` `parseAbi` string; add the
   `NftReceipt` struct line and the field to the `SimulationResult` line.
3. `test/helpers/fakeClient.ts:33-43` — the `SimulationResultStruct` TS type and its
   `encodeSimulationResult` default.

`test/abi.test.ts` needs no edit — it will *automatically* fail until sites 1 and 2 agree
(that is its whole job), which is the safety net for this change. TS consumers of
`SimulationResult` (checkpoints/result assembly) gain one field to thread through.

---

## 3. Gas budgeting

**Recommendation: mirror walletchan's numbers, reuse our existing probe cap.**

- **Enumeration + `ownerOf` probes** reuse the existing `PROBE_GAS_LIMIT = 150_000`
  (`contracts/TxSimulator.sol:12-15`) via `staticcall{gas: PROBE_GAS_LIMIT}` — the same
  hostile-fallback protection plan 044 already ships, no new constant. (walletchan uses
  `100_000` for the same probes,
  https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L40; our
  150k is strictly more headroom.)
- **Metadata (`tokenURI`/`uri`) capture** gets its own budget, mirroring walletchan
  (https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L41-L47,L523-L544):
  `METADATA_GAS_LIMIT = 5_000_000`, `METADATA_RETURN_GAS_RESERVE = 500_000`, per-entry
  budget `min(gasleft() - RESERVE, LIMIT)`, and **break the loop at budget 0 rather than
  revert** — a metadata renderer that burns its budget must not sink the whole simulation.
  On-chain SVG renderers are genuinely heavy, so the 5M/500k split is empirically motivated,
  not arbitrary.

**Interaction with `DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n`** (`src/constants.ts:7`):
a single 5M metadata capture fits comfortably, but a batch that already spends 10M+ plus
several heavy-metadata NFTs can approach the ceiling. Because the metadata loop degrades
gracefully (captures what it can, leaves the rest `undefined`), this is a *quality*
degradation, not a failure. Document that callers previewing heavy-metadata mints in large
batches may raise `gas`. (walletchan runs batch `eth_call` at 50M,
https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/extension/src/chrome/txSimulation.ts — we
keep our 16M default and let the caller opt up.)

**Regression test to mirror.** walletchan's `testCapturesHeavyOnchainNftMetadata` mints an
NFT whose `tokenURI` runs ~3000 keccak rounds and asserts the metadata still comes back
(https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/test/TxSimulator.t.sol#L68-L93).
The implementation plan must ship an equivalent Anvil test: a heavy-metadata NFT + a
plain-`_mint` Enumerable target, asserting the tokenId is enumerated and `tokenUri` is
non-empty. Also mirror their gas-burning-probe regression for the new probes
(https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/test/TxSimulator.t.sol#L45-L66) —
a collection whose `tokenOfOwnerByIndex`/`ownerOf` infinite-loops must not sink the sim.

---

## 4. Attribution math

**Recommendation: aggregate-only in v1. tokenId capture does NOT join the checkpoint grid.**

`src/internal/checkpoints.ts` owns the stride math
(`checkpoints[probeIndex * (calls.length + 1) + callIndex]`) for balance and allowance
grids, whose invariant is `sum(byCall) === delta` with a zero tail after a failing call
(`src/internal/checkpoints.ts:47-62`). NFT receipts do not fit that model cleanly:

- Receiver hooks fire *mid-call* in receipt order, not at call boundaries.
- The Enumerable walk runs **once, post-batch** (it reads final ownership), so it has no
  natural per-call attribution at all.

Forcing NFT capture into the grid would mean snapshotting `receivedNfts.length` at each call
boundary for the hook-driven receipts *and* inventing a per-call story for the post-batch
walk — real complexity for a P3 feature with no consumer asking for per-call NFT deltas.

**v1 invariants tests should pin instead:**

- `nftReceipts` is **empty** when `nftQueries` is omitted or `[]` (the OFF guarantee).
- `nftReceipts` is **deduped**: `(collection, tokenId)` never appears twice even when a
  collection is both `_safeMint` (hook) and Enumerable (walk) — walletchan's
  `_alreadyCaptured` linear scan
  (https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L443-L454)
  is the model; O(n²) is fine at these tiny n.
- **Deterministic order**: receipt order first, then Enumerable-walk order (ascending
  index) — same determinism bar the existing candidate/result ordering invariants hold to.
- Enumeration is capped: `MAX_ENUMERATE_PER_COLLECTION = 50` per collection, and deltas
  above the cap are skipped as "not an NFT"
  (https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L36,L416-L418).

Per-call NFT attribution is a documented **v2 option** (snapshot `receivedNfts.length` at
each `_executeCall` boundary → a parallel grid in `checkpoints.ts`), not v1.

---

## 5. What we deliberately skip vs walletchan

| Skipped in v1 | Rationale | walletchan status |
|---|---|---|
| `nextTokenId()` counter walk (Uniswap V4) | Extra pre-state array + `ownerOf` loop + 2 selectors; V4 lower-volume than V3; add on demand | Implemented (L488-L511) |
| Per-call NFT attribution | §4 — doesn't fit the checkpoint grid; no consumer demand | N/A (walletchan is aggregate-only too) |
| Outgoing / sent NFTs | Receiver hooks only see *incoming*; measuring sends needs `ownerOf`-before/after diffing per tokenId — out of scope | Blind spot (hooks are receive-only) |
| Plain-`_mint` **non-Enumerable** ERC-721 | No hook fires and no `tokenOfOwnerByIndex` to walk — undetectable without brute-forcing token ranges | walletchan's documented blind spot too |
| ERC-1155 outgoing / general ERC-1155 balances | The one-arg `balanceOf(address)` probe never matches ERC-1155's two-arg getter | Blind spot in both systems |

**Honest README limitation wording (proposed):**

> NFT capture (`nftQueries`) reports ERC-721/1155 tokens **received** by `from` during
> simulation — via receiver callbacks (safe transfers, `_safeMint`) and an ERC-721
> Enumerable walk (plain `_mint` on Enumerable collections such as Uniswap V3 positions).
> It does **not** detect: NFTs *sent* by `from`; counter-based mints that are neither safe
> nor Enumerable (e.g. Uniswap V4 positions — planned); plain-`_mint` non-Enumerable
> ERC-721s; or general ERC-1155 balances. Captured `tokenUri` reflects **post-simulation**
> state and is best-effort under a gas budget — heavy on-chain renderers may return
> undefined.

---

## 6. Cost accounting

- **Bytecode growth.** walletchan's contract is 587 lines to our 316, and the NFT machinery
  (structs, recording hooks, two walks, metadata capture, dedup) is ~300 of those lines. A
  v1 without the `nextTokenId()` walk is smaller, but still a meaningful increase — realistic
  order **+2–3 KB** of runtime bytecode. This is injected via `eth_call` state override, not
  deployed, so the 24 KB EIP-170 deploy limit does not bind; the practical cost is a larger
  `code` field in every `eth_call` request payload (a few KB, negligible on the wire).
  Must be re-measured empirically against the generated
  `src/generated/txSimulatorBytecode.ts` during implementation, not guessed at merge.
- **Gas when the feature is OFF: ~zero, by construction.** The capture sentinel is unset
  (§2), so hooks early-return exactly like today (no SSTORE), and the enumeration + metadata
  loops are gated on `nftCollections.length > 0` and never entered. The struct gains one
  empty dynamic array in the return ABI — a handful of bytes of encoding, no compute. This
  preserves the pinned "one `eth_call`, zero access lists, lean default" invariants: **no
  new RPC calls in any path**, on or off.
- **Gas when ON:** one extra `balanceOf` snapshot per collection is already covered by the
  existing candidate snapshot; incremental cost is the Enumerable walk (≤50
  `tokenOfOwnerByIndex` staticcalls per positive-delta collection, each capped at 150k) plus
  metadata capture (≤5M per received token). Bounded and caller-gas-budgeted.

---

## 7. Follow-up implementation plan (sketch — awaiting maintainer decision)

> Proposed as a single **L** plan. Depends on nothing new (044/047 already landed).
> Do **not** create the plan file from this spike — a human schedules it.

**Steps:**

1. Contract (`contracts/TxSimulator.sol`): add `NftReceipt` struct + `nftReceipts` field to
   `SimulationResult`; a 5th `address[] nftCollections` param to `simulate`; a capture
   sentinel slot set when `nftCollections.length > 0`; make the three receiver hooks record
   (flag-gated); add the ERC-721 Enumerable walk (post-batch, capped 50, deduped) and the
   post-state `tokenURI`/`uri` capture under 5M/500k. Reuse `PROBE_GAS_LIMIT` for probes.
2. Regenerate bytecode: `pnpm build:contracts` → `src/generated/txSimulatorBytecode.ts`
   (**explicitly authorized** by the plan; never hand-edited).
3. Update the three-way ABI lockstep (§2): `txSimulatorAbi` parseAbi string
   (`src/internal/simulator.ts:60-67`) + `fakeClient.ts` struct/encoder. `test/abi.test.ts`
   auto-guards — leave it, let it gate.
4. TS surface: `nftQueries?: readonly Address[]` on `SimulateArgs`; `NftReceipt` type +
   `nftReceipts` on both result variants (`src/types.ts`); thread `nftCollections` through
   `runSimulator`; decode `tokenUriRaw` → `tokenUri` string in result assembly (best-effort,
   never throws).
5. Foundry/Anvil regressions: heavy-metadata Enumerable mint (mirror walletchan
   `TxSimulator.t.sol:68-93`), safe-transfer receipt, gas-burning-probe survival (mirror
   `TxSimulator.t.sol:45-66`), OFF-path emptiness, dedup, deterministic order.
6. Docs: README Known-limitations wording from §5; CLAUDE.md architecture note; a changeset
   (behavior-changing, minor pre-1.0).

**In-scope files:** `contracts/TxSimulator.sol`, `src/generated/txSimulatorBytecode.ts`,
`src/internal/simulator.ts`, `src/types.ts`, `src/internal/*` result assembly,
`test/helpers/fakeClient.ts`, new `test/*` + `contracts/test/*` fixtures, README, CLAUDE.md,
`plans/README.md`, a `.changeset/*`.

**Pinned-invariant review items:**

- **Bytecode regeneration explicitly authorized** (`pnpm build:contracts`); generated file +
  `dist/` freshness must ship (CI gate from plan 008).
- **Three-way ABI lockstep + `test/abi.test.ts`** updated in lockstep (§2).
- **No new RPC calls** — `simulate()` stays exactly one `eth_call`, zero access lists,
  on and off. NFT capture is all in-contract; no `eth_createAccessList`, no second `eth_call`.
- **No new debug steps** — capture rides the existing `txSimulator.simulate` `eth_call`;
  the debug-step vocabulary (`src/internal/debugSteps.ts`, ADR-0001) is untouched.
- **OFF-path cost invariant** pinned by a test asserting empty `nftReceipts` and no behavior
  change when `nftQueries` is absent.
- Deterministic ordering + dedup invariants (§4) pinned.

---

## Appendix: source line references

**This repo (`3af9d0e`):** `contracts/TxSimulator.sol:12-15` (PROBE_GAS_LIMIT),
`:33-43` (SimulationResult), `:102-116` (pure hooks), `:118-123` (supportsInterface),
`:127-142` (candidate/balance snapshot), `:260-289` (capped probes);
`src/types.ts:14-18` (BalanceQuery), `:145-165` (SimulateArgs), `:283-309` (result variants);
`src/internal/simulator.ts:60-67` (txSimulatorAbi); `src/internal/checkpoints.ts:47-62`
(byCall reconstruction); `test/helpers/fakeClient.ts:33-43` (result struct);
`test/abi.test.ts` (lockstep guard); `src/constants.ts:7` (16M default gas).

**walletchan (`470c2767`,
https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol):**
L22-L31 (NftReceived struct), L36-L47 (caps: enumerate 50 / probe 100k / metadata 5M /
reserve 500k), L69-L72 (slot-0 array), L155-L161 (three capture paths overview),
L246-L299 (recording hooks), L407-L438 (Enumerable walk), L443-L454 (dedup),
L488-L511 (nextTokenId walk — deferred), L523-L544 (post-state tokenURI capture).
Tests: https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/test/TxSimulator.t.sol
L45-L66 (gas-burning probe), L68-L93 (heavy metadata).
