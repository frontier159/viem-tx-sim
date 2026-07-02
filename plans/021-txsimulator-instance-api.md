# Plan 021: Add the TxSimulator instance API (interface + companion `TxSimulator.create()`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0031a..HEAD -- src test README.md`
> Plans 016-019 must be DONE (check `plans/README.md`) — this plan wraps the
> surface they settle (renamed fields, `{slots, unresolved}` discovery
> returns, discriminated results). STOP if any is not DONE.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW-MED (additive wrapper; small chance of drift between bound and free surfaces)
- **Depends on**: plans/016, 017, 018, 019 (surface must be final); before plans/022 (docs pass documents this)
- **Category**: dx (maintainer-accepted direction finding, 2026-07-02 audit)
- **Planned at**: commit `ed0031a`, 2026-07-02

## Why this matters

Every public function takes the same preamble — `client`, plus optional
`gas`/`debug` — and the README examples repeat them at every call. The
maintainer has chosen an idiomatic TS companion-object pattern as the primary
API: an exported `interface TxSimulator` plus a same-named `const TxSimulator`
value with a `create()` factory. Benefits: one place to bind `client` and
default `gas`/`debug`; a structural interface consumers can mock in their own
tests; and — deliberately — the closure inside `create()` is where a future
slot cache slots in without any API change (a deferred audit finding).

Decided design constraints (do not relitigate):

- **`from` stays per-call.** Wallets switch accounts; binding the account
  would force an instance per account for no benefit.
- **Method and type names are the existing ones** (`simulate`,
  `discoverBalanceSlots`, `discoverAllowanceSlots`, `discoverRequirements`;
  `XxxArgs`/`XxxResult`). No `Req`/`Resp` or `find*` renames.
- **The instance API is the ONLY public surface.** Maintainer decision
  (2026-07-02): pre-prod, one way to do things — supporting both a bound and
  a free-function surface is confusing. The four functions keep their
  module-level `export` keywords (modules import each other:
  `requirements.ts` imports from `slots.ts`, `txSimulator.ts` imports all
  four) but are REMOVED from `src/index.ts`. Package consumers see only
  `TxSimulator`, the error classes, the types, and (post-022) the constants.
- **No cache in this plan.** The factory is the seam; the cache is a
  separate, deferred decision.

## Current state

(Post-019 surface; verify signatures in the live code, not here.)

- `src/index.ts` exports the four free functions, error classes, and types.
- Free-function args: each takes `{ client: PublicClient; ...; gas?: bigint; debug?: SimulationDebug } & BlockOptions`
  — `simulate(args: SimulateArgs)`, `discoverRequirements({client, from, calls, ...})`,
  `discoverBalanceSlots({client, from, tokens, ...})`,
  `discoverAllowanceSlots({client, from, pairs, ...})` (post-016 names,
  post-019 `{slots, unresolved}` returns).
- Repo conventions: ESM `.js` specifiers, public types in `src/types.ts`,
  arrow-property interface style is new — match the maintainer's sketch:

```ts
export interface TxSimulator {
  simulate: (args: /* per-call args */) => Promise<SimulationResult>;
  ...
}

export const TxSimulator = {
  create(args: { client: PublicClient; gas?: bigint; debug?: SimulationDebug }): TxSimulator { ... }
};
```

  (Interface + same-named const is TS declaration merging of a type and a
  value — intentional; both export under one name.)

## Target design

New file `src/txSimulator.ts`:

