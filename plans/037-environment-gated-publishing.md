# Plan 037: Environment-gated publishing — human approval on every npm release, workflow-change review controls

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 167ae9e..HEAD -- .github CLAUDE.md`
> If `release.yml` changed since this plan was written, compare the
> "Current state" excerpt against the live file before proceeding; on a
> mismatch, treat it as a STOP condition. (Version Packages merges bump
> `package.json`/`CHANGELOG.md` — that drift is irrelevant here.)

## Status

- **Priority**: P2
- **Effort**: S-M
- **Risk**: MED — this workflow is the publish path; a wrong job split can silently stop releases. Mitigation: the detect logic is locally testable, and the operator sequencing below keeps the old path working until the npm-side binding flips.
- **Depends on**: none (001-036 DONE)
- **Category**: security (maintainer-accepted hardening, 2026-07-04 discussion)
- **Planned at**: commit `167ae9e`, 2026-07-04

## Why this matters

Publishing is currently fully automatic: merge the Version Packages PR and
`release.yml` publishes via OIDC trusted publishing — no credential exists
to steal (good), but also no explicit approval step, and nothing prevents a
future workflow-file change from publishing without a human in the loop.
This plan adds the GitHub-native second factor for OIDC publishing:

1. A **`npm-publish` GitHub Environment** with required reviewers and a
   master-only deployment branch policy. The publish job declares it, so
   the job parks in **Waiting** until a reviewer approves (Actions → run
   page → "Review deployments" → Approve; reviewers are also notified).
   Crucially, the protection rules live in REPO SETTINGS, not YAML — a
   malicious workflow that adds `environment: npm-publish` doesn't gain
   anything; it subjects itself to the gate and pages the reviewer about a
   deployment they didn't initiate.
2. **npm-side environment binding**: the trusted-publisher config gains the
   environment name, so OIDC tokens WITHOUT the `environment: npm-publish`
   claim are rejected by npm outright. Combined with npm's existing
   repo+workflow-filename pinning, a publish then requires: the pinned
   repo, the pinned `release.yml`, the approved environment, on master.
   (Known residual, recorded honestly: npm cannot pin the workflow
   CONTENT hash — `workflow_sha` is in the token but npm doesn't verify
   it. The compensating control is review-on-change: CODEOWNERS +
   optional path ruleset below.)
3. **Approval noise elimination**: `release.yml` runs on EVERY master
   push, but only version-merge pushes publish. The job is split so the
   gate only fires when a release is actually pending — ordinary merges
   never prompt.
4. **CODEOWNERS for `.github/workflows/`** — documents ownership and
   auto-requests review today; becomes an enforced change-gate the day a
   second maintainer exists (see the solo-maintainer wrinkle in Step 3).

## Current state

(At `167ae9e`.)

### `.github/workflows/release.yml` (complete, verbatim)

```yaml
name: release

on:
  push:
    branches: [master]

permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  release:
    if: github.repository == 'frontier159/viem-tx-sim'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: 24.18.0
          registry-url: https://registry.npmjs.org
      - run: corepack enable
      - uses: foundry-rs/foundry-toolchain@c7450ba673e133f5ee30098b3b67ba3780d0d # v1.8.0
        with:
          version: nightly-7debd6d47628c5551837534aee507dbf552d5889
      - run: pnpm install --frozen-lockfile
      - name: create version PR or publish
        uses: changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d # v1.9.0
        with:
          publish: pnpm release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
```

(NOTE: copy SHA pins from the LIVE file, not from this excerpt — Dependabot
may have bumped them.)

- One job does two things: on ordinary pushes `changesets/action` only
  creates/updates the Version Packages PR (no publish happens — versions
  only change on that PR's branch); on a version-merge push there are no
  pending changesets and the local version differs from npm, so it runs
  `publish: pnpm release`.
- Permissions are workflow-wide (contents+PRs+id-token for everything).
- `pnpm release` = `pnpm verify && pnpm changeset publish` (package.json).
  `pnpm install` triggers `prepare` (`build:ts`, tsc-only — no Foundry
  needed for install; Foundry IS needed for `pnpm verify`'s forge build).
- No `.github/CODEOWNERS` exists. Repo is public (Environments with
  required reviewers are available on public repos free). Branch
  protection on master is active; maintainer is solo (`frontier159`).
- npm trusted publisher is configured for repo + `release.yml`, NO
  environment binding yet. Package `viem-tx-sim` is live (0.2.0).
- CLAUDE.md has a release-process section describing the current
  single-job flow.

## Target design

### `release.yml` — three jobs

```yaml
name: release

