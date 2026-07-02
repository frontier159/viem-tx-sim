# Plan 014: Add CLAUDE.md architecture brief and fix two documentation defects

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7f94c6f..HEAD -- README.md docs CLAUDE.md AGENTS.md`
> The README is actively edited; verify the broken link described below still
> exists (`grep -n ".docs/motivation.md" README.md`) — if it's already fixed,
> skip Step 2 and note it.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx + docs
- **Planned at**: commit `7f94c6f`, 2026-07-02

## Why this matters

This repo's changes are executed largely by agents from plans (001–013 so
far), and every executor currently re-derives the architecture from scratch:
what the ghost contract is, why slot discovery exists, what the checkpoint
stride means, which behaviors tests pin. A short CLAUDE.md is the
highest-leverage onboarding artifact for that workflow. Two concrete doc
defects ride along: the README's motivation credit links to
`.docs/motivation.md` (nonexistent path — missing `/`), and
`docs/motivation.md` describes the original *automatic retry* design without
noting the shipped API made forging explicit — actively misleading for
newcomers who read it as current design rationale.

## Current state

- No `CLAUDE.md` or `AGENTS.md` exists in the repo root.
- `README.md` motivation section (near the top) contains:

```markdown
Credit to [apoorv X thread](https://x.com/apoorveth/status/2041544070481449266)
Transcribed [here](.docs/motivation.md)
```

  `.docs/motivation.md` is a broken relative link; the file is
  `./docs/motivation.md`.
- `docs/motivation.md` is a transcription of the motivating X thread. Post 9
  (~lines 131-141) says "We retry with 'storage slot overrides'" — accurate
  history, but the shipped API does NOT auto-retry: `simulate()` is a single
  pass and callers forge explicitly via `discoverBalanceSlots` /
  `discoverAllowanceSlots` / `tokenSlotOverrides` (README "Forging balances
  and allowances" section states this).
- Architecture facts for the CLAUDE.md (verified this audit): TypeScript ESM
  library, single runtime dep viem; Foundry compiles
  `contracts/TxSimulator.sol` and `scripts/generate-txsim-bytecode.mjs`
  inlines the deployed bytecode into `src/generated/txSimulatorBytecode.ts`
  (generated — never hand-edit); `dist/` is committed and published; core
  flow = `eth_createAccessList` per call for candidate discovery, then one
  `eth_call` injecting the simulator bytecode AT the user's address via state
  override; slot discovery = access-list probe of `balanceOf`/`allowance`
  calldata + sentinel-verify (sentinel 10^50); `discoverRequirements` =
  recon sim → slot discovery (with keccak base-slot inference in
  `src/internal/layout.ts`, fallback probing) → measurement sim with
  `AllowanceProbe[]`, per-call allowance checkpoints (flattened, stride =
  calls+1, row-major per probe) and per-call min-balance tracking for gross
  outflows; commands = `pnpm build/typecheck/lint/test` (tests spawn one
  anvil per test, Foundry NIGHTLY required for access-list-on-revert
  behavior); tests pin exact RPC call counts via debug events — refactors
  must not change call counts; plans workflow lives in `plans/README.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Lint | `pnpm lint` | exit 0 |
| Full tests | `pnpm test` | all pass |

## Scope

**In scope**:

- `CLAUDE.md` (create, repo root)
- `README.md` (fix one link)
- `docs/motivation.md` (add one historical-status note)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Any code file.
- Rewording any transcribed post content in motivation.md.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Write `CLAUDE.md`

~60-90 lines, from the facts in "Current state" (do not invent beyond them).
Sections:

1. **What this is** — 2 sentences (RPC-only tx simulation; ghost contract at
   the user's address).
2. **Architecture** — the core flow; the bytecode generation pipeline and the
   never-hand-edit rule for `src/generated/`; committed `dist/`.
3. **Key modules** — one line each: `src/simulate.ts`, `src/slots.ts`,
   `src/requirements.ts`, `src/internal/{probes,layout,simulator,discovery,rpc}.ts`,
   `contracts/TxSimulator.sol`.
4. **Invariants tests pin** — exact RPC call counts via debug events; exact
   delta/requirement amounts; checkpoint stride math; sentinel value 10^50 is
   deliberately non-max (allowance decrements must still fire).
5. **Commands** — build/typecheck/lint/test (+`verify` if plan 008 landed);
   Foundry nightly + anvil-per-test note; `test:mainnet` is opt-in via
   `MAINNET_RPC_URL`.
6. **Plans workflow** — changes are specified in `plans/`, executed per plan,
   status tracked in `plans/README.md`.

**Verify**: file exists; `pnpm lint` → exit 0 (CLAUDE.md isn't in the oxfmt
list, so this just confirms nothing else broke).

### Step 2: Fix the README link

Change `[here](.docs/motivation.md)` → `[here](./docs/motivation.md)`.
Touch nothing else in the file.

**Verify**: `grep -c ".docs/motivation.md" README.md` → 0;
`grep -c "./docs/motivation.md" README.md` → ≥1.

### Step 3: Historical note in motivation.md

Immediately after the intro paragraph (before "## Post 1"), add:

```markdown
> **Historical note**: this thread describes the original design, in which
> the simulator retried automatically with forged balances and allowances
> (post 9). The shipped library made that explicit instead: `simulate()` is
> a single pass, and callers opt into forging via `discoverBalanceSlots()` /
> `discoverAllowanceSlots()` / `discoverRequirements()` — see the README.
```

Do not modify any transcribed post text.

**Verify**: `pnpm lint` → passes.

## Test plan

No new tests. `pnpm lint` after Step 3 is the acceptance check; full
`pnpm test` as the final regression gate.

## Done criteria

- [ ] `CLAUDE.md` exists with the six sections above
- [ ] `grep -c ".docs/motivation.md" README.md` → 0
- [ ] motivation.md contains the historical note; `pnpm lint` passes
- [ ] `pnpm test` exits 0
- [ ] `git status --porcelain` shows changes only to in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any fact in Step 1's outline contradicts what you find in the code — the
  brief must be written from the code, not from this plan; report the
  discrepancy and write the code's version.

## Maintenance notes

- CLAUDE.md rots fastest at "Invariants tests pin" and "Commands" — whoever
  changes the debug-event system or scripts updates it in the same PR.
- If AGENTS.md becomes the preferred convention later, symlink or duplicate;
  don't maintain two divergent briefs.
