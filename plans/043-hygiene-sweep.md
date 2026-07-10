# Plan 043: Hygiene sweep — parallel override preparation, strict word parsing, dead aliases, honest version floors, CI pnpm cache

> **Executor instructions**: Follow this plan step by step. Each step is
> independent; run its verification before the next. If anything in the
> "STOP conditions" section occurs, stop, revert the failing step's changes,
> mark this plan BLOCKED with what you found, and report. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 8931d7e..HEAD -- src/internal/requirements.ts src/internal/probes.ts src/internal/slots.ts src/internal/rpc.ts src/txSimulator.ts package.json .github/workflows/ci.yml`
> Plan 039 (recommended to land first) touches `requirements.ts` and
> `rpc.ts` — that drift is expected (the classifier region, not the regions
> below). Anything else changed: compare "Current state" excerpts and STOP
> on mismatch.

## Status

- **Priority**: P3
- **Effort**: S (a batch of verified small items)
- **Risk**: LOW overall. The one behavioral edge: Step 2 changes how
  >32-byte probe returndata parses (strictly safer); Step 1 overlaps two
  independent RPC fan-outs (counts unchanged, ordering deterministic).
- **Depends on**: 039 (same-file ordering only; no logical dependency)
- **Category**: tech-debt / perf / dx
- **Planned at**: commit `8931d7e`, 2026-07-10

## Why this matters

Seven small, individually-verified items that don't merit standalone plans:
`estimateRequirements` serializes two independent RPC fan-outs (one full
round-trip of avoidable latency per estimate); probe reads parse the entire
returndata with `BigInt`, over-reading non-standard tokens that return more
than one word; three leftover alias exports and one dead type add
navigation noise; the viem peer range `2.x` promises versions (2.0–2.7)
that provably cannot compile against the code's `StateOverride` import
(first exported in viem 2.8.0); the declared TypeScript floor `^5.5.4` is
tested nowhere (CI's smoke test pins 5.9.3); and CI re-downloads the entire
pnpm store on every run.

## Current state

All verified at `8931d7e`:

- `src/internal/requirements.ts:72-87` — sequential awaits; neither result
  feeds the other (`tokens`/`spenders` are computed above at lines 67-70;
  results only meet at line 94's concatenation):

```ts
  const balanceOverrides = await prepareBalanceOverrides({
    client: args.client,
    from: args.from,
    tokens,
    ...
  });
  const allowanceOverrides = await prepareAllowanceOverrides({
    client: args.client,
    from: args.from,
    pairs: allowancePairs(tokens, spenders),
    ...
  });
```

- `src/internal/probes.ts:175-177` (inside `readUint256Call`):

```ts
    const data = getCallData(result);
    if (data.length < 66) return undefined;
    return BigInt(data);
```

  `BigInt` consumes the full hex string; a token returning >32 bytes parses
  to a wrong huge number. Both callers compare against a sentinel, so today
  this only causes false-negative slot discovery — but it should read one
  word, matching the ghost contract's own `abi.decode(data, (uint256))`.

- `src/internal/slots.ts:198-199`:

```ts
export const prepareBalanceTokenOverrides = prepareBalanceOverrides;
export const prepareAllowanceTokenOverrides = prepareAllowanceOverrides;
```

- `src/internal/requirements.ts:150`:

```ts
export const estimateTokenOverrideRequirements = estimateAssetRequirements;
```

- `src/txSimulator.ts:7,10` imports only the alias names
  (`estimateTokenOverrideRequirements`,
  `prepareAllowanceTokenOverrides, prepareBalanceTokenOverrides`) and uses
  them at lines 171-179.
- `src/internal/rpc.ts:65` — `export type AccessListEntry =
  AccessList[number];` has zero references anywhere else. `rpc.ts:154`
  `emitDebug` is exported but used only within `rpc.ts`. (Leave
  `BlockOptions` exported — it appears in exported function signatures.)
- `package.json:63` `"typescript": "^5.5.4"`; `:67-69` `"peerDependencies":
  { "viem": "2.x" }`. `src/internal/rpc.ts:8` and
  `src/internal/simulator.ts:1` import the `StateOverride` type from viem,
  first re-exported from viem's root in 2.8.0. CI's smoke test
  (`.github/workflows/ci.yml:39`) installs `typescript@5.9.3`.
- `.github/workflows/ci.yml:15-20`:

```yaml
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          # keep in lockstep with release.yml
          node-version: 24.18.0
      - run: corepack enable