on:
  push:
    branches: [master]

permissions:
  contents: read

jobs:
  detect:
    if: github.repository == 'frontier159/viem-tx-sim'
    runs-on: ubuntu-latest
    outputs:
      publish: ${{ steps.check.outputs.publish }}
    steps:
      - uses: actions/checkout@<pin> # copy from live file
      - id: check
        name: unpublished version on master?
        run: |
          LOCAL=$(node -p "require('./package.json').version")
          PUBLISHED=$(npm view viem-tx-sim version 2>/dev/null || echo "none")
          echo "local=$LOCAL published=$PUBLISHED"
          if [ "$LOCAL" != "$PUBLISHED" ]; then
            echo "publish=true" >> "$GITHUB_OUTPUT"
          else
            echo "publish=false" >> "$GITHUB_OUTPUT"
          fi

  version-pr:
    if: github.repository == 'frontier159/viem-tx-sim'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      # checkout, setup-node (24.18.0 + registry-url), corepack enable,
      # pnpm install --frozen-lockfile  — same pinned steps as today,
      # but NO foundry (nothing here builds contracts; prepare is tsc-only)
      - name: create or update the Version Packages PR
        uses: changesets/action@<pin>
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  publish:
    needs: detect
    if: github.repository == 'frontier159/viem-tx-sim' && needs.detect.outputs.publish == 'true'
    runs-on: ubuntu-latest
    environment: npm-publish
    permissions:
      contents: write   # changeset publish pushes tags / creates releases
      id-token: write   # OIDC trusted publishing + provenance
    steps:
      # checkout, setup-node (24.18.0 + registry-url), corepack enable,
      # foundry-toolchain (same pinned nightly as ci.yml), pnpm install
      - name: publish to npm
        uses: changesets/action@<pin>
        with:
          publish: pnpm release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
