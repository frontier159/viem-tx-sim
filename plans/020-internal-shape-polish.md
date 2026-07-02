# Plan 020: Internal shape polish — shared RPC-args type, override-representation docs, decode-cast removal attempt

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat ed0031a..HEAD -- src/internal src/requirements.ts`
> Plans 016-019 land first and touch these files — expected drift; locate
> everything by symbol name. STOP only if a named symbol is gone.

## Status

- **Priority**: P3
- **Effort**: S-M
- **Risk**: LOW (mechanical + docs; one investigate-and-maybe-revert step)
- **Depends on**: plans/016-019 (same files; avoid rebasing them onto this)
- **Category**: tech-debt
- **Planned at**: commit `ed0031a`, 2026-07-02

## Why this matters

Three small frictions left by the 2026-07-02 architecture audit, none urgent,
all cheap while the suite is green: (1) the
`{ client; gas?; debug? } & BlockOptions` argument cluster is re-declared
inline in ~10 internal signatures — adding one cross-cutting option (e.g. a
timeout) means touching all of them; (2) storage overrides exist in three
representations (`TokenSlotOverride` → `StorageOverride` → viem
`StateOverride`) whose per-layer purpose is undocumented, reading as
accidental duplication when it is a deliberate chain; (3) the simulator
result decode goes through `as unknown` + a hand-written tuple cast, meaning
ABI drift between the Solidity struct and the TS shape compiles silently —
viem's `decodeFunctionResult` over a const `parseAbi` may already infer the
tuple, making the casts deletable.

## Current state

(Symbol-anchored; post-016-019 files will have drifted lines.)

1. **Repeated args cluster** — declared inline in: `readBalanceOf`,
   `readAllowance`, `discoverBalanceSlot`, `discoverAllowanceSlot`,
   `readUint256Call` (`src/internal/probes.ts`); `discoverCandidateAddresses`
   (`src/internal/discovery.ts`); `createAccessList`, `buildCallParameters`
   (`src/internal/rpc.ts`); `runSimulator` (`src/internal/simulator.ts`);
   plus the functions in `src/internal/allowanceDiscovery.ts` (plan 017).
   Shape (verbatim from probes.ts):

```ts
args: {
  client: PublicClient;
  /* function-specific fields */
  gas?: bigint;
  debug?: SimulationDebug;
  debugStep?: string;   // some sites
} & BlockOptions
```

2. **Override chain** — `TokenSlotOverride` (`src/types.ts`, public:
   `{token, slot, amount?}` — semantic, amount defaulted),
   `StorageOverride` (`src/internal/stateOverride.ts:5-9`:
   `{address, slot, value: Hex}` — materialized), viem `StateOverride`
   (wire format, built by `storageOverridesToStateDiff` +
   `buildStateOverride`). Conversions in `src/simulate.ts` and
   `src/requirements.ts` (`slotOverride`, `tokenSlotOverride` helpers).
   No comment anywhere explains the layering.

3. **Decode cast** — `src/internal/simulator.ts`:

```ts
const txSimulatorAbi = parseAbi([ /* string literals incl. struct defs */ ]);
...
const decoded = decodeFunctionResult({ abi: txSimulatorAbi, functionName: "simulate", data: callData }) as unknown;
const tuple = Array.isArray(decoded) ? decoded[0] : decoded;
const result = tuple as { success: boolean; /* 10 fields */ };
```

   `parseAbi` over an inline literal array IS const-inferred by viem; the
   open question is whether `decodeFunctionResult`'s inferred return for a
   single-struct-returning function is the struct object directly (no array
   wrapper) with all 10 fields typed — if so, both casts and the
   `Array.isArray` dance can go.

4. **rpc.ts layering** — the module now holds types (`BlockOptions`),
   call-shaping helpers (`blockOptionsSpread`, `buildCallParameters`), an
   RPC wrapper (`createAccessList`), and error formatting (`formatRpcError`).
   Coherent today; one header comment prevents junk-drawer drift.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Full gate | `pnpm verify` | exit 0 |
| Typecheck only | `pnpm typecheck` | exit 0 |

## Scope

**In scope**: `src/internal/{rpc,probes,discovery,simulator,stateOverride,allowanceDiscovery}.ts`,
`src/simulate.ts`, `src/requirements.ts`, `src/slots.ts` (only if the shared
type replaces inline clusters there), `plans/README.md` (status row).
`dist/` via build.

**Out of scope**: `src/types.ts` public shapes, `src/index.ts` exports
(nothing new becomes public), all tests (zero test-file changes — the suite
must pass untouched), `contracts/**`, debug step names, RPC call counts.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Shared `RpcCallArgs` type

In `src/internal/rpc.ts`, next to `BlockOptions`:

```ts
export type RpcCallArgs = {
  client: PublicClient;
  gas?: bigint;
  debug?: SimulationDebug;
} & BlockOptions;
```

Replace each inline cluster with `args: RpcCallArgs & { /* specific fields */ }`.
Keep `debugStep?: string` in the per-function specifics (not universal).
Public function signatures in `src/slots.ts`/`simulate.ts`/`requirements.ts`
may also use it internally, but the *published* `.d.ts` shape must stay
structurally identical (it will — type aliases are structural).

**Verify**: `pnpm typecheck` → exit 0;
`grep -rn "client: PublicClient" src/internal/ | wc -l` → ≤2 (the alias
definition + at most one intentional outlier, which you name in your report).

### Step 2: Document the override chain

Doc comments only: on `StorageOverride` ("internal materialized form of the
public `TokenSlotOverride` — `amount` defaulted and hex-encoded; converted to
viem `StateOverride` by `storageOverridesToStateDiff`"), and a two-line
header on `src/internal/rpc.ts` naming its three layers (types → call-shaping
helpers → RPC wrappers) and the rule that new RPC methods get wrappers here.

**Verify**: `pnpm lint` → exit 0.

### Step 3: Attempt the decode-cast removal (investigate, keep if it fails)

Delete `as unknown`, the `Array.isArray` unwrap, and the manual tuple cast in
`src/internal/simulator.ts`; let the decoded value's inferred type flow. Then:

- If `pnpm typecheck` passes AND hovering/inspection shows all 10 fields
  typed (spot-check by intentionally misspelling one field access — it must
  now be a compile error, then revert the misspelling): keep the removal.
- If inference yields a union/unknown or loses fields: **restore the casts
  exactly** and add a one-line comment above them stating the viem version
  and why manual casting is required. Do not invent partial workarounds.

**Verify**: `pnpm typecheck` → exit 0 either way; `pnpm verify` → exit 0.

### Step 4: Full gate

**Verify**: `pnpm verify` → exit 0; `git diff --stat -- test/` → empty.

## Test plan

None — the deliverable is zero behavior change with the full suite passing
untouched. Step 3's misspelling probe is a manual compile-time check, not a
committed test.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `RpcCallArgs` exists in `src/internal/rpc.ts` and is used by probes/discovery/simulator/allowanceDiscovery signatures
- [ ] `StorageOverride` and `rpc.ts` carry the layer comments
- [ ] Decode casts either removed (typecheck green) or restored with the explanatory comment — report states which
- [ ] `git diff --stat -- test/` → empty; `git diff -- src/index.ts` → empty
- [ ] `plans/README.md` status row updated

## STOP conditions

- The shared type forces a *published* `.d.ts` change beyond alias
  substitution (check `dist/*.d.ts` after build) — report.
- Step 3 requires touching the ABI strings or the Solidity struct to make
  inference work — out of scope; restore casts and report.

## Maintenance notes

- Future cross-cutting call options (timeout, retry policy) now have one
  home: `RpcCallArgs`.
- If the decode casts had to stay, revisit after the next viem major — note
  the version in the comment so the trigger is visible.