```ts
import type { PublicClient } from "viem";
import type { SimulationDebug, /* arg/result types */ } from "./types.js";
import { simulate } from "./simulate.js";
import { discoverAllowanceSlots, discoverBalanceSlots } from "./slots.js";
import { discoverRequirements } from "./requirements.js";

type Bound = { client: PublicClient; gas?: bigint; debug?: SimulationDebug };

export interface TxSimulator {
  simulate: (args: Omit<SimulateArgs, "client">) => Promise<SimulationResult>;
  discoverBalanceSlots: (args: Omit<Parameters<typeof discoverBalanceSlots>[0], "client">) => ReturnType<typeof discoverBalanceSlots>;
  discoverAllowanceSlots: (args: Omit<Parameters<typeof discoverAllowanceSlots>[0], "client">) => ReturnType<typeof discoverAllowanceSlots>;
  discoverRequirements: (args: Omit<Parameters<typeof discoverRequirements>[0], "client">) => ReturnType<typeof discoverRequirements>;
}

export const TxSimulator = {
  create(bound: Bound): TxSimulator {
    const defaults = (args: { gas?: bigint; debug?: SimulationDebug }) => ({
      gas: args.gas ?? bound.gas,
      debug: args.debug ?? bound.debug,
    });
    return {
      simulate: (args) => simulate({ ...args, ...defaults(args), client: bound.client }),
      /* same shape for the other three */
    };
  },
};
```

Semantics to preserve exactly:

