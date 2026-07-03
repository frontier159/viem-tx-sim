# Plan 030: Supply-chain hardening — lockfile-pinned tooling, SHA-pinned actions, install cooldown, least privilege

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8c7b54b..HEAD -- .github package.json pnpm-workspace.yaml pnpm-lock.yaml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S-M
- **Risk**: LOW (CI/config only; the suite and the CI run itself are the net)
- **Depends on**: plans/028 (DONE — hardens the pipeline it added); run BEFORE plans/029 so the release workflow is born hardened
- **Category**: security
- **Planned at**: commit `8c7b54b`, 2026-07-03

## Why this matters

The 2025 npm attack wave (the chalk/debug compromise and Shai-Hulud worm,
the nx token-stealer) and the March 2025 **tj-actions/changed-files**
incident (tags retroactively moved onto malicious commits, compromising
every workflow that referenced `@vNN`) define the current threat model for
a repo like this. Plan 028's pipeline has four exposures against it:

1. `pnpm dlx @arethetypeswrong/cli` executes the latest matching version
   AND its unpinned transitive tree at CI runtime, every run — exactly the
   fresh-compromise window the 2025 attacks exploited.
2. All GitHub Actions are referenced by mutable tags (`@v4`, `@v1`).
3. The smoke test `npm install`s viem/typescript/@types/node unpinned from
   the registry at CI time, with install scripts enabled.
4. `ci.yml` has no `permissions` block, so the GITHUB_TOKEN gets the repo
   default (potentially write).

Plus one preventive control this repo can adopt cheaply: a release-age
cooldown (`minimumReleaseAge`) so freshly published dependency versions —
the ones that get unpublished within hours when compromised — are never
installed here, in CI or locally.

## Current state

(All at `8c7b54b`. Repo default branch is **master** — ci.yml's trigger is
correct as-is; do not "fix" it to main.)

### `.github/workflows/ci.yml` (relevant lines, verbatim)

```yaml
on:
  push:
    branches: [master]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: corepack enable
      - uses: foundry-rs/foundry-toolchain@v1
        with:
          # Update to stable when a new release > v1.7.1 is out
          # Anvil fork tests depend on https://github.com/foundry-rs/foundry/pull/14569
          version: nightly-7debd6d47628c5551837534aee507dbf552d5889
      ...
      - name: types resolve from the packed tarball
        run: pnpm dlx @arethetypeswrong/cli --pack . --profile esm-only
      - name: packed tarball smoke test
        run: |
          ...
          npm install /tmp/vts.tgz viem typescript @types/node > /dev/null
          ...
```

No `permissions:` block anywhere in the file. (Note the foundry `version:`
is already an immutable nightly-SHA build — the *action* reference `@v1` is
the mutable part.)

### pnpm config

`pnpm-workspace.yaml` (complete):

```yaml
allowBuilds:
  esbuild: true
```

— dependency lifecycle scripts are blocked by default under pnpm 10 with a
single intended grant (esbuild, needed by vitest). During execution, verify
with `pnpm ignored-builds`; pnpm 10.18.3 reports the active grant field as
`package.json#pnpm.onlyBuiltDependencies`, not `allowBuilds`. Local pnpm:
`10.18.3`. `package.json` has `pnpm.overrides` (ws) only.

### Exact dev versions (for smoke pinning; RE-DERIVE at execution time)

`pnpm ls viem typescript @types/node --depth -1` currently resolves:
viem 2.54.1, typescript 5.9.3, @types/node 20.19.43.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 |
| Resolve a tag's commit | `git ls-remote https://github.com/actions/checkout refs/tags/v4\* \| tail -5` | SHA list (use the `^{}` dereferenced commit of the newest v4 tag) |
| attw locally | `pnpm exec attw --pack . --profile esm-only` | no errors |
| Cooldown support check | `pnpm help config \| grep -i minimumReleaseAge` or pnpm docs | setting exists in pnpm ≥10.16 |

## Scope

**In scope**: `.github/workflows/ci.yml`, `.github/dependabot.yml`
(create), `package.json` (attw devDependency), `pnpm-lock.yaml`,
`pnpm-workspace.yaml` (cooldown + comment), `plans/README.md` (status row).

**Out of scope**: `release.yml` (plan 029 creates it born-hardened — its
spec already reflects these conventions); all of `src/`/`test/`; the
foundry nightly `version:` value (already immutable, and its stable-release
TODO comment stays); repo settings (branch protection, secrets) — operator
territory; StepSecurity harden-runner and OpenSSF Scorecard — considered,
rejected as operationally heavy for a two-workflow repo (recorded in the
index).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: attw becomes a lockfile-pinned devDependency

`pnpm add -D @arethetypeswrong/cli`, then change the ci.yml step to:

```yaml
      - name: types resolve from the packed tarball
        run: pnpm exec attw --pack . --profile esm-only
```

(The binary is `attw`.) Now the tool and its entire transitive tree are
integrity-hashed in `pnpm-lock.yaml`, installed under `--frozen-lockfile`,
and its install scripts are blocked by the pnpm default.

**Verify**: `pnpm exec attw --pack . --profile esm-only` → passes locally
(build `dist` first if absent: `pnpm build:ts`);
`grep -c "dlx" .github/workflows/ci.yml` → 0.

### Step 2: least-privilege token

Add at the top level of ci.yml (after `on:`):

