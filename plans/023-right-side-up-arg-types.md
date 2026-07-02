# Plan 023: Right-side-up argument types — public client-less Args, named types on the TxSimulator interface, file consolidation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 60d9140..HEAD -- src test README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (public type-shape change + file moves; behavior must be byte-identical, suite is the net)
- **Depends on**: none (016-022 all DONE)
- **Category**: dx
- **Planned at**: commit `60d9140`, 2026-07-03

## Why this matters

`TxSimulator` is the only public entry point, but its types are layered
upside down (maintainer finding, 2026-07-03). The exported `SimulateArgs`
includes `client` and its own JSDoc says *"Arguments for the internal
simulation implementation; public callers normally use `TxSimulator`"* — the
canonical exported name describes the internal shape. The interface then
derives its real parameter types with
`Omit<SimulateArgs, "client">` and, worse,
`Omit<Parameters<typeof discoverBalanceSlots>[0], "client">` — the discovery
functions have no named arg types at all. An integrator hovering
`sim.discoverBalanceSlots` sees a computed `Omit<{ ...inline fields... },
"client">` blob, and returns are `ReturnType<typeof simulate>` instead of
`Promise<SimulationResult>`.

Target (maintainer-specified): public named types are **client-less** and
first-class —

```ts
simulate: (args: SimulateArgs) => Promise<SimulationResult>;
```

— and the internal implementations take `XxxArgs & ClientArgs`. Along the
way, the now-trivial wrapper files collapse: `src/simulate.ts`'s body moves
into `src/txSimulator.ts`; `src/slots.ts`'s bodies move to
`src/internal/slotDiscovery.ts` (NOT into txSimulator.ts — `requirements.ts`
consumes them, and importing them from `txSimulator.ts` would create a
`requirements → txSimulator → requirements` cycle). `src/requirements.ts`
stays a separate module (263 lines of measurement logic; nothing else
gains from inlining it).

## Current state

(All at `60d9140`.)

### The upside-down layering — `src/txSimulator.ts:19-22`

```ts
type BoundSimulateArgs = Omit<SimulateArgs, "client">;
type BoundBalanceSlotsArgs = Omit<Parameters<typeof discoverBalanceSlots>[0], "client">;
type BoundAllowanceSlotsArgs = Omit<Parameters<typeof discoverAllowanceSlots>[0], "client">;
type BoundRequirementsArgs = Omit<Parameters<typeof discoverRequirements>[0], "client">;
```

and interface members like
`simulate: (args: BoundSimulateArgs) => ReturnType<typeof simulate>;`
(`:54`), `discoverBalanceSlots: (args: BoundBalanceSlotsArgs) => ReturnType<typeof discoverBalanceSlots>;`
(`:64`), etc. `create()` (`:108-128`) binds `client` and merges per-call
`gas`/`debug` over bound defaults via a `defaults()` helper using
conditional spreads — that merging logic is correct and must be preserved
verbatim.

### `SimulateArgs` — `src/types.ts:80-98`

Includes `client: PublicClient` as its first field with the
"internal implementation" JSDoc quoted above. All other fields (`from`,
`calls`, `blockNumber`, `blockTag`, `gas`, `debug`, `tokenSlotOverrides`)
are consumer-facing and keep their current JSDoc.

### The wrapper files

- `src/simulate.ts` (52 lines): validates non-empty `calls`, defaults `gas`,
  normalizes calls, runs `discoverCandidateAddresses`, maps
  `tokenSlotOverrides` to storage overrides, calls `runSimulator`. Imported
  ONLY by `txSimulator.ts`.
- `src/slots.ts` (71 lines): `discoverBalanceSlots` (maps tokens over
  `internal/probes.js` `discoverBalanceSlot`, splits `{slots, unresolved}`)
  and `discoverAllowanceSlots` (delegates to
  `internal/allowanceDiscovery.js`, splits `{slots, unresolved}`). Imported
  by `txSimulator.ts` AND `src/requirements.ts:18` (aliased
  `discoverPublicAllowanceSlots` / balance equivalent).
- `src/requirements.ts` (263 lines): `discoverRequirements` implementation;
  takes `{ client, from, calls, gas?, debug? } & BlockOptions` inline.
- Tests import only from `../src/index.js` (verified) — file moves are
  invisible to them except type names.
- `src/internal/rpc.ts` exports `RpcCallArgs = { client; gas?; debug? } & BlockOptions`
  (plan 020) — the implementation-side building block to reuse.

### Conventions