- Per-call `gas`/`debug` **override** the bound defaults (`args.gas ?? bound.gas`).
- `undefined` handling: never pass an explicit `undefined` that would differ
  from omission — build the forwarded object with conditional spreads
  (matching the repo's existing `...(x !== undefined ? { x } : {})` idiom) if
  `Omit`+spread would otherwise introduce `gas: undefined` keys. The free
  functions currently treat `undefined` and absent identically (`??`
  defaults), so plain spreads are acceptable — verify once and note it.
- Consider extracting named per-call arg types into `src/types.ts` (e.g.
  `BoundSimulateArgs = Omit<SimulateArgs, "client">`) ONLY if the
  `Parameters<typeof fn>` form produces unreadable hover types — prefer
  simple named aliases in that case; the four free functions' arg objects
  are currently inline types, so introducing named `XxxArgs` types in
  `types.ts` for slots/requirements (mirroring `SimulateArgs`) is in scope
  if needed for a clean interface.

`src/index.ts`: add `export { TxSimulator } from "./txSimulator.js";`
(exports both the interface and the const under the merged name) and
**remove** the `simulate`, `discoverBalanceSlots`, `discoverAllowanceSlots`,
`discoverRequirements` exports. Error classes and all type exports stay.

README: rewrite every example to the instance style — create once
(`const sim = TxSimulator.create({ client })`), then `sim.simulate({...})`,
`sim.discoverBalanceSlots({...})`, etc. No mention of free functions; they
are no longer part of the public API.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 |
| Focused | `pnpm build:contracts && pnpm exec vitest run test/txSimulator.test.ts` | all pass |

## Scope

**In scope**: `src/txSimulator.ts` (create), `src/types.ts` (named bound-arg
aliases only if needed), `src/index.ts`, `test/txSimulator.test.ts` (create),
`test/simulate.test.ts`, `test/requirements.test.ts`, `test/errors.test.ts`,
`test/mainnet.test.ts` (migrate imports/call style — see Step 2),
`README.md`, `plans/README.md` (status row). `dist/` via build.

**Out of scope**: the four functions' bodies and signatures — the instance
is a pure wrapper; any change needed there means a STOP. Their module-level
`export` keywords stay (internal imports need them). No cache, no
memoization, no state beyond the bound fields. `CLAUDE.md` (plan 022 updates
docs holistically). Existing test ASSERTIONS — call-style migration only;
every expected value and RPC-count stays byte-identical.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: `src/txSimulator.ts` + export

Implement per Target design. Keep it under ~80 lines; no logic beyond
argument merging.

**Verify**: `pnpm typecheck` → exit 0;
`node -e "import('./dist/index.js').then(m => { if (typeof m.TxSimulator?.create !== 'function') throw new Error('missing'); console.log('ok'); })"`
after `pnpm build` → `ok`.

### Step 2: Migrate existing tests to the instance API

The four existing test files import the free functions from
`../src/index.js`, which no longer exports them. Migrate mechanically: in
each file's setup, after `startAnvil()`, build
`const sim = TxSimulator.create({ client: ctx.publicClient })` and replace
`simulate({ client: ctx.publicClient, ... })` with `sim.simulate({ ... })`
(likewise the discover calls; drop only the `client` key). Tests that pass a
per-call `debug` collector keep doing so — per-call args still accept it.
Do NOT change any assertion. (Alternative — importing from the source
modules directly, e.g. `../src/simulate.js` — is rejected: tests must
exercise the public surface.)

**Verify**: `pnpm build:contracts && pnpm exec vitest run` → all pass with
identical test counts and unchanged assertions
(`git diff -- test | grep -c "toContainEqual\|toHaveLength\|toBe("` shows
only context lines, no assertion edits — eyeball the diff).

### Step 3: `test/txSimulator.test.ts`

Model on `test/simulate.test.ts` setup (anvil per test, deploy helper).
Tests:

1. **bound client works end-to-end**: `TxSimulator.create({ client })` then
   `sim.simulate({ from, calls: [native transfer] })` → success with the
   expected native delta.
2. **bound debug default fires**: create with `debug: collector`; call
   `simulate` without `debug` → events collected.
3. **per-call override wins**: create with `debug: collectorA`; call with
   `debug: collectorB` → events in B, none in A.
4. **bound gas default propagates**: create with a distinctive `gas` value
   and a debug collector; the `txSimulator.simulate` debug event fires (gas
   itself isn't in event details — asserting the call succeeds under the
   bound budget suffices; note this limitation in the test comment).
5. **interface is mockable** (compile-time): declare
   `const fake: TxSimulator = { simulate: async () => ..., ... }` with
   stub implementations — must typecheck (this pins the interface's
   structural usability for consumer tests).

**Verify**: focused vitest run → new tests pass.

### Step 4: README

Rewrite every code example to create-then-call style (Getting started,
Forging, Discovering requirements, Debugging). No free-function mentions
remain.

**Verify**: `pnpm lint` → exit 0;
`grep -n "import { simulate\|import { discover" README.md` → no matches.

### Step 5: Full gate

**Verify**: `pnpm verify` → exit 0.

## Test plan

Step 2's five tests; existing suite untouched as the regression net for the
free functions the wrapper delegates to.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `TxSimulator` (interface + const) exported from package root; `create` returns all four methods
- [ ] Free functions NOT exported from the root: after `pnpm build`,
      `node -e "import('./dist/index.js').then(m => { if (m.simulate || m.discoverBalanceSlots || m.discoverAllowanceSlots || m.discoverRequirements) throw new Error('free functions still exported'); console.log('ok'); })"` → `ok`
- [ ] Per-call `gas`/`debug` override bound defaults (test 3)
- [ ] `git diff -- src/simulate.ts src/slots.ts src/requirements.ts` → empty (pure wrapper)
- [ ] Existing test assertions unchanged (call-style migration only)
- [ ] README examples are instance-style throughout; no free-function imports
- [ ] `plans/README.md` status row updated

## STOP conditions

- Wrapping requires modifying any free function's signature or body — the
  wrapper must be pure; report what forced it.
- The interface's method types can't be expressed without duplicating arg
  shapes by hand AND the named-alias fallback also fails — report the
  specific type error.
- Plans 016-019 not all DONE.

## Maintenance notes

- The `create()` closure is the designated seam for the deferred slot-cache
  finding — when that lands, cache state lives here, keyed
  (chain, token, from[, spender]), and the free functions stay cache-free.
- Adding a fifth public capability means: implement as a module function,
  add a bound method to this interface — the interface IS the public
  surface; `index.ts` exports only `TxSimulator`, errors, types, constants.
- Plan 022's JSDoc must land primarily on the `TxSimulator` interface
  methods (that's what consumers hover), with the module functions carrying
  brief implementation notes.
