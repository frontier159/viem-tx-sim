# Plan 035: README orientation pass — API-at-a-glance, mental model, byCall example fix

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat f7ad02a..HEAD -- README.md src/txSimulator.ts src/index.ts src/types.ts`
> If any of these changed since this plan was written, re-derive the
> at-a-glance block from the LIVE interface (Step 1 requires that anyway)
> and compare the README excerpts below before proceeding; on a README
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (docs-only + one patch changeset)
- **Depends on**: none (001-034 DONE)
- **Category**: docs
- **Planned at**: commit `f7ad02a`, 2026-07-04

## Why this matters

A cold review of the README (2026-07-04) found it ACCURATE against the
current API — every example and claim checks out — but weak on
*orientation*: a first-time reader must read all seven sections in order to
learn the surface, and a skimmer has nothing showing the whole shape at
once. That skim-and-assume gap is exactly what produced a confidently wrong
external review earlier (a reviewer judged the library from the README and
invented parameters that never existed). Three targeted additions close it;
one genuine example/code mismatch rides along (`byCall` is a required
`BalanceDelta` field since plan 034, but the Getting-started output comment
doesn't show it — someone running the example sees different output than
documented). This is deliberately NOT a rewrite: the Known-limitations
section and examples are battle-tested and must not be reworded.

## Current state

(README.md at `f7ad02a`, ~253 lines.)

- Section order: Motivation → Getting started → Preparing overrides →
  Estimating requirements → Debugging → Decoding Reverts → Known
  limitations → Development → Scope. No TOC, no surface summary, no stated
  mental model.
- Getting-started output comment (lines 69-73) shows `balanceDeltas`
  entries as `{ asset, account, before, after, delta }` — **missing the
  required `byCall` field** (added by plan 034; prose at line 76 does
  mention it).
- Scope section (line 252) opens "V1 returns explicit raw balance
  observations only." — "V1" is stale vocabulary now that versioned
  releases (0.1.x, 0.2.x pending) exist.
- The live public surface to summarize (VERIFY against
  `src/txSimulator.ts` + `src/index.ts` at execution time — do not trust
  this list if drifted): `TxSimulator.create(config)` with
  `TxSimulatorConfig = { client, gas?, debug?, errorAbi? }`; instance:
  `simulate(args)` (inputs `from`, `calls`, `balanceQueries`,
  `tokenSlotOverrides?`, `errorAbi?`, `gas?`, `debug?`, block options →
  discriminated `SimulationResult` with `balanceDeltas`/`unresolved` and
  revert fields), `balanceQueries.forUser` / `balanceQueries.discoverErc20s`,
  `tokenOverrides.forBalances` / `forAllowances` / `estimateRequirements`;
  exported constants `DEFAULT_SIMULATION_GAS_LIMIT`,
  `OVERRIDE_TOKEN_AMOUNT`; error classes `TxSimError`,
  `AccessListUnsupportedError`, `StateOverrideUnsupportedError`,
  `InvalidSimulationInputError`.
- README ships in the npm tarball — npmjs.com shows the version from the
  last publish, so a patch changeset is warranted for this to reach npm
  readers (Step 4).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `pnpm lint` | exit 0 |
| Full gate | `pnpm verify` | exit 0 (needs forge/anvil) |
| Changeset | `pnpm changeset` | interactive; pick **patch** |

## Scope

**In scope**: `README.md`, `.changeset/*.md` (one new patch changeset) or
`CHANGELOG.md` when executed on an existing version branch,
`plans/README.md` (status row).

**Out of scope**: ANY code file; `CLAUDE.md`; `docs/motivation.md`;
rewording the Known-limitations section or the existing examples beyond
the specific edits below; a docs-site/API-reference restructure
(considered and rejected — JSDoc from plan 022 serves the in-editor
reference role; recorded in the index).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.
  Branch protection is active on `master` — the operator merges.

## Steps

### Step 1: Mental model + API at a glance

Insert between the Motivation and Getting-started sections:

1. A short mental-model paragraph (~3 sentences), substance: *everything
   is one of three explicit inputs — `calls` (what executes),
   `balanceQueries` (what you observe), `tokenSlotOverrides` (what state
   you assume) — and nothing is implicit: no hidden discovery, retries, or
   forging inside `simulate()`. The helper namespaces exist to build the
   two data inputs: `balanceQueries.*` builds observations,
   `tokenOverrides.*` builds assumptions.*
2. An "API at a glance" fenced `ts` block (~20-25 lines), derived from the
   LIVE interface: `TxSimulator.create({...})` config fields, the
   `simulate` signature with its input/output field names inline as
   comments, the five namespaced helpers one line each with a trailing
   comment on what each returns, and one comment line listing the exported
   constants and error classes. Signature-level only — no bodies, no
   invented fields; every name must exist in `src/txSimulator.ts` /
   `src/index.ts`.

**Verify**: every identifier in the block greps in `src/` (spot-check the
five method paths and both constants); `pnpm lint` → exit 0.

### Step 2: Fix the Getting-started output comment

Update the example output (lines ~69-73) so each shown delta includes a
plausible `byCall` array consistent with the 2-call example (e.g. the USDS
entry: `byCall: [0n, -1000n...]` — approve moves nothing, deposit moves
all; sUSDS mirrored; native `[0n, 0n]`). Keep the existing before/after
values untouched.

**Verify**: `grep -c "byCall" README.md` increased by ≥3 vs
`git show HEAD:README.md | grep -c byCall`.

### Step 3: Wording nits + TOC

1. Scope section: "V1 returns…" → "The library returns…" (rest of the
   sentence unchanged).
2. Add a compact TOC (link list, one line per section) directly under the
   title line.

**Verify**: `grep -c "^V1" README.md` → 0; TOC anchors match the actual
heading slugs (click-test at least two locally or verify slug format).

### Step 4: Patch changeset + full gate

`pnpm changeset` → **patch** — summary: "README: API-at-a-glance summary,
mental-model intro, byCall in examples." (Docs ship in the tarball; npm
readers only see published READMEs.) If this plan is executed on an existing
version branch before publication, fold that summary into the pending
`CHANGELOG.md` entry instead of creating a follow-up changeset.

**Verify**: `ls .changeset/*.md | grep -v README | wc -l` → ≥1 new;
`pnpm verify` → exit 0.

## Test plan

None — docs only. `pnpm verify` guards against accidental non-doc changes
(`git status` must show only README + changeset + plans index).

## Done criteria

- [ ] `pnpm verify` exits 0; `git status --porcelain` shows only in-scope files
- [ ] README has the mental-model paragraph and an at-a-glance block whose every identifier exists in `src/`
- [ ] Getting-started output shows `byCall` on each delta
- [ ] No "V1" vocabulary; TOC present with working anchors
- [ ] Known-limitations section byte-identical (`git diff README.md` shows no hunks inside it)
- [ ] A patch changeset exists, or the pending version changelog includes the README note
- [ ] `plans/README.md` status row updated

## STOP conditions

- The live interface differs from the surface list in Current state (a
  plan landed in between) — derive the block from the code and note the
  difference; STOP only if you cannot reconcile what a method returns.
- The at-a-glance block cannot stay under ~30 lines without omitting
  public surface — report; the answer might be a docs-site decision, not a
  bigger block.
- Any edit would touch the Known-limitations wording.

## Maintenance notes

- The at-a-glance block is a second copy of the interface and WILL rot:
  the CLAUDE.md same-PR rule extends to it — any public-surface change
  updates the block in the same PR. If that discipline fails twice, delete
  the block rather than let it lie (an absent map beats a wrong one).
- If the library grows past ~8 public methods, revisit the rejected
  docs-site restructure instead of growing this README further.
