# Plan 028: npm consumption readiness — peer-dep viem, publishable manifest, packaged-artifact CI checks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b3390e0..HEAD -- package.json README.md .github pnpm-lock.yaml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (dependency-graph change: viem becomes a peer; the suite and a new packaged-artifact smoke test are the net)
- **Depends on**: none (001-027 all DONE); plans/029 (release automation) depends on THIS
- **Category**: dx
- **Planned at**: commit `b3390e0`, 2026-07-03

## Why this matters

The library is API-stable but not consumable at all today: it has never
been published, and git-dependency installs are broken (the manifest points
at gitignored `dist/` with no `prepare` script to build it). One manifest
choice would hurt consumers even once that's fixed: `viem` is a **hard
dependency**, so every consumer gets a second nested viem — their
`PublicClient` (from their own viem) is a different type identity than the
one `TxSimulatorConfig` expects, producing baffling assignability errors
plus doubled bundle weight. Beyond that, publishing is blocked or degraded
by: no LICENSE file (despite `license: MIT`), a tarball carrying **3.3 MB
of motivation PNGs** (111 files packed), dangling sourcemaps (`dist/*.map`
reference `../src`, which isn't packed), and missing
`repository`/`sideEffects`/`engines` metadata. Finally, nothing in CI
verifies the *packaged artifact* — only the repo — so exports-map or types
resolution breakage would be discovered by the first consumer instead of by
the pipeline.

## Current state

(At `b3390e0`.)

### `package.json` (relevant excerpts, verbatim)

```json
"files": [
  "dist",
  "contracts/TxSimulator.sol",
  "docs/motivation.md",
  "docs/assets/motivation"
],
"type": "module",
"main": "./dist/index.js",
"types": "./dist/index.d.ts",
"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
"dependencies": { "viem": "^2.54.1" },
"devDependencies": { "@types/node": "^20.19.0", "oxfmt": "^0.57.0", "oxlint": "^1.72.0", "typescript": "^5.5.4", "vitest": "^2.1.9" },
"packageManager": "pnpm@10.18.3",
"pnpm": { "overrides": { "ws": ">=8.21.0" } }
```

No `repository`, `homepage`, `bugs`, `keywords`, `sideEffects`, or
`engines`. No LICENSE file in the repo root. `docs/assets/motivation` is
3.3 MB of PNGs. `npm pack --dry-run` reports 111 files.

### Environment facts

- GitHub remote: `git@github.com:frontier159/viem-tx-sim.git`.
- `dist/` is **GITIGNORED — not tracked** (`git ls-files dist` → empty). It
  exists locally as build output, which is why `npm pack` works after a
  build (pack reads the filesystem, not git). Consequences:
  - Git-dependency installs are **broken today**: `main` points at
    `dist/index.js`, absent from a fresh clone, and there is no `prepare`
    script. (Fixable cheaply — see the next fact.)
  - The CI freshness gate `git diff --exit-code -- dist src/generated` is
    **vacuous for `dist`** (git diff ignores untracked paths); only the
    `src/generated` half does anything. Step 6 fixes the pathspec.
- `src/generated/txSimulatorBytecode.ts` IS committed, so producing `dist`
  from a checkout is pure `tsc` — **no Foundry required**. That makes a
  `prepare` script viable for git-dep consumers (package managers install
  devDependencies and run `prepare` for git deps, so `typescript` is
  available).
- `dist/` contains `.js.map`/`.d.ts.map` files whose `sources` point at
  `../src/...` — unresolvable in the packed tarball today because `src` is
  not in `files`.
- The package is ESM-only (`"type": "module"`, single export condition) —
  a deliberate posture to keep, not change.
- pnpm ≥8 auto-installs peer dependencies by default, so the peer-dep move
  does not break `pnpm install` for consumers; README still instructs
  installing viem explicitly.
- CI workflow (plan 008): checkout → node 22 + corepack → pinned foundry
  nightly → `pnpm install --frozen-lockfile` → `pnpm verify` → artifact
  freshness gate.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0, lockfile updated |
| Full gate | `pnpm verify` | exit 0 |
| Pack inspection | `npm pack --dry-run` | file list + size in output |
| Types-resolution check | `pnpm dlx @arethetypeswrong/cli --pack . --profile esm-only` | no errors |

## Scope

**In scope**: `package.json`, `pnpm-lock.yaml`, `LICENSE` (create),
`README.md` (install/links/ESM note), `.github/workflows/ci.yml` (gate
pathspec fix + two added steps), `plans/README.md` (status row).
`dist/` stays gitignored — committing it is explicitly NOT part of this
plan (maintainer decision 2026-07-03: standard ignored-build-output
posture; `prepare`/`prepublishOnly` provide freshness instead).

**Out of scope**: ANY `src/`/`test/`/`contracts/` change — this plan is
pure packaging; publishing itself and version automation (plan 029); adding
a CJS build (ESM-only is the decided posture — document, don't change);
the `pnpm.overrides` ws entry (repo-local install concern, irrelevant to
consumers — leave it).

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: viem becomes a peer dependency

In `package.json`: remove `viem` from `dependencies`; add

```json
"peerDependencies": { "viem": "2.x" },
```

and add `"viem": "^2.54.1"` to `devDependencies` (this repo still needs it
to build/test). Run `pnpm install` to refresh the lockfile, then
`pnpm lint:fix` (oxfmt normalizes package.json ordering).

**Verify**: `pnpm verify` → exit 0 (viem resolves from devDependencies);
`node -e "const p=require('./package.json'); if (p.dependencies) throw new Error('deps should be empty/absent'); if (p.peerDependencies.viem !== '2.x') throw new Error('peer missing'); console.log('ok')"` → ok.

### Step 2: LICENSE file

Create `LICENSE` in the repo root with the standard MIT license text,
copyright line: `Copyright (c) 2026 frontier159`. (If the operator wants a
different legal name, that is a one-line follow-up — do not block on it.)

**Verify**: `ls LICENSE` → exists; first line contains "MIT License".

### Step 3: Manifest metadata + files trim

In `package.json` add:

```json
"repository": { "type": "git", "url": "git+https://github.com/frontier159/viem-tx-sim.git" },
"homepage": "https://github.com/frontier159/viem-tx-sim#readme",
"bugs": { "url": "https://github.com/frontier159/viem-tx-sim/issues" },
"keywords": ["ethereum", "viem", "simulation", "eth_call", "state-override", "transaction-preview", "wallet"],
"sideEffects": false,
"engines": { "node": ">=20" },
```

and change `files` to:

```json
"files": ["dist", "src", "contracts/TxSimulator.sol"]
```

— dropping both `docs/` entries (the 3.3 MB of PNGs and the motivation doc
stay in the repo, out of the tarball) and adding `src` so the shipped
sourcemaps resolve and consumers get go-to-definition (`src` is ~60 KB of
text; viem ships its `src` for the same reason). README and LICENSE are
auto-included by npm.

Also restructure the build scripts so `dist` can be produced without
Foundry (the committed bytecode makes `tsc` sufficient) and is always fresh
at install/publish time — `dist/` itself stays gitignored:

```json
"build": "pnpm build:contracts && pnpm build:ts",
"build:ts": "tsc -p tsconfig.build.json",
"prepare": "pnpm build:ts",
"prepublishOnly": "pnpm build:ts",
```

`prepare` is what makes `pnpm add github:frontier159/viem-tx-sim` work:
package managers install devDependencies and run `prepare` for git
dependencies, so `typescript` is present and `dist/` is built on the
consumer's machine — no Foundry involved. It also runs on every local
`pnpm install` (a cheap `tsc`, and CI's install step now builds `dist`
before the foundry toolchain is even set up — harmless and order-safe,
since `build:ts` needs no forge). `prepublishOnly` is the belt-and-braces
freshness guard for any manual `npm publish`. Run `pnpm lint:fix` after
editing.

**Verify**: `npm pack --dry-run 2>&1 | grep -c "\.png"` → 0;
`npm pack --dry-run 2>&1 | tail -3` → report the new totals (expect well
under 1 MB unpacked); the file list includes `LICENSE`, `README.md`,
`src/`, `dist/`, `contracts/TxSimulator.sol` and nothing under `docs/`.

### Step 4: README consumption notes

1. The motivation credit links are relative (`./docs/motivation.md`) —
   npmjs.com renders README against nothing, so switch them to the absolute
   URL `https://github.com/frontier159/viem-tx-sim/blob/main/docs/motivation.md`
   (both occurrences in the Motivation section).
2. In "Getting started", after the install command, add one short
   paragraph: the package is **ESM-only** (no CommonJS build) and requires
   Node ≥ 20; `viem` is a peer dependency, so install it alongside (the
   existing `pnpm add viem-tx-sim viem` command is already correct).
3. Add a one-line git-dependency alternative for pre-release consumers:
   `pnpm add github:frontier159/viem-tx-sim` works because the `prepare`
   script builds `dist/` with `tsc` at install time (the contract bytecode
   is committed, so Foundry is never needed on the consumer's machine).

**Verify**: `grep -c "(./docs/motivation.md)" README.md` → 0;
`grep -c "ESM" README.md` → ≥1; `pnpm lint` → exit 0.

### Step 5: Fix the freshness gate and add packaged-artifact checks in CI

First, correct the vacuous gate: in `.github/workflows/ci.yml`, change

```yaml
        run: git diff --exit-code -- dist src/generated
```

to

```yaml
        run: git diff --exit-code -- src/generated
```

(`dist` is untracked, so `git diff` never inspected it; the pathspec only
misled readers into thinking dist freshness was gated. Dist freshness is
now guaranteed structurally: `prepare` rebuilds it on install, and the
pack/smoke steps below consume the just-built output.)

Then append two steps to the `verify` job (after the freshness gate):

```yaml
      - name: types resolve from the packed tarball
        run: pnpm dlx @arethetypeswrong/cli --pack . --profile esm-only
      - name: packed tarball smoke test
        run: |
          pnpm pack --out /tmp/vts.tgz
          mkdir -p /tmp/vts-smoke && cd /tmp/vts-smoke
          npm init -y > /dev/null
          npm pkg set type=module > /dev/null
          npm install /tmp/vts.tgz viem typescript @types/node > /dev/null
          cat > smoke.ts <<'EOF'
          import { TxSimulator, OVERRIDE_TOKEN_AMOUNT } from "viem-tx-sim";
          import { createPublicClient, http } from "viem";
          const sim = TxSimulator.create({ client: createPublicClient({ transport: http("http://127.0.0.1:1") }) });
          const _check: typeof sim.simulate = sim.simulate;
          if (OVERRIDE_TOKEN_AMOUNT !== 10n ** 50n) throw new Error("constant");
          console.log("smoke ok", typeof _check);
          EOF
          npx tsc --strict --module node16 --moduleResolution node16 --target es2022 --skipLibCheck --noEmit smoke.ts
          node --input-type=module -e "import('viem-tx-sim').then(m => { if (!m.TxSimulator?.create) throw new Error('bad export'); console.log('runtime ok'); })"
```

Notes: the smoke test exercises the strictest resolution mode (`node16`)
against the REAL tarball — the thing consumers install — not the repo. The
scratch project MUST be `"type": "module"` (the `npm pkg set` line): under
node16 resolution a `.ts` file in a type-less package is CommonJS, and the
ESM-only package then *correctly* rejects static imports with TS1479 — that
would be the check working against a mis-shaped consumer, not a packaging
pass. `--skipLibCheck` is required and correct: without it, tsc
type-checks viem/ox declaration internals (which fail under node16 —
third-party noise, and every real consumer has skipLibCheck per
`tsc --init` defaults). It does NOT weaken this check — a resolution
failure of viem-tx-sim itself errors at the import site in `smoke.ts`,
which stays fully checked, and attw separately deep-checks this package's
own declarations. The runtime import runs from `/tmp/vts-smoke` (cwd
matters for resolution; the `node` line must run in that directory, as
written).

**Verify locally**: run the equivalent commands by hand
(`pnpm dlx @arethetypeswrong/cli --pack . --profile esm-only` → no errors;
the smoke block in a temp dir → both "smoke ok" and "runtime ok").
CI itself is verified after the operator pushes — say so in the report.

### Step 6: Full gate

**Verify**: `pnpm verify` → exit 0.

## Test plan

No unit tests — the packaged-artifact smoke test and attw run ARE the
tests, executed locally in Step 5 and permanently in CI thereafter.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] viem in `peerDependencies` (`2.x`) + `devDependencies`; not in `dependencies`
- [ ] `LICENSE` exists (MIT)
- [ ] `npm pack --dry-run`: zero `.png` entries; includes `src/`, `LICENSE`; report the size delta (was 111 files / ~3.4 MB)
- [ ] `sideEffects`, `engines`, `repository`, `keywords` present in the manifest
- [ ] `prepare` and `prepublishOnly` scripts present, both running `build:ts` (tsc only, no forge)
- [ ] `dist/` remains untracked (`git ls-files dist | wc -l` → 0) — do NOT commit it
- [ ] ci.yml freshness gate pathspec is `src/generated` only
- [ ] attw (`--profile esm-only`) passes locally against the packed tarball
- [ ] Smoke test passes locally (compile under node16 resolution + runtime import)
- [ ] README: absolute motivation links, ESM-only + peer-dep note, git-dep alternative
- [ ] `plans/README.md` status row updated

## STOP conditions

- The peer-dep move makes `pnpm verify` fail in a way a lockfile refresh
  doesn't fix — report the resolution error rather than pinning versions ad
  hoc.
- attw reports errors that would require restructuring the `exports` map
  (beyond adding fields) — that's a design decision; report the findings.
- The smoke test fails under `node16` resolution — likely a `.js`-specifier
  or types issue in `dist/`; report, don't patch dist by hand.

## Maintenance notes

- The viem peer range is `2.x` deliberately wide; if a future viem minor
  breaks an API this library uses, narrow the range in the same change that
  adapts to it.
- `files` now ships `src/` — if the repo ever grows large non-source assets
  under `src/`, revisit.
- Plan 029 (release automation) builds directly on this manifest; it
  publishes with provenance from CI.
