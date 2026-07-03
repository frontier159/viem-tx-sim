# Plan 033: Align CI node with the release pin + repo hygiene (gitignore, permit-scope doc line)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9f86857..HEAD -- .github .gitignore README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `9f86857`, 2026-07-04

## Why this matters

The package is now LIVE on npm (`viem-tx-sim` 0.1.0 and 0.1.1 published via
the release workflow), which raised the bar on workflow consistency. An
external PR (#4, `a754da6`) pinned the release workflow's node to exactly
`24.18.0`, but the CI verify job still runs node `22` — so the version that
builds and tests every PR is not the version that builds the published
artifact. Maintainer decision (2026-07-04): CI verifies on the SAME pinned
version the release publishes from. Two hygiene riders: `.DS_Store` is
untracked-but-present (macOS litter; one gitignore line), and the
permit-flow scope decision needs one explicit README sentence (the helper
was permanently rejected — the docs should say "bring signed calldata"
rather than leaving it implied).

## Current state

(At `9f86857`.)

- `.github/workflows/ci.yml` — `verify` job's setup-node step (SHA-pinned
  action) has `node-version: 22`.
- `.github/workflows/release.yml` — setup-node step (SHA-pinned) has
  `node-version: 24.18.0` (line ~20, from PR #4).
- `.gitignore` (complete): `cache/`, `dist/`, `node_modules/`, `out/`,
  `.pnpm-store/`, `*.tsbuildinfo` — no `.DS_Store`; an untracked
  `.DS_Store` currently sits in the tree.
- `README.md` Scope section says token metadata/lists/indexers/centralized
  APIs/"approval UX"/price enrichment are out of scope; the Known
  limitations section covers ERC-1271 for contract wallets. Neither states
  plainly that the library does not construct or sign permits.
- `package.json` `engines: { "node": ">=20" }` — a floor, still satisfied
  by 24; unchanged by this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (needs forge/anvil) |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope**: `.github/workflows/ci.yml` (one value), `.gitignore` (one
line), `README.md` (one sentence), `plans/README.md` (status row).

**Out of scope**: `.github/workflows/release.yml` (already correct — the
pin flows FROM it TO ci); action SHA pins (Dependabot's job); `engines`
in package.json; everything under `src`/`test`/`contracts`.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.
- Branch protection is now active on `master` — work lands via PR; the
  operator merges.

## Steps

### Step 1: Align the node version

In `ci.yml`, change the setup-node step's `node-version: 22` to
`node-version: 24.18.0` (byte-identical to release.yml's value). Add a
one-line YAML comment: `# keep in lockstep with release.yml`.

**Verify**:
`grep -h "node-version" .github/workflows/ci.yml .github/workflows/release.yml | sort -u | wc -l`
→ 1.

### Step 2: gitignore

Append `.DS_Store` to `.gitignore`.

**Verify**: `git status --short | grep -c DS_Store` → 0.

### Step 3: Permit-scope sentence

In README's Scope section, append one sentence along the lines of: the
library never constructs or signs permits/EIP-712 payloads — callers bring
fully signed calldata; simulation of already-signed permit calls works as
ordinary calls (EOA `isValidSignature` handling per Known limitations).

**Verify**: `grep -ci "permit" README.md` → increased by ≥1 vs
`git show HEAD:README.md | grep -ci permit`; `pnpm lint` → exit 0.

### Step 4: Full gate

**Verify**: `pnpm verify` → exit 0.

## Test plan

None — config/docs only; `pnpm verify` is the regression gate, and the
node alignment itself is proven by the next CI run on the PR (note that in
your report rather than claiming CI green).

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] Both workflows report the identical `node-version` (Step 1 grep → 1)
- [ ] `.DS_Store` ignored (Step 2 grep → 0)
- [ ] README states the no-permit-crafting scope explicitly
- [ ] `plans/README.md` status row updated

## STOP conditions

- `pnpm verify` fails under local node if the developer machine runs <24 —
  that is NOT caused by this change (engines floor is 20); report the
  actual failure rather than reverting the alignment.
- release.yml's pin has changed since `a754da6` — align to whatever it
  currently says, not to this plan's literal `24.18.0`, and note it.

## Maintenance notes

- The lockstep rule now covers TWO values across the workflow pair: the
  foundry nightly pin and the node pin. Reviewers check both files on
  either bump; the YAML comments mark them.
- If node-version drift between the workflows recurs, consider extracting
  a shared setup via a composite action — deliberately not done now (two
  files, two values, comments suffice).