ESM `.js` specifiers; public types in `src/types.ts` with JSDoc on every
export (plan 022 standard — new types must match); internals under
`src/internal/`; tests pin exact RPC counts and amounts.

## Target design

### Types (`src/types.ts`)

1. Remove `client` from `SimulateArgs`; rewrite its type-level JSDoc as the
   *primary public* doc ("Arguments for `TxSimulator.simulate`...").
2. Add named, exported, client-less arg types (JSDoc per plan-022 standard,
   field docs carried over from the current inline declarations):

```ts
/** Arguments for `TxSimulator.discoverBalanceSlots`. */
export type DiscoverBalanceSlotsArgs = {
  from: Address;
  tokens: readonly Address[];
  gas?: bigint;
  debug?: SimulationDebug;
  blockNumber?: bigint;
  blockTag?: BlockTag;
};

/** Arguments for `TxSimulator.discoverAllowanceSlots`. */
export type DiscoverAllowanceSlotsArgs = { from; pairs: readonly AllowanceSlotPair[]; /* same optionals */ };

/** Arguments for `TxSimulator.discoverRequirements`. */
export type DiscoverRequirementsArgs = { from; calls: readonly SimulatedCall[]; /* same optionals */ };
```

3. Add the factory-config name (currently the anonymous `BoundArgs`):

```ts
/** Configuration for `TxSimulator.create`. */
export type TxSimulatorConfig = {
  client: PublicClient;
  /** Default gas budget for all calls; per-call `gas` wins. */
  gas?: bigint;
  /** Default debug setting for all calls; per-call `debug` wins. */
  debug?: SimulationDebug;
};
```

### Internal client attachment (`src/internal/rpc.ts`)

```ts
/** Attaches the bound viem client to public per-call args for internal implementations. */
export type ClientArgs = { client: PublicClient };
```

Implementation signatures become `args: SimulateArgs & ClientArgs`,
`args: DiscoverRequirementsArgs & ClientArgs`, etc.

### Interface (`src/txSimulator.ts`)

Delete all four `Bound*Args` aliases and `BoundArgs`. Members become fully
named on both sides (JSDoc bodies stay as-is):

```ts
simulate: (args: SimulateArgs) => Promise<SimulationResult>;
discoverBalanceSlots: (args: DiscoverBalanceSlotsArgs) => Promise<BalanceSlotDiscovery>;
discoverAllowanceSlots: (args: DiscoverAllowanceSlotsArgs) => Promise<AllowanceSlotDiscovery>;
discoverRequirements: (args: DiscoverRequirementsArgs) => Promise<DiscoveredRequirements>;
```

`create(config: TxSimulatorConfig): TxSimulator` — body unchanged apart from
names.

### File moves

- `src/simulate.ts` → delete; its function moves into `src/txSimulator.ts`
  as a module-private `async function runSimulate(args: SimulateArgs & ClientArgs): Promise<SimulationResult>`
  (imports come with it: `discoverCandidateAddresses`, `runSimulator`,
  constants, error, stateOverride mapping).
- `src/slots.ts` → delete; both functions move to a new
  `src/internal/slotDiscovery.ts`, renamed with signatures
  `discoverBalanceSlots(args: DiscoverBalanceSlotsArgs & ClientArgs): Promise<BalanceSlotDiscovery>`
  (same for allowance). `src/txSimulator.ts` and `src/requirements.ts`
  import from there (requirements drops the `discoverPublic*` aliases).
- `src/requirements.ts` — stays; only its exported function's signature
  changes to `DiscoverRequirementsArgs & ClientArgs` (delete its inline arg
  type).
- `src/index.ts` — add the four new type exports
  (`DiscoverBalanceSlotsArgs`, `DiscoverAllowanceSlotsArgs`,
  `DiscoverRequirementsArgs`, `TxSimulatorConfig`). Nothing else changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 (lint, typecheck, build, test; needs forge/anvil) |
| Typecheck only | `pnpm typecheck` | exit 0 |
| Focused | `pnpm build:contracts && pnpm exec vitest run` | all pass |

## Scope

**In scope**: `src/types.ts`, `src/txSimulator.ts`, `src/index.ts`,
`src/internal/slotDiscovery.ts` (create), `src/internal/rpc.ts` (add
`ClientArgs` only), `src/requirements.ts` (signature + imports only),
`src/simulate.ts` + `src/slots.ts` (delete), `test/txSimulator.test.ts`
(mock/type references only), `plans/README.md` (status row). `dist/` via
`pnpm build` only.

