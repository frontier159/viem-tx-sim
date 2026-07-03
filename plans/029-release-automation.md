# Plan 029: Release automation — changesets versioning and provenance publishing from CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> 1. `grep -n "| 028 |" plans/README.md` → status must be `DONE`. If not,
>    STOP — this plan publishes the manifest 028 makes publishable
>    (peer-dep viem, LICENSE, trimmed files, metadata).
> 2. `git diff --stat b3390e0..HEAD -- package.json .github` → drift from
>    028 is expected; verify its changes are present rather than absent.

## Status

- **Priority**: P2
- **Effort**: S-M
- **Risk**: LOW-MED (new workflow can only misfire at release time; nothing touches library code)
- **Depends on**: plans/028
- **Category**: dx
- **Planned at**: commit `b3390e0`, 2026-07-03

## Why this matters

Once 028 lands, `npm publish` works — manually, from someone's laptop, with
no changelog and no provenance. For a wallet-facing library the release
path should be: every meaningful PR carries a changeset; a bot PR
accumulates them into a version bump + CHANGELOG; merging that PR publishes
to npm from CI with `--provenance` (cryptographically linking the package
to the exact workflow run and commit — meaningful supply-chain signal for
a security-sensitive package). Changesets is the ecosystem default
(viem/wagmi use it) and stays lightweight for a solo maintainer.

## Current state

(Post-028 expected; verify rather than assume.)

- `package.json`: `"name": "viem-tx-sim"`, `"version": "0.1.0"`, `files`
  trimmed, `repository` pointing at
  `github.com/frontier159/viem-tx-sim`, viem as peer. Never published;
  first publish will create the npm package (name availability must be
  checked — see Step 5).
- `.github/workflows/ci.yml`: the `verify` job (checkout, node 22 +
  corepack, pinned foundry nightly, `pnpm install --frozen-lockfile`,
  `pnpm verify`, artifact-freshness gate, attw + tarball smoke from 028).
  Building this package REQUIRES the pinned foundry nightly (contracts →
  bytecode) — the release workflow must replicate that toolchain, not just
  node.
- No CHANGELOG.md, no `.changeset/`, no publish workflow, no npm token
  configured in the repo (executor cannot add secrets — see Step 5).
- Repo convention: workflows must stay runnable on forks without secrets
  (plan 008 decision) — hence publishing is a SEPARATE workflow, and the
  changesets bot job is gated to the upstream repo.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Add changesets | `pnpm add -D @changesets/cli && pnpm changeset init` | `.changeset/` created |
| Dry-run a version bump | `pnpm changeset version` (on a scratch branch or followed by `git checkout -- .`) | version + CHANGELOG updated locally |
| Full gate | `pnpm verify` | exit 0 |

## Scope

