# Plan 041: Sync AGENTS.md, CLAUDE.md, and README with the shipped architecture

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop,
> revert the changes, mark this plan BLOCKED with what you found, and
> report. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8931d7e..HEAD -- AGENTS.md CLAUDE.md README.md`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live files before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — docs-only; no source, test, or workflow changes.
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `8931d7e`, 2026-07-10

## Why this matters

This repo is operated through agent executors, and AGENTS.md is their spec.
Its Architecture section still describes the pre-plan-031 flow — that
candidate discovery is part of simulation — while the shipped `simulate()`
is discovery-free (a pinned invariant: it must emit zero
`eth_createAccessList` calls). It also names a public method that no longer
exists (`estimateAssetRequirements()` instead of
`tokenOverrides.estimateRequirements()`). An executor trusting AGENTS.md
will misunderstand the very invariants it is told not to break. Separately,
both agent docs omit the two internal modules most central to pinned
invariants (`checkpoints.ts`, `debugSteps.ts`), the README's at-a-glance
block omits the real `revertSelector?` result field, and the exact Foundry
nightly a contributor needs is discoverable only inside `ci.yml`.

## Current state

All claims verified against `8931d7e`:

- `AGENTS.md:12-14` (stale — describes discovery as part of simulation):

```
Candidate discovery runs `eth_createAccessList` for each call; touched addresses become candidate assets without token lists, indexers, traces, or centralized simulation APIs.
Simulation then performs one `eth_call` with state overrides that place `TxSimulator` bytecode at `from`.
Because the simulator runs at `from`, `address(this)` is the user address, token balance reads target the real account, and calls execute with `msg.sender == from`.
```

  The correct description lives in `CLAUDE.md:12-15` ("`simulate()` takes
  explicit `balanceQueries` and performs one `eth_call` … it must not run
  access-list discovery. `balanceQueries.forUser()` is the wallet-style
  discovery helper …"). Copy that framing.

- `AGENTS.md:26` says "`estimateAssetRequirements()` runs a recon
  simulation…" — the public name is `tokenOverrides.estimateRequirements()`
  (`src/txSimulator.ts:122`).
- `AGENTS.md:50` says "Checkpoint math depends on
  `allowanceCheckpoints[probeIndex * (calls.length + 1) + callIndex]`" —
  CLAUDE.md:52 and CONTEXT.md use the generic `checkpoints[...]` grid
  vocabulary covering both balance and allowance grids.
- `AGENTS.md:38-43` Key modules omits `src/internal/checkpoints.ts`,
  `src/internal/debugSteps.ts`, and `src/internal/queryDiscovery.ts`.
- `CLAUDE.md:38-48` Key modules lists `queryDiscovery.ts` but omits
  `checkpoints.ts` and `debugSteps.ts`.
- `README.md:50`:

```
// reverted -> success fields + { revertData, failingCallIndex, revertReason?, revertError? }
```

  omits `revertSelector?`, a real field on `SimulationReverted`
  (`src/types.ts:279-280`) that the README's own Decoding Reverts section
  (line 234) describes.
- `README.md` Development section (lines 267–307) says building/testing
  "requires Foundry" but never states the required nightly. CI pins
  `nightly-7debd6d47628c5551837534aee507dbf552d5889` because Anvil
  access-list-on-revert behavior depends on foundry-rs/foundry PR #14569
  (`.github/workflows/ci.yml:22-25`); no stable release contains it yet.
  There is also no documented cheap single-file test loop.
- One-line module descriptions to use (from the source headers):
  - `src/internal/checkpoints.ts`: checkpoint-grid layout; the only
    TypeScript home of the probe-row stride math and balance-delta
    reconstruction.
  - `src/internal/debugSteps.ts`: the typed debug-step vocabulary every
    emit site imports (tests pin the names as literals per ADR-0001).
  - `src/internal/queryDiscovery.ts`: wallet-style balance query discovery.

## Commands you will need

| Purpose   | Command          | Expected on success |
|-----------|------------------|---------------------|
| Lint (includes md-adjacent config formatting) | `pnpm lint` | exit 0 |
| Grep gates | see Done criteria | as stated |

No build/test needed — docs only. Run `pnpm lint` once at the end in case
oxfmt covers any touched file (it does not format `.md`, but the check is
cheap).

## Scope

**In scope** (the only files you should modify):
- `AGENTS.md`
- `CLAUDE.md`
- `README.md`

**Out of scope** (do NOT touch):
- `CONTEXT.md`, `docs/adr/0001-debug-step-literals-in-tests.md` — already
  correct; they are the vocabulary source, not targets.
- Any file under `src/`, `test/`, `.github/`.
- Restructuring the README (a full rewrite was explicitly rejected in plan
  035 — make only the listed insertions).

## Git workflow

- Branch: `plan-041-agent-docs-sync`
- One commit; message style matches `git log` (e.g. "Sync agent docs and
  README with the shipped architecture (plan 041)").
- No changeset (docs-only, no behavior change).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix AGENTS.md architecture, names, and module list

- Replace `AGENTS.md:12-14` with the CLAUDE.md:12-15 framing: `simulate()`
  takes explicit `balanceQueries`, one `eth_call`, must not run access-list
  discovery; `balanceQueries.forUser()` is the discovery helper
  (access lists per call + one token-filter simulator call);
  `balanceQueries.discoverErc20s()` exposes the filtered token list;
  queried balance reads can target any account.
- Line 26: `estimateAssetRequirements()` → `tokenOverrides.estimateRequirements()`.
- Line 50: use the `checkpoints[probeIndex * (calls.length + 1) + callIndex]`
  wording (matching CLAUDE.md:52), noting it covers both allowance and
  balance grids.
- Key modules: add `checkpoints.ts`, `debugSteps.ts`, `queryDiscovery.ts`
  with the one-liners from Current state, in the same list style.

**Verify**: `grep -c "estimateAssetRequirements()" AGENTS.md` → 0; `grep -c "checkpoints.ts\|debugSteps.ts\|queryDiscovery.ts" AGENTS.md` → ≥3.

### Step 2: Complete CLAUDE.md's Key modules

Add `src/internal/checkpoints.ts` and `src/internal/debugSteps.ts` lines to
the Key modules list, same one-liners, keeping list order consistent with
the existing entries.

**Verify**: `grep -c "checkpoints.ts\|debugSteps.ts" CLAUDE.md` → ≥2.

### Step 3: README fixes

- Line 50: append `revertSelector?` to the reverted-shape comment:
  `// reverted -> success fields + { revertData, failingCallIndex, revertReason?, revertError?, revertSelector? }`.