**Out of scope**: ANY behavior change — RPC counts, amounts, debug step
names, error semantics, and the `defaults()` gas/debug merge are frozen; all
existing test assertions must pass unmodified. `src/internal/probes.ts`,
`src/internal/allowanceDiscovery.ts` bodies. `README.md` — its examples
already show the instance style and no type names; verify no README code
imports the moved files (it doesn't) and leave it alone. `contracts/**`.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Types first

Apply the "Types" section of Target design in `src/types.ts` and add
`ClientArgs` to `src/internal/rpc.ts`. Export the four new names from
`src/index.ts`.

**Verify**: `pnpm typecheck` → fails only in
`simulate.ts`/`slots.ts`/`requirements.ts`/`txSimulator.ts` (expected).

### Step 2: Move slot discovery to internal

Create `src/internal/slotDiscovery.ts` with both functions (bodies verbatim
from `src/slots.ts`, signatures per Target design). Rewire
`src/requirements.ts` imports (drop the aliases) and change
`discoverRequirements`' signature to `DiscoverRequirementsArgs & ClientArgs`.
Delete `src/slots.ts`.

**Verify**: `pnpm typecheck` → remaining errors only in
`simulate.ts`/`txSimulator.ts`.

### Step 3: Fold simulate into txSimulator.ts

Move `src/simulate.ts`'s function into `src/txSimulator.ts` as private
`runSimulate` (signature per Target design), delete `src/simulate.ts`,
rewrite the interface + `create()` per Target design (deleting all `Bound*`
aliases; `defaults()` merge preserved verbatim).

**Verify**: `pnpm typecheck` → exit 0;
`ls src/simulate.ts src/slots.ts` → both "No such file";
`grep -rn "Parameters<typeof\|ReturnType<typeof\|Omit<" src/txSimulator.ts` → no matches.

### Step 4: Test touch-ups + hover sanity

Fix `test/txSimulator.test.ts` type references if the compile-time
mockability check names old types (the `const fake: TxSimulator` check must
still typecheck). Hover-proxy check: intentionally pass a `client` key to
`sim.simulate({...})` in a scratch expression — it must be a compile error
(excess property) — then remove the scratch.

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass,
identical test counts, zero assertion edits (`git diff -- test` shows only
import/type lines).

### Step 5: Full gate

**Verify**: `pnpm verify` → exit 0.

## Test plan

No new tests: this is a type-topology and file-layout change with zero
behavior delta. The gates are (a) the untouched suite passing, (b) the
`grep` proving no type gymnastics remain in the interface, (c) the
excess-property compile check in Step 4.

## Done criteria

- [ ] `pnpm verify` exits 0; `git diff -- test` contains no assertion changes
- [ ] `src/simulate.ts` and `src/slots.ts` deleted; `src/internal/slotDiscovery.ts` exists
- [ ] `grep -rn "Omit<\|Parameters<typeof\|ReturnType<typeof" src/txSimulator.ts` → no matches
- [ ] `grep -n "client" src/types.ts` → only in `TxSimulatorConfig` (SimulateArgs and the three Discover*Args are client-less)
- [ ] Package root exports `DiscoverBalanceSlotsArgs`, `DiscoverAllowanceSlotsArgs`, `DiscoverRequirementsArgs`, `TxSimulatorConfig`
- [ ] No import cycle: `grep -n "txSimulator" src/requirements.ts src/internal/*.ts` → no matches
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any existing test assertion (amounts, RPC counts, statuses) needs editing
  — behavior moved; revert the step and report.
- Avoiding the `requirements → txSimulator` cycle appears to require a
  different arrangement than `internal/slotDiscovery.ts` — report the
  conflict instead of inventing a new topology.
- The excess-property check in Step 4 does NOT error (would mean `client`
  snuck back into a public arg type).

## Maintenance notes

- The rule this plan establishes: **public arg types never contain
  `client`**; implementations take `PublicArgs & ClientArgs`. New methods
  follow it — reviewers should reject any `Omit<...>` reappearing in the
  interface.
- `src/txSimulator.ts` is now interface + factory + the simulate
  implementation (~180 lines). If it grows past ~250 lines, move
  `runSimulate` to `src/internal/` alongside `slotDiscovery.ts` rather than
  splitting the interface.
- JSDoc on the interface methods is untouched by design; if arg fields
  change later, both the type JSDoc (types.ts) and the method JSDoc must
  move together (plan-022 rule).