**In scope**: `package.json` (devDependency + two scripts),
`pnpm-lock.yaml`, `.changeset/config.json` (create),
`.github/workflows/release.yml` (create), `CLAUDE.md` (release-process
section), `README.md` (only if it promises manual publishing anywhere —
it shouldn't), `plans/README.md` (status row).

**Out of scope**: `.github/workflows/ci.yml` (verify stays fork-runnable
and secret-free); all of `src/`/`test/`/`contracts/`; actually performing
the first publish (operator action); creating repo secrets (impossible for
the executor — reported as operator TODO).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Install and configure changesets

`pnpm add -D @changesets/cli`, then `pnpm changeset init`. Edit
`.changeset/config.json`:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "frontier159/viem-tx-sim" }],
  "commit": false,
  "access": "public",
  "baseBranch": "main"
}
```

(`@changesets/changelog-github` needs `pnpm add -D` as well; if its GitHub
token requirement at version time is unwanted, fall back to the default
changelog generator and note it.) Add scripts:

```json
"changeset": "changeset",
"release": "pnpm verify && pnpm changeset publish"
```

**Verify**: `pnpm changeset --help` → exit 0; `.changeset/config.json` has
`"access": "public"`.

### Step 2: Sanity-check the version flow locally

Create a scratch changeset (`pnpm changeset` → patch → any summary), run
`pnpm changeset version`, confirm `package.json` bumps to `0.1.1` and
`CHANGELOG.md` is generated, then **revert everything from this step**
(`git checkout -- package.json CHANGELOG.md && rm -rf .changeset/*.md` —
keep `config.json`). This proves the flow without committing a bump.

**Verify**: after revert, `git status --porcelain` shows only this plan's
intended files; `node -e "console.log(require('./package.json').version)"`
→ `0.1.0`.

### Step 3: Release workflow

Create `.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  release:
    if: github.repository == 'frontier159/viem-tx-sim'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: corepack enable
      - uses: foundry-rs/foundry-toolchain@v1
        with:
          version: <SAME pinned nightly as ci.yml — copy it verbatim>
      - run: pnpm install --frozen-lockfile
      - name: create version PR or publish
        uses: changesets/action@v1
        with:
          publish: pnpm release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: "true"
```

Semantics: on main-branch pushes, the action opens/updates a "Version
Packages" PR while changesets exist; when that PR merges, it runs
`pnpm release` (full verify — including forge build via the pinned
toolchain — then publish with provenance via `id-token: write` +
`NPM_CONFIG_PROVENANCE`). The `if:` guard keeps forks from attempting any
of this.

**Verify**: YAML parses; the foundry `version:` string is byte-identical to
`ci.yml`'s (grep both files and diff the lines).

### Step 4: Document the release process

Add a short "Releasing" section to `CLAUDE.md`: every behavior-changing PR
adds a changeset (`pnpm changeset`); the release workflow maintains a
Version Packages PR; merging it publishes to npm with provenance; the
package is pre-1.0 so minor = breaking is acceptable until 1.0.0.

**Verify**: `grep -c "changeset" CLAUDE.md` → ≥2; `pnpm verify` → exit 0.

### Step 5: Operator handoff (report, don't do)

Two things only the operator can do — list them prominently in your final
report:

1. **Create the `NPM_TOKEN` repo secret** (npm automation token with
   publish rights; or configure npm Trusted Publishing for this repo, in
   which case `NODE_AUTH_TOKEN` can be dropped from the workflow later).
2. **Confirm the `viem-tx-sim` name is available/claimed on npm** before
   the first Version Packages PR is merged (`npm view viem-tx-sim` →
   should 404 today; if taken, the package must be renamed or scoped, which
   is a separate decision).

## Test plan

Step 2's local version-flow rehearsal is the executable test. The workflow
itself can only be fully verified by the first real release — the plan's
gates are syntax, toolchain parity with ci.yml, and the fork guard.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `.changeset/config.json` exists with `access: public`; `@changesets/cli` in devDependencies
- [ ] `pnpm changeset version` rehearsal succeeded and was fully reverted (version still `0.1.0`, no stray changeset .md files)
- [ ] `.github/workflows/release.yml` exists: fork guard, pinned foundry version identical to ci.yml, `id-token: write`, provenance env, `publish: pnpm release`
- [ ] `ci.yml` untouched (`git diff -- .github/workflows/ci.yml` → empty)
- [ ] CLAUDE.md documents the release flow
- [ ] Report lists the two operator TODOs (NPM_TOKEN secret, npm name check)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Plan 028 not DONE (unpublishable manifest).
- The published tarball ends up without a fresh `dist/` (it shouldn't —
  `dist/` is gitignored build output, and `pnpm release` runs the full
  build via `pnpm verify` before `changeset publish` packs the filesystem;
  `prepublishOnly` from plan 028 is the second guard. If a publish ever
  packs a missing/stale dist, the build chain regressed — report).
- Anything tempts you to add secrets handling to `ci.yml` — forbidden;
  release concerns live only in `release.yml`.

## Maintenance notes

- First release: merge the Version Packages PR only after the operator
  TODOs are done; the publish step fails cleanly on a missing token (the
  version PR itself is unaffected).
- When npm Trusted Publishing (OIDC) is configured for this repo, drop
  `NODE_AUTH_TOKEN` and the secret — provenance already uses `id-token`.
- At 1.0.0, revisit the changesets config: pre-1.0 "minor = breaking"
  loosens into real semver, and the viem peer range policy (plan 028)
  should be re-checked in the same pass.