```

  No `cache:` key; `pnpm install --frozen-lockfile` starts cold every run.

Conventions: tests pin per-operation RPC counts and debug-step counts —
Step 1 must not change any count (it only overlaps the same calls). Actions
stay SHA-pinned (plan 030 posture); this plan adds NO new action.

## Commands you will need

| Purpose   | Command          | Expected on success |
|-----------|------------------|---------------------|
| Install   | `pnpm install`   | exit 0              |
| Typecheck | `pnpm typecheck` | exit 0              |
| Lint      | `pnpm lint`      | exit 0              |
| Full gate | `pnpm verify`    | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/internal/requirements.ts` (Steps 1, 3)
- `src/internal/probes.ts` (Step 2)
- `src/internal/slots.ts` (Step 3)
- `src/txSimulator.ts` (Step 3)
- `src/internal/rpc.ts` (Step 4)
- `package.json` (Step 5)
- `.github/workflows/ci.yml` (Step 6)
- `.changeset/` (Step 7, new file)

**Out of scope** (do NOT touch):
- `pnpm-lock.yaml` beyond what `pnpm install` regenerates for the
  `typescript` floor bump (run `pnpm install` after editing package.json;
  commit the resulting lockfile change).
- `release.yml` — the cache change applies to ci.yml only (release jobs are
  rare; keep the security-reviewed file untouched).
- Public exports in `src/index.ts` / `src/types.ts` — the removed aliases
  are internal (non-barrel) names only.
- The debug-step vocabulary, any test file, any contract.

## Git workflow

- Branch: `plan-043-hygiene-sweep`
- One commit per step (or logical pair); message style matches `git log`.
- Changeset: yes (Step 7) — patch.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Parallelize the two override preparations

In `src/internal/requirements.ts`, wrap the two `await`s (lines 72-87) in
one `Promise.all`:

```ts
  const [balanceOverrides, allowanceOverrides] = await Promise.all([
    prepareBalanceOverrides({ ... unchanged args ... }),
    prepareAllowanceOverrides({ ... unchanged args ... }),
  ]);
```

Arguments byte-identical to today; nothing else in the function moves.

**Verify**: `pnpm verify` → exit 0 (the pinned RPC-count tests in `test/requirements.test.ts` must pass unchanged — same calls, merely overlapped).

### Step 2: Parse exactly one word in `readUint256Call`

In `src/internal/probes.ts`, change line 177 to parse only the first
32-byte word:

```ts
    return BigInt(data.slice(0, 66));
```

(`data` is `0x` + hex; 66 chars = one word. The `< 66` guard above stays.)

**Verify**: `pnpm verify` → exit 0.

### Step 3: Delete the alias exports

- Delete `src/internal/slots.ts:198-199` and
  `src/internal/requirements.ts:150`.
- In `src/txSimulator.ts`, change the imports and call sites to the
  canonical names: `prepareBalanceOverrides`, `prepareAllowanceOverrides`
  (from `./internal/slots.js`), `estimateAssetRequirements` (from
  `./internal/requirements.js`).

**Verify**: `pnpm typecheck` → exit 0; `grep -rn "TokenOverrides = \|estimateTokenOverrideRequirements" src/` → no matches.

### Step 4: Remove dead internal surface in rpc.ts