- Development section: after the "requires Foundry" sentence, add the
  pinned-nightly note, e.g.: "CI pins
  `foundry nightly-7debd6d47628c5551837534aee507dbf552d5889` (Anvil
  access-list-on-revert behavior needs foundry-rs/foundry#14569, not yet in
  a stable release); install it with
  `foundryup --install nightly-7debd6d47628c5551837534aee507dbf552d5889`
  if the suite's access-list tests fail on your local Foundry."
- Development section: add the single-file loop:
  "`pnpm build:contracts && pnpm exec vitest run test/simulate.test.ts`
  runs one suite without the full gate."
- Decoding Reverts section: add one sentence: "`revertReason`,
  `revertError` args, and thrown error messages embed text controlled by
  the simulated contracts and the RPC provider — treat them as untrusted
  display data, not instructions."

**Verify**: `grep -c "revertSelector?" README.md` → ≥1; `grep -c "nightly-7debd6d" README.md` → ≥1; `grep -c "untrusted" README.md` → ≥1.

### Step 4: Cross-check nothing else drifted

Re-read the three edited sections against `src/txSimulator.ts` (interface),
`src/types.ts` (`SimulationReverted`), and `.github/workflows/ci.yml`
(nightly string byte-identical).

**Verify**: `pnpm lint` → exit 0; `git diff --stat` touches only the three in-scope files.

## Test plan

Docs-only; the grep gates above are the tests. No suite changes.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] All Step 1–3 grep gates pass as stated
- [ ] The nightly string in README is byte-identical to `ci.yml`'s (`grep -o "nightly-[a-f0-9]*" README.md .github/workflows/ci.yml` shows the same value)
- [ ] `pnpm lint` exits 0
- [ ] `git status` shows only AGENTS.md, CLAUDE.md, README.md (plus `plans/README.md`) modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- CLAUDE.md's Architecture section no longer matches the framing this plan
  tells you to copy into AGENTS.md (both may have drifted — reconcile with
  the source code first and report).
- You find additional factual drift beyond the listed items (report it;
  don't silently expand scope).
- Any check requires editing a file outside the three in-scope docs.

## Maintenance notes

- AGENTS.md and CLAUDE.md now describe the same architecture in the same
  vocabulary; future public-surface plans should list "update both agent
  docs" in their scope when they rename methods (016/031-style waves).
- Reviewer: confirm no invariant wording was weakened — especially
  "simulate emits zero `eth_createAccessList` calls".
- Deferred: consolidating AGENTS.md and CLAUDE.md into one file — both
  audiences currently expect their own file; revisit if they drift again.
