# Plan 008: Add a CI verification baseline (GitHub Actions, pinned toolchain, anvil hygiene)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7f94c6f..HEAD -- package.json test/helpers/anvil.ts .github`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `7f94c6f`, 2026-07-02

## Why this matters

The repo has no CI at all (`.github/` does not exist). Every "typecheck, lint,
and tests pass" claim is a manual run on one developer machine, with whatever
anvil/forge version happens to be on PATH. For a published-shaped library whose
output wallets display to users before they sign, an unverified default branch
is the single biggest process risk, and it blocks trustworthy review of every
other planned change. This plan adds a GitHub Actions workflow with a pinned
toolchain, a one-command `pnpm verify` target, a committed-`dist/` freshness
gate, and fixes a test-helper bug that leaks orphaned anvil processes.

## Current state

- No `.github/` directory exists (verified 2026-07-02).
- `package.json` scripts (no aggregate target):

```json
"build": "pnpm build:contracts && tsc -p tsconfig.build.json",
"build:contracts": "forge build && node scripts/generate-txsim-bytecode.mjs",
"lint": "oxlint && oxfmt --check package.json .oxlintrc.json .oxfmtrc.json tsconfig.json tsconfig.build.json vitest.config.ts src test scripts",
"test": "pnpm build:contracts && vitest run",
"typecheck": "tsc -p tsconfig.json --noEmit"
```

  `"packageManager": "pnpm@10.18.3"` is set. Node 20+ required (README).
- The Foundry toolchain is **nightly** and load-bearing: the local version is
  `1.7.2-nightly` (both `forge` and `anvil`), and the test suite depends on
  nightly anvil behavior where a reverting `eth_createAccessList` returns the
  access list instead of throwing (older stable anvil throws — plan-007-era
  tests removed their workaround shim on this basis). CI must install a
  **specific pinned nightly**, not `stable` and not floating `nightly`.
- `dist/` and `src/generated/txSimulatorBytecode.ts` are **committed** build
  artifacts (`package.json` `files` publishes `dist`). Nothing currently
  catches a PR whose `src/` changed but whose `dist/` is stale.
- Orphaned-anvil bug in `test/helpers/anvil.ts:47-70`: `startAnvil()` spawns
  the process, then awaits `waitForAnvil(...)`. If that throws (10s timeout or
  early exit race), the function throws **without killing the spawned
  process** — the `stop()` closure is only created in the success return:

```ts
export async function startAnvil(): Promise<AnvilTestContext> {
  const port = await freePort();
  const process = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = `http://127.0.0.1:${port}`;
  const publicClient = makePublicClient(url);
  const walletClient = makeWalletClient(url);

  await waitForAnvil(publicClient, process);   // throws -> anvil leaks

  return { /* ..., stop: () => { process.kill(); } */ };
}
```

- Conventions: TypeScript ESM with `.js` specifiers; oxfmt formats
  `package.json` too (run `pnpm lint:fix` after editing it).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Build | `pnpm build` | exit 0 (needs `forge`) |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | all pass (needs `anvil`) |
| Workflow syntax | `gh workflow list` after push, or any YAML linter locally | parses |

## Scope

**In scope** (the only files you should modify/create):

- `.github/workflows/ci.yml` (create)
- `package.json` (add `verify` script only)
- `test/helpers/anvil.ts` (orphan fix only)
- `README.md` (one sentence pointing at `pnpm verify`; optional CI badge)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Everything under `src/`, `contracts/`, `dist/`, `src/generated/`.
- `test/*.test.ts` — no test logic changes; only the helper.
- Publishing/release automation — CI here verifies, it does not publish.
- `test:mainnet` in CI — it needs a secret RPC URL; leave it out entirely
  rather than wiring secrets.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `verify` script

In `package.json` scripts, add:

```json
"verify": "pnpm lint && pnpm typecheck && pnpm build && pnpm test"
```

Run `pnpm lint:fix` afterward so oxfmt normalizes `package.json` ordering.

**Verify**: `pnpm verify` → exits 0 end-to-end locally.

### Step 2: Fix the orphaned-anvil leak

In `test/helpers/anvil.ts`, wrap the wait so a startup failure kills the child:

```ts
try {
  await waitForAnvil(publicClient, process);
} catch (cause) {
  process.kill();
  throw cause;
}
```

(Only kill on the failure path — keep the success path unchanged. `process` is
the local `ChildProcess` variable, not the Node global; the shadowing already
exists in this file, do not rename it in this plan.)

**Verify**: `pnpm test` → all pass (behavioral no-op on the happy path). Then
`grep -n "process.kill" test/helpers/anvil.ts` → 2 occurrences.

### Step 3: Create `.github/workflows/ci.yml`

```yaml
name: ci
on:
  push:
    branches: [main]
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
          version: <PINNED NIGHTLY — see below>
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
      - name: committed artifacts are fresh
        run: git diff --exit-code -- dist src/generated
```

Pinning notes:

- Node 22 satisfies the README's "pnpm 10 needs Node 20/22.13+" guidance;
  `corepack enable` makes the `packageManager` pin authoritative.
- Foundry version: run `forge --version` locally and use the exact nightly tag
  it reports (local is `1.7.2-nightly`; the toolchain action accepts
  `nightly-<commit-sha>` tags — find the matching tag via
  `forge --version`'s commit hash). **Do not use `stable`** (tests rely on
  nightly anvil access-list-on-revert behavior) and do not use floating
  `nightly` (defeats reproducibility). If the exact local tag cannot be
  determined, pin the most recent `nightly-<sha>` release of foundry and note
  it in your report.
- The artifacts-freshness step catches PRs whose `src/` or `contracts/`
  changed without rebuilding committed `dist/`/`src/generated/`.

**Verify**: YAML parses (any local YAML check). Full CI verification only
happens after the operator pushes — state that in your report rather than
claiming CI is green.

### Step 4: README pointer

In `README.md`'s Development section, after the `pnpm build` / `pnpm test`
block, add one sentence: run `pnpm verify` to execute the full local gate
(lint, typecheck, build, tests) that CI runs.

**Verify**: `pnpm lint` → exit 0.

## Test plan

No new test files. The gate itself is the deliverable: `pnpm verify` green
locally, the workflow file well-formed, and the anvil-leak fix covered by the
existing suite still passing (the failure path is exercised only when anvil
breaks — acceptable to leave untested).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm verify` exits 0
- [ ] `.github/workflows/ci.yml` exists, includes `--frozen-lockfile`, a pinned foundry version string (not `stable`, not bare `nightly`), and the `git diff --exit-code -- dist src/generated` step
- [ ] `grep -c "process.kill" test/helpers/anvil.ts` → 2
- [ ] `git status --porcelain` shows changes only to in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm verify` fails at baseline before your changes — the tree is broken;
  report, don't fix unrelated failures.
- You cannot determine any pinned foundry nightly tag at all (report the
  local `forge --version` output).
- The anvil fix requires touching test files beyond `test/helpers/anvil.ts`.

## Maintenance notes

- When the foundry nightly pin goes stale (anvil behavior changes again),
  update the single `version:` line — that is the point of pinning.
- If publishing automation is added later, keep verify and publish as separate
  workflows; this one must stay runnable on forks without secrets.
- `test:mainnet` stays manual by design; if a scheduled mainnet job is wanted
  later, it needs a repo secret and should be a separate non-blocking workflow.