- Delete `export type AccessListEntry = AccessList[number];` (line 65). If
  the `AccessList` import then becomes unused, remove it from the import
  list (check first — it is still used by `AccessListRpcResult` and
  `createAccessList`'s return type, so likely it stays).
- Change `export function emitDebug(` to `function emitDebug(` (it has no
  callers outside `rpc.ts`).

**Verify**: `pnpm typecheck` → exit 0; `grep -rn "AccessListEntry" src/ test/` → no matches.

### Step 5: Honest version floors in package.json

- `peerDependencies.viem`: `"2.x"` → `"^2.8.0"` (the code's `StateOverride`
  type import requires ≥2.8.0; `^2.8.0` still allows every 2.x from there).
- `devDependencies.typescript`: `"^5.5.4"` → `"^5.9.0"` (matches the floor
  CI's smoke test actually exercises; the declared 5.5 floor was never
  tested anywhere).
- Run `pnpm install` to refresh the lockfile.

**Verify**: `pnpm verify` → exit 0; `pnpm exec attw --pack . --profile esm-only` → exit 0.

### Step 6: Cache the pnpm store in CI

In `.github/workflows/ci.yml`, enable setup-node's built-in pnpm cache.
`cache: pnpm` requires pnpm on PATH before setup-node runs, so move the
corepack step above it:

```yaml
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
      - run: corepack enable
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          # keep in lockstep with release.yml
          node-version: 24.18.0
          cache: pnpm
```

No new actions, no SHA changes, `release.yml` untouched.

**Verify**: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"` (or any YAML parse) → no error; `grep -c "cache: pnpm" .github/workflows/ci.yml` → 1; `grep -c "cache" .github/workflows/release.yml` → 0.

### Step 7: Changeset

`pnpm changeset` → patch. Suggested text: "Internal: overlap balance and
allowance override preparation in `estimateRequirements` (same RPC calls,
lower latency); probe reads parse exactly one 32-byte word. Packaging:
viem peer dependency floor corrected to `^2.8.0` (the previous `2.x` range
included versions the types cannot compile against)."

**Verify**: `ls .changeset/*.md` shows the new file; `pnpm verify` → exit 0.

## Test plan

No new tests: Step 1 is pinned by the existing per-operation RPC-count and
result-value tests in `test/requirements.test.ts` (which is the point of
those pins); Step 2 by the existing sentinel-verification suites plus the
short-returndata test in `test/errors.test.ts:117-131`; Steps 3-6 are
compile-time/config changes gated by `pnpm typecheck`, grep, and CI itself.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm verify` exits 0
- [ ] `grep -rn "estimateTokenOverrideRequirements\|prepareBalanceTokenOverrides\|prepareAllowanceTokenOverrides\|AccessListEntry" src/ test/` → no matches
- [ ] `grep -n '"viem": "\^2.8.0"' package.json` → 1 match (peerDependencies)
- [ ] `grep -c "cache: pnpm" .github/workflows/ci.yml` → 1; `release.yml` unmodified (`git diff --stat -- .github/workflows/release.yml` empty)
- [ ] `pnpm exec attw --pack . --profile esm-only` exits 0
- [ ] A new patch changeset exists
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any pinned RPC-count or delta assertion fails after Step 1 (would mean
  the two preparations were not independent after all).
- Any test fails after Step 2 (would mean something legitimately depends on
  over-long returndata parsing).
- Step 3 reveals an importer of the alias names outside `src/txSimulator.ts`.
- `cache: pnpm` fails in CI because pnpm is unavailable at setup-node time
  even after reordering — revert Step 6 and report (do not add a new
  action to fix it; that changes the plan-030 supply-chain posture).
- The `typescript` floor bump changes `dist/` type output (attw or the
  packed-tarball smoke test fails).

## Maintenance notes

- The viem peer floor is now truthful but still untested below 2.54.x; if a
  consumer reports a pre-2.54 breakage, consider raising the floor rather
  than adding compat code (recorded as accepted risk).
- `release.yml` deliberately has no cache; if release wall time ever
  matters, replicate Step 6 there in its own reviewed change.
- Reviewer: confirm Step 1 changed no argument values — only the awaiting
  structure.