```

Semantics: ordinary master push → `detect` says false (master's version is
already on npm), `publish` is SKIPPED (no approval prompt), `version-pr`
maintains the bot PR. Version-merge push → `detect` says true, `publish`
parks in **Waiting** for environment approval, `version-pr` no-ops (no
pending changesets). One click per release, zero otherwise. On the publish
path `changesets/action` sees no pending changesets and runs
`publish: pnpm release` (full verify incl. forge, then
`changeset publish` + tag push). Note `detect` treats "local ≠ published"
as pending — versions only move forward via the bot PR, so inequality is
sufficient; the `|| echo "none"` handles registry hiccups by failing OPEN
to a prompt (an unnecessary approval request is the safe failure mode; a
silently skipped release is not).

### `.github/CODEOWNERS` (create)

```
/.github/workflows/ @frontier159
/.changeset/config.json @frontier159
```

### CLAUDE.md

Update the release-process section: the two-phase flow (bot PR →
merge → **approve the npm-publish deployment** → publish with provenance),
and the rule that release.yml's foundry/node pins stay in lockstep with
ci.yml.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Detect logic locally | the `check` script body, run in repo root | prints local/published; correct output var |
| YAML sanity | any YAML parser / `gh workflow list` after push | parses |
| Full gate | `pnpm verify` | exit 0 (proves no code was touched) |

## Scope

**In scope**: `.github/workflows/release.yml`, `.github/CODEOWNERS`
(create), `CLAUDE.md` (release section), `plans/README.md` (status row).

**Out of scope**: `.github/workflows/ci.yml` (stays secret-free,
environment-free, fork-runnable); all of `src`/`test`/`contracts`; NO
changeset (nothing in the published tarball changes); repo/npm settings
(operator handoff below — the executor CANNOT create environments, set
reviewers, or edit npm trusted-publisher config); repository rulesets
(operator-optional, recipe in handoff).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.
  Branch protection is active on `master` — the operator merges.

## Steps

### Step 1: Rewrite `release.yml`

Per Target design. Copy every action SHA pin and the foundry nightly
`version:` from the LIVE file. Keep the fork guard on all three jobs.
Top-level `permissions: contents: read`; elevation is per-job exactly as
shown (version-pr gets no id-token; detect gets nothing extra).

**Verify**: YAML parses;
`grep -c "environment: npm-publish" .github/workflows/release.yml` → 1;
`grep -c "id-token" .github/workflows/release.yml` → 1 (publish job only);
`grep -En "uses:.*@v[0-9]" .github/workflows/release.yml` → no matches.

### Step 2: Test the detect logic locally

Run the `check` script body in the repo root. With the working tree at a
released version, expect `publish=false` behavior (local == published);
temporarily edit package.json version to e.g. `9.9.9`, re-run, expect
`publish=true`, then revert (`git checkout -- package.json`).

**Verify**: both outcomes observed; `git status --porcelain` clean of
package.json afterward.

### Step 3: CODEOWNERS + CLAUDE.md

Create `.github/CODEOWNERS` per Target design; update CLAUDE.md's release
section. Include this caveat verbatim in CLAUDE.md or the PR description:
**do NOT enable branch protection's "require review from Code Owners"
while the repo has a single maintainer** — GitHub forbids authors approving
their own PRs, so the sole owner would block their own workflow changes;
enable it the day a second maintainer has merge rights.

**Verify**: `pnpm verify` → exit 0; `git status --porcelain` shows only
in-scope files.

## Operator handoff (report these prominently — sequencing matters)

1. **Before or after merging** (safe either way): create the environment —
   Settings → Environments → New environment → `npm-publish`; add
   **Required reviewers**: `frontier159`; **Deployment branches**:
   selected branches → `master` only.
2. **Merge this plan's PR.** From this moment publishes wait for approval
   (the npm binding isn't needed for the gate itself).
3. **LAST — after the merged workflow exists**: on npmjs.com → package
   `viem-tx-sim` → Trusted Publisher settings → set **Environment name**
   = `npm-publish`. Do NOT do this before the merge: the current
   single-job workflow's OIDC tokens carry no environment claim, so
   binding early would make any interim publish fail at npm.
4. **First gated release**: after the next Version Packages merge, expect
   the Waiting state in Actions → "Review deployments" → approve → confirm
   the publish succeeds with provenance. Until this happens once
   end-to-end, treat the pipeline as unproven and keep the release small.
5. **Optional, recorded for later**: a repository push ruleset restricting
   `.github/workflows/**` changes to PRs (Settings → Rules → Rulesets →
   push ruleset, restrict file paths) — marginal while the bypass list is
   the sole maintainer; revisit alongside the CODEOWNERS toggle when a
   second maintainer arrives.

## Test plan

Step 2's local detect test is the only executable test. The real
acceptance is operational: one ordinary merge producing NO approval prompt,
and one version merge producing exactly one prompt and a successful
provenance publish — both operator-observed (item 4), not executor-claimable.

## Done criteria

- [ ] `release.yml` has the three jobs with per-job permissions, environment on publish only, all pins copied from live
- [ ] Detect logic verified locally in both directions
- [ ] `.github/CODEOWNERS` exists; CLAUDE.md documents the gated flow + solo-maintainer caveat
- [ ] No changeset added; `git diff --stat -- src test contracts` → empty; `pnpm verify` exits 0
- [ ] Report lists the operator sequence (env → merge → npm binding LAST) and the unproven-until-first-release caveat
- [ ] `plans/README.md` status row updated

## STOP conditions

- The live `release.yml` differs materially from the excerpt (beyond
  Dependabot pin bumps) — re-derive the split from what's actually there.
- `changesets/action` without a `publish` input does anything other than
  PR maintenance in your reading of its current docs — report before
  restructuring around it.
- Anything requires adding secrets or touching ci.yml.

## Maintenance notes

- The gate's security floor remains the reviewers' GitHub accounts —
  strong 2FA there is the root control; the environment adds approval +
  claim-narrowing, not account-compromise resistance.
- Known residual (accepted): npm does not verify `workflow_sha`, so
  workflow-content changes aren't cryptographically bound to approvals;
  the compensating control is review-on-change (CODEOWNERS toggle +
  ruleset) once a second maintainer exists.
- Three values now stay in lockstep across ci.yml/release.yml: foundry
  nightly, node pin, and (new) the SHA pins Dependabot maintains in both.
- If approval noise ever appears on ordinary merges, the detect job's
  registry comparison is the first suspect (npm view caching/latency) —
  it fails open to a harmless extra prompt by design.
