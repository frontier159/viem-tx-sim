# TxSimulator.sol complexity review — 2026-07-13

Adversarial comparison of `contracts/TxSimulator.sol` (HEAD `5cb897f`, 637 lines) against
walletchan's ghost contract
(https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol,
587 lines), prompted by the maintainer concern: "the solidity contract is now quite
complicated and convoluted — especially since it now requires via-ir to build."

All compile experiments ran in a scratch copy (forge 1.7.2-nightly `7debd6d`, solc 0.8.24,
optimizer 200, cancun — the repo's exact pinned settings). The repo working tree was not
modified except for this file.

---

## Verdict summary

1. **The concern is understandable but mostly misdirected.** The contract doubled (316 →
   637 lines) across plans 044–054, but every block traces to a shipped, tested,
   pinned-invariant feature. There is no speculative code and essentially no dead code.
   The growth is feature growth, not rot.

2. **The via-IR requirement is real, permanent for the current ABI, and fine to keep.**
   Empirically, the trigger is **not** the 11-field `SimulationResult` return struct (it
   compiles clean under legacy codegen in isolation) — it is `simulate()`'s **7-parameter
   input list** (6 dynamic calldata arrays + 1 address). The generated calldata *decoder*
   overflows: "Variable dataEnd is **1 slot(s)** too deep", with a trivial body, so **no
   body refactor can fix it**. The only legacy-codegen escape hatches are (a) an
   ABI-breaking parameter bundle (proven to compile — see §via-IR) or (b) cutting the NFT
   feature (052-era 6-param contract compiles legacy). Neither is worth it today: via-IR
   costs ~2.3 s for this contract (6.3 s full build with 23 test fixtures), produces
   **smaller** bytecode (7,854 B vs 10,308 B legacy for the same source), is deterministic
   under the pinned solc/foundry, and is production-mature in 2026. **Note: the
   `foundry.toml` comment misstates the cause** ("the NFT-capture return struct …
   overflows the legacy ABI encoder") — it was the input side. Fix the comment.

3. **Top 3 simplifications worth doing** (all bytecode-only or docs-only; fold into the
   next plan that already touches the contract, per the generated-bytecode discipline):
   - Correct the `foundry.toml` via-IR comment (docs-only, zero risk).
   - Consolidate the four one-word staticcall probes (`_tryBalanceOf`, `_tryAllowance`,
     `_tryPermit2Allowance`, `_tryTokenOfOwnerByIndex`) onto one shared
     `_tryStaticUint(address target, bytes memory callData, uint256 minReturn)` primitive
     (~30 lines saved, bytecode-only, regen required).
   - Revert the 052 `ExecutionState` output-fields hack: under via-IR,
     `_executeCalls` returning `(bool, uint256, bytes memory, uint256)` **compiles clean**
     (verified empirically). The four "Outputs of `_executeCalls`" struct fields and their
     copy-out in `simulate()` exist only to appease legacy codegen the repo no longer uses.
     Bytecode-only, regen required.

4. **Leave alone:** the checkpoint grids, min-balance gross-outflow tracking, fill-forward,
   halt-and-report, ERC-1271 signer binding + EIP-2098, hashed storage slots, the bounded
   metadata copy, the probe gas caps, and the separate `simulateBatchGas` loop. Each is
   either a pinned invariant or a correctness/hardening win walletchan demonstrably lacks.
   Do not pursue legacy codegen via micro-refactors — it is provably impossible for this
   signature.

---

## Empirical size/complexity data

Each historical stage compiled with identical settings (solc 0.8.24, optimizer 200,
cancun), runtime (deployed) bytecode bytes:

| Stage | Commit | Lines | via-IR bytes | Legacy bytes | Δ via-IR |
|---|---|---|---|---|---|
| Baseline (pre-044) | `3bce89e` | 316 | 4,182 | 5,810 | — |
| +044 probe gas caps | `2f948a6` | 323 | 4,188 | 5,824 | +6 |
| +047 ERC-165 | `f103793` | 330 | 4,309 | 5,996 | +121 |
| +052 Permit2 checkpoint grid | `8e5f1ce` | 410 | 5,072 | 7,035 | +763 |
| +053 NFT capture | `b3bb081` | 561 | 7,196 | **FAIL** | +2,124 |
| +054 simulateBatchGas | `85886a5` | 589 | 7,470 | **FAIL** | +274 |
| +hardening (hashed slots, bounded copy, aggregation) | `bf67815` = HEAD | 637 | 7,854 | **FAIL** | +384 |
| walletchan (0.8.26, same optimizer settings) | `470c2767` | 587 | — | 8,015 | — |
| ours, `SimulationRequest`-bundled restructure (scratch) | — | ~640 | 8,232 | 10,308 | — |

Compile times (same machine): full repo `forge build` (main contract + 23 test fixtures,
via-IR) ≈ 6.3 s; single-contract via-IR ≈ 2.3 s; single-contract legacy ≈ 0.4–0.6 s.
Since the contract is never deployed, bytecode size matters only as `eth_call` payload:
7,854 B ≈ 15.7 KB hex per request. Note **via-IR is a net win here** — the legacy build of
the same source would be ~20.6 KB on the wire. Our via-IR contract is also *smaller* than
walletchan's legacy build despite carrying strictly more machinery.

---

## Feature necessity audit

For each capability: what consumer-visible feature depends on it, cost, what deleting it
breaks, verdict.

| Capability (file:line) | Consumer feature it serves | Cost (lines / bytes) | Deleting it breaks | Verdict |
|---|---|---|---|---|
| Allowance + balance checkpoint grids, stride math, fill-forward (`TxSimulator.sol:498-550`) | `BalanceDelta.byCall` (pinned: index-aligned, zero tail, `sum === delta`); `tokenOverrides.estimateRequirements` allowance measurement | ~90 / in baseline | Two pinned invariants + the estimator | **Keep** |
| Permit2 checkpoint grid (`:510-522`, `:585-596`, struct fields) | Plan 052: Permit2 allowance requirements in `estimateRequirements` | 80 / +763 | Permit2 requirement measurement (shipped, tested) | **Keep** |
| Min-balance gross-outflow (`:453-455`, `:475-477`, `:486-496`, `:152-157`) | CLAUDE.md-pinned "gross outflows from per-call minimum balances, not net deltas" — catches spend-then-refund flows walletchan's net deltas miss (their `_computeDeltas`, https://github.com/apoorvlathey/walletchan/blob/470c2767/apps/contracts/src/utils/TxSimulator.sol#L332-L365) | ~30 / in baseline | Requirement estimation correctness for round-trip flows | **Keep** |
| Halt-and-report + `revertData` capture (`:431-451`, `:480-484`) | Pinned reverts-as-status; `failingCallIndex`/`revertSelector`/`revertReason` on results | ~25 / in baseline | The typed revert surface; would regress to walletchan's continue-past-failure (explicitly rejected posture, learnings doc) | **Keep** |
| Arbitrary-account balance probes + native-as-`address(0)` (`:561-568`) | Plan 031 `balanceQueries` — observation of any account, not just `from` | 8 / small | The public `balanceQueries` contract | **Keep** |
| ERC-1271 signer-bound + EIP-2098 (`:214-216`, `:605-636`) | Permit2 flows validate against the ghost; must mirror real EOA verification. walletchan's accepts **any** signer's well-formed sig (false-positive previews, theirs `#L565-L583`) | 35 / in baseline | Permit2-in-batch simulation correctness | **Keep** |
| ERC-165 (`:246-248`) | Senders that pre-check `supportsInterface` before `safeTransferFrom` don't false-revert (plan 047; walletchan has the same, theirs `#L551-L556`) | 6 / +121 | False reverts on defensive senders | **Keep** |
| Receiver hooks (`:218-241`) | `safeTransferFrom`/`_safeMint` into the ghost must not revert; NFT receipt recording when capture is on | ~24 / small | Any simulation that safe-transfers an NFT to `from` | **Keep** |
| Probe gas caps `PROBE_GAS_LIMIT` (`:23`, all probes) | Plan 044 hardening: hostile `balanceOf` can't OOG the whole sim (walletchan ships the same at 100k, theirs `#L40`) | 7 / +6 | Security regression with a regression test upstream | **Keep** |
| NFT capture: flag-gated hooks, hashed slots, Enumerable walk, metadata capture, bounded copy, dedup (`:25-44`, `:62-73`, `:125-133`, `:159-165`, `:252-399`) | Plan 053 `nftQueries`/`nftReceipts` (opt-in) — "which position NFT will I get from this V3 mint" + post-state on-chain SVG metadata, unrecoverable outside the ghost | ~230 / +2,508 (incl. hardening) | The shipped `nftQueries` API; **also the sole via-IR trigger** (its 7th `simulate` param) | **Keep, with a flag** — see below |
| `simulateBatchGas` (`:186-212`) | Plan 054 `gas.estimateBatch` (demand signal on record; maintainer-scheduled over the design's own hesitation) | 28 / +274 | The shipped `gas.estimateBatch` API | **Keep** |
| Hashed storage slots (`:40-44`, `:252-274`) | Correctness when `from` is a smart wallet / dirty-7702 account: real storage persists under the code-only override. Regression proven pre-fix (panic `0x41`, reconciliation log F1). walletchan records into **slot 0** (theirs `#L69-L72`) and is silently wrong for Safe-proxy users | ~25 / small | A proven crash/phantom-record bug returns | **Keep** |
| Bounded metadata copy (`:35-38`, `:377-399`) | A hostile `tokenURI` returning megabytes within its gas budget can't OOG the outer frame via Solidity's automatic returndata copy. walletchan has **no** size cap (theirs `#L530-L535`) | 23 / small | A real DoS vector on the metadata path | **Keep** |

**The one honest cut candidate is NFT capture.** It is P3, one day old, opt-in, has no
consumer on record, is the largest single block (~230 lines, ~2.5 KB, roughly a third of
the contract), and is the sole reason via-IR is required. Cutting it would return the
contract to the 052 shape (410 lines, legacy-compilable, 5,072 B). But that is a *product*
decision — the feature was designed deliberately (docs/design/nft-capture-design-2026-07-12.md),
implements the flagship "which V3 position NFT" case, hardened after adversarial review,
and post-state `tokenURI` genuinely cannot be captured any other way. This review does not
recommend cutting it; it records that the maintainer *can*, and that doing so — not
compiler heroics — is the honest path back to legacy codegen if via-IR ever becomes a
problem.

### How walletchan keeps its contract flatter (structure per feature)

- **Fewer entry-point parameters.** Their widest signature is 4 params with 2 dynamic
  arrays (`simulate`, theirs `#L86-L91`); `simulateBatch` is 2 (theirs `#L152-L155`).
  Ours is 7 with 6 dynamic arrays. That single difference is the entire via-IR story.
- **A 5-member positional return tuple** (theirs `#L93-L99`) vs our 11-field struct —
  because they return *net signed deltas computed in-contract* and nothing else: no
  checkpoint grids, no gross outflows, no revert data, no per-probe ok flags. Less return
  surface because less is measured, not because of better structure.
- **Their TS layer does not do more — their contract does more delta math** (in-contract
  compaction of non-zero deltas, in-contract intrinsic+calldata gas, theirs `#L216-L226`)
  while ours deliberately returns raw grids and does the math in TS (auditable, revisable
  without regen — the 054 design's explicit choice). Structurally ours has the better
  layering; theirs has the smaller ABI.
- **Features theirs has that ours lacks**: the `nextTokenId()` counter walk + `ownerOf`
  filter for Uniswap V4 positions (theirs `#L488-L511`) and `tokenURI` capture wired into
  both entry points. Ours deferred the V4 walk explicitly (design §2c, "add on demand").
  Per-feature their NFT machinery is actually ~100 lines *larger* than ours (three walks
  vs two) — flatness elsewhere is what keeps their total near ours.
- **Their flatness has correctness costs already on record**: any-signer ERC-1271, slot-0
  storage, continue-past-failure, no returndata size cap, net-only deltas
  (docs/walletchan-comparison-2026-07-12.md §C; learnings doc "Deliberately NOT adopting").

---

## The via-IR question — empirical results

All experiments: scratch copies, solc 0.8.24, optimizer 200, cancun, legacy codegen unless
stated.

1. **The 11-field return struct is NOT the trigger.** A contract with the full
   `SimulationResult` (incl. nested `NftReceipt[]` with `bytes`) returned from a
   minimal-body function **compiles clean under legacy codegen**. The `foundry.toml`
   comment blaming the return struct is empirically wrong.

2. **The 7-param input list IS the trigger, independent of the body.** The exact
   `simulate` signature with a trivial body fails with
   `Variable dataEnd is 1 slot(s) too deep` inside the generated calldata decoder —
   6 dynamic calldata params × 2 stack slots (offset,length) + 1 address + decoder
   bookkeeping exceeds the EVM's 16-slot reach by exactly one slot. Because the failure
   is in the ABI-decoding prologue the compiler generates from the signature alone, **no
   amount of body restructuring, helper extraction, scoping, or named-return removal can
   fix it while the signature stands.** (The line-137 "Stack too deep" seen first on the
   real contract is a second, body-level symptom of the same 13-slots-of-params pressure.)

3. **History confirms the tipping point.** The 052-era contract (6 params, 10-field
   struct, `8e5f1ce`) compiles legacy (7,035 B). 053's 7th param broke it. It was the
   *input* growth, coincident with the struct growth, that forced via-IR.

4. **The ABI-breaking fix works and was verified end-to-end in scratch.** Bundling all
   seven params into one `SimulationRequest` calldata struct (1 head slot instead of 13),
   passing `req` into `_executeCalls`, and accessing members at call sites compiles under
   **legacy codegen in ~0.4 s** and under via-IR in ~2.3 s. This is **not
   wire-compatible**: the selector and calldata layout change (nested tuple encoding), so
   it would touch the three-way lockstep (`contracts/TxSimulator.sol` /
   `src/internal/simulator.ts` `txSimulatorAbi` / `test/helpers/fakeClient.ts`),
   `test/abi.test.ts`, and every TS encode site. Blast radius is *contained to this repo*
   (the contract is never deployed; the ABI's only consumer is the library itself) but it
   is the largest-radius change on the table, and the legacy build is **+2.4 KB bigger on
   the wire**.

5. **Why walletchan doesn't hit the limit**: max 4 params / 2 dynamic arrays per entry
   point and a 5-member return tuple — comfortably inside legacy codegen's budget. Not a
   structural trick; simply less passed in and out.

6. **Nested sub-structs for the result (e.g. `Checkpoints { allowance; balance; permit2 }`)
   would NOT help and are NOT wire-compatible.** (a) The result encoder was never the
   problem (see 1). (b) A struct member containing dynamic arrays is itself dynamic and
   encodes behind an extra offset indirection — different bytes, decoders break. Any
   sub-structing is an ABI break with zero compile benefit. Rejected.

**Assessment: keep via-IR.** Costs, honestly weighed: ~2 s of single-contract compile
(6.3 s full build — the vitest suite spawning per-test Anvils dwarfs this), the
`("memory-safe")` annotation discipline on 5 assembly blocks (already paid, and correct),
and dependence on the IR pipeline's maturity. Benefits: 24% smaller bytecode than legacy
would be (smaller `eth_call` payloads), no artificial constraints on future struct/param
growth, and one less reason to contort the code (the `ExecutionState` hack can now be
*removed*). Determinism is a non-issue: solc 0.8.24 is pinned in `foundry.toml`, foundry
nightly is pinned in CI, the generated bytecode is committed with a CI freshness gate, and
`test/abi.test.ts` guards the ABI. via-IR has been production-default across major
protocols for years by 2026. The escape hatches (param bundle, or cutting NFT capture)
remain documented above if the calculus ever changes; do not spend them now.

---

## Best-practice findings

Risk classes: **ABI** (wire ABI changes — three-way lockstep + `abi.test.ts` + fakeClient
+ TS encode sites), **BYTECODE** (regen `src/generated/txSimulatorBytecode.ts` +
`dist/`; behavior-identical), **DOCS** (no compile output change). Per CLAUDE.md, no
BYTECODE/ABI change should ship outside a plan that authorizes regeneration.

1. **`foundry.toml:8-11` — the via-IR comment states the wrong cause.** It blames the
   return struct; the empirical cause is the 7-param input list's calldata decoder
   (§via-IR 1–2). Future maintainers deciding whether via-IR can be dropped will reason
   from this comment. Risk: DOCS. Effort: 2 minutes. **Do it.**

2. **`contracts/TxSimulator.sol:97-114` — the `ExecutionState` output-fields pattern is
   vestigial under via-IR.** The struct comment says the four output fields exist "to keep
   that function's stack within the EVM's 16-slot limit" — a legacy-codegen constraint.
   Verified: the tuple-returning form compiles clean under via-IR. The current pattern
   makes `_executeCalls` a mutation-by-reference function whose outputs are four struct
   fields copied out field-by-field in `simulate()` (`:145-148`) — genuinely convoluted vs
   `(result.success, result.failingCallIndex, result.revertData, result.maxNativeOutflow)
   = _executeCalls(...)`. Risk: BYTECODE. Effort: S. **Do in the next contract-touching
   plan.** (If the maintainer instead chooses the `SimulationRequest` bundle someday, that
   change subsumes this one — `_executeCalls(req, state)` frees the stack either way.)

3. **`:345-357`, `:552-559`, `:570-581`, `:585-596` — four near-identical one-word
   staticcall probes.** `_tryBalanceOf`, `_tryAllowance`, `_tryPermit2Allowance`,
   `_tryTokenOfOwnerByIndex` all do `staticcall{gas: PROBE_GAS_LIMIT}` → length-check →
   decode-first-word. One `_tryStaticUint(address target, bytes memory callData, uint256
   minReturnLen) internal view returns (bool ok, uint256 word)` serves all four; callers
   keep their names as one-line encoders. ~30 lines saved, one hardening surface instead
   of four. Risk: BYTECODE. Effort: S. **Do opportunistically.**

4. **`:611`, `:625` — the two `_recover` assembly blocks lack `("memory-safe")`.** They
   only read calldata and write value-typed locals — trivially memory-safe. Un-annotated
   assembly disables via-IR's stack-to-memory spilling for the enclosing function and is
   inconsistent with the other five blocks. Risk: BYTECODE (likely byte-identical, still
   regen). Effort: 2 minutes. **Do opportunistically.**

5. **`:218-248` — magic selector literals in hook returns and `supportsInterface`.**
   `0x150b7a02`, `0xf23a6e61`, `0xbc197c81`, `0x01ffc9a7`, `0x4e2312e0` appear as bare
   literals while probe selectors get named, `cast sig`-verified constants. walletchan at
   least comments each (theirs `#L551-L556`). Name them or comment them. Risk: BYTECODE
   (comments only → DOCS). Effort: S. **Do opportunistically.**

6. **Naming consistency — acceptable, one nit.** The vocabulary is role-consistent:
   `_try*` = best-effort external read returning `(ok, value)`; `_record*` = write into a
   grid/storage; `_snapshot*` = pre-state capture; `_walk*`/`_capture*` = post-state NFT
   phases. The one outlier is `_readBalanceProbe` (`:561`) — a `_try*`-shaped dispatcher
   that can't fail on the native branch. Rename to `_tryBalanceProbe` for uniformity or
   leave; not worth a regen on its own. Risk: BYTECODE. Effort: trivial. **Fold in or skip.**

7. **`:279-293` — `_recordReceipt`'s O(n²) dedup scan: fine.** Bounded by
   `MAX_ENUMERATE_PER_COLLECTION = 50` per collection plus hook receipts; walletchan does
   the same (theirs `#L443-L454`). A mapping-based dedup would need cleared-storage
   assumptions the hashed-slot design deliberately avoids. **Leave alone.**

8. **`simulate` vs `simulateBatchGas` loop duplication: correctly minimal.** They already
   share the only safe primitive, `_executeCall` (`:480-484`). Any deeper sharing puts
   branches or probe plumbing inside `simulateBatchGas`'s `gasleft()` window — exactly the
   measurement pollution the 054 design forbids ("Do NOT wire probes into this loop").
   One honest observation, not a defect: `_executeCall`'s automatic returndata copy (and
   the `revertData = ""` assignment) sits inside the measured window, a small systematic
   *over*-measurement — conservative in the right direction for gas limits. **Leave alone.**

9. **NatSpec coverage: adequate for a never-deployed internal artifact.** The comments
   present are unusually good — they explain *why* (slot-collision rationale, outer-frame
   returndata-copy accounting, sentinel non-max reasoning). Formal `@notice`/`@param` tags
   would add lines, not information. **Leave alone.**

10. **Dead code: none found in the contract.** Every constant, struct field, and function
    is reachable. (`contracts/test/IERC4626.sol` remains the known-unreferenced *fixture*,
    already on the ledger — not this contract.)

11. **`:552-559` et al. — the `ok = success` tail after the `!success` guard** is
    logically `ok = true` and reads oddly. Cosmetic; touch only when editing those
    functions anyway. Risk: BYTECODE. **Fold in or skip.**

---

## Do NOT do

- **Do not chase legacy codegen with body refactors.** Proven impossible: the calldata
  decoder for the 7-param signature overflows with an empty body. Any effort spent there
  is wasted by construction.
- **Do not group `SimulationResult` fields into nested sub-structs.** It fixes nothing
  (the return encoder was never the problem) and it silently breaks the wire ABI (extra
  offset indirection for dynamic members). Worst of both worlds.
- **Do not do the `SimulationRequest` param-bundle now.** It works (verified) and would
  simplify `simulate`/`_executeCalls`, but it is an ABI break across the three-way
  lockstep + `abi.test.ts` + fakeClient + every encode site, ships +2.4 KB of wire
  payload, and buys ~2 s of compile time. Keep it on the shelf as the documented escape
  hatch if via-IR itself ever misbehaves on a pinned toolchain bump.
- **Do not merge the `simulateBatchGas` loop into `simulate`'s.** Measurement purity is
  the function's entire reason for existing (054 design; the in-code comment already says
  so).
- **Do not delete or slim the checkpoint grids, fill-forward, min-balance tracking,
  `revertData` capture, or `balanceProbeOk`.** Each backs a pinned invariant
  (`byCall` zero-tail and `sum === delta`, stride math, reverts-as-status,
  gross-vs-net outflows) with exact-value tests.
- **Do not adopt walletchan's flatter patterns that are known-rejected postures**: slot-0
  capture storage (breaks smart-wallet `from`, proven regression), any-signer ERC-1271
  (false-positive previews), continue-past-failure batches, uncapped metadata returndata
  copy, in-contract intrinsic-gas math. All recorded in
  docs/walletchan-learnings-2026-07-12.md "Deliberately NOT adopting" — this review
  re-confirms each from the source.
- **Do not drop the 64-byte EIP-2098 branch of `_recover`** to save lines — compact
  signatures are valid Permit2 inputs; removing the branch reintroduces a
  simulation/reality divergence.
- **Do not ship any of the BYTECODE-class cleanups as a standalone aesthetic PR.** The
  generated-bytecode discipline (CLAUDE.md) exists because every regen touches the
  committed artifact and the CI freshness gate; batch findings 2–6/11 into the next plan
  that already regenerates.

---

## Method appendix

Scratch experiments (never touching the repo tree), under
`/private/tmp/claude-503/.../scratchpad/`: isolated compiles of (a) the 11-field return
struct alone, (b) the exact 7-param signature with trivial bodies (reproduces both
"Stack too deep" flavors, including the maintainer's `dataEnd` error verbatim), (c) every
historical contract stage `3bce89e`→`bf67815` under both codegens, (d) a full
`SimulationRequest`-bundled restructure of HEAD under both codegens, (e) a tuple-returning
`_executeCalls` revert under via-IR, and (f) walletchan's contract at `470c2767` under
legacy codegen with matched optimizer settings. Context: CLAUDE.md invariants,
plans/README.md rows 044-054 + dependency notes + 2026-07-12/13 reconciliation entries,
docs/design/nft-capture-design-2026-07-12.md,
docs/design/batch-gas-measurement-design-2026-07-12.md,
docs/walletchan-comparison-2026-07-12.md §C.