```yaml
permissions:
  contents: read
```

**Verify**: YAML parses; the job has no step needing write (the freshness
gate only diffs; nothing pushes).

### Step 3: SHA-pin every action reference

For each of `actions/checkout@v4`, `actions/setup-node@v4`,
`foundry-rs/foundry-toolchain@v1`: resolve the CURRENT newest tag of that
major to its commit SHA via `git ls-remote` against the official repo
(prefer the `^{}` peeled entry — annotated tags point at tag objects, the
workflow needs the commit). Replace the reference with the 40-char SHA and
keep the human-readable version as a trailing comment:

```yaml
      - uses: actions/checkout@<40-char-sha> # v4.x.y
```

Do NOT copy SHAs from this plan or from memory — resolve them live and
record in your report which tag each SHA corresponds to.

**Verify**: `grep -En "uses:.*@[0-9a-f]{40}" .github/workflows/ci.yml | wc -l`
→ 3; `grep -En "uses:.*@v[0-9]" .github/workflows/ci.yml` → no matches.

### Step 4: dependency cooldown + posture comment

In `pnpm-workspace.yaml`, add:

```yaml
# Supply-chain posture: dependency install scripts are blocked by default
# (pnpm 10); esbuild is the single deliberate grant in package.json
# (vitest needs it).
# minimumReleaseAge keeps freshly-published versions out for 3 days —
# compromised releases are typically unpublished within hours.
# Escape hatch for an urgent security bump: minimumReleaseAgeExclude.
minimumReleaseAge: 4320
```

Move the esbuild grant into `package.json` under
`pnpm.onlyBuiltDependencies: ["esbuild"]` if `pnpm ignored-builds` reports
`allowBuilds` is not honored.

Confirm the setting is honored by pnpm 10.18.3 (see command table). Then
`pnpm install` — expect no resolution changes (everything in the lockfile
is older than 3 days).

**Verify**: `pnpm install --frozen-lockfile` → exit 0; `pnpm verify` → exit 0.

### Step 5: harden the smoke install

In the ci.yml smoke step, change the install line to pin exact versions
(derive them at execution time from `pnpm ls viem typescript @types/node --depth -1`)
and block scripts:

```yaml
          npm install --ignore-scripts /tmp/vts.tgz viem@<exact> typescript@<exact> @types/node@<exact> > /dev/null
```

(`--ignore-scripts` is safe here: viem/typescript/@types/node need no
install scripts, and the tarball's own `prepare` doesn't run for tarball
installs — `prepublishOnly` already built it.) Note in a YAML comment that
these pins are maintenance-updated alongside the devDependency bumps.

**Verify**: run the smoke block locally end-to-end → `smoke ok` +
`runtime ok`.

### Step 6: Dependabot for pin freshness

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: monthly
    open-pull-requests-limit: 3
```

github-actions weekly keeps the Step 3 SHA pins updated via reviewable PRs
(Dependabot maintains the version comments); npm monthly is a nudge, with
`minimumReleaseAge` providing the freshness safety independent of it.

**Verify**: YAML parses; `pnpm verify` → exit 0 (final gate).

## Test plan

No unit tests — the gates are: attw + smoke pass locally with the hardened
invocations, `pnpm verify` green, and the greps in Steps 1/3. CI itself
confirms on the operator's next push (say so in the report).

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `@arethetypeswrong/cli` in devDependencies; zero `dlx` in workflows
- [ ] `permissions: contents: read` at ci.yml top level
- [ ] All 3 action refs are 40-char SHAs with version comments; zero `@vN` refs in ci.yml
- [ ] `minimumReleaseAge: 4320` in pnpm-workspace.yaml with the posture comment; `pnpm ignored-builds` reports none, with esbuild granted through `pnpm.onlyBuiltDependencies`
- [ ] Smoke install uses `--ignore-scripts` + exact pinned versions
- [ ] `.github/dependabot.yml` exists with both ecosystems
- [ ] Report records tag→SHA mappings used in Step 3
- [ ] `plans/README.md` status row updated

## STOP conditions

- pnpm 10.18.3 does not recognize `minimumReleaseAge` (or install behavior
  changes unexpectedly under it) — report the pnpm docs/version finding
  rather than guessing an alternative setting name.
- `pnpm exec attw` binary name differs or attw's own install requires a
  build grant — report before expanding `pnpm.onlyBuiltDependencies`.
- Any resolved action SHA cannot be verified against the official repo's
  tags — do not pin an unverifiable SHA.
- The `--ignore-scripts` smoke install breaks (a dep silently needed a
  script) — report which package, don't just drop the flag.

## Maintenance notes

- SHA pins rot without Dependabot — if Dependabot is disabled on the repo,
  the pins become a liability (stale actions); keep both or neither.
- When plan 029's `release.yml` lands, its actions follow the same SHA-pin
  convention and its foundry `version:` must stay byte-identical to
  ci.yml's — reviewers check both files on every toolchain bump.
- `minimumReleaseAge` delays intentional upgrades by 3 days too; for an
  urgent security fix, use `minimumReleaseAgeExclude` for that one package
  rather than lowering the global value.
- Rejected here deliberately: StepSecurity harden-runner (egress
  allowlisting — strong but noisy for this size), zizmor/Scorecard (nice-
  to-have; revisit if workflow count grows). Recorded in the index.
