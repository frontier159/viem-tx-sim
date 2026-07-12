# Plan 045: Checksum-normalize addresses at the RPC boundary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3bce89e..HEAD -- src/internal/rpc.ts src/internal/data.ts test/errors.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but execute BEFORE plan 046 — both edit `createAccessList` in `src/internal/rpc.ts`)
- **Category**: bug
- **Planned at**: commit `3bce89e`, 2026-07-12

## Why this matters

Some RPC proxies (walletchan observed Coinbase's `mainnet.base.org`) reject `eth_call` requests whose address fields mix casings with `-32602 invalid params`. We produce exactly that mix: `buildStateOverride` checksums every override-map address (`src/internal/simulator.ts:264` via `normalizeAddress`), but the transaction's `from`/`to` fields pass through verbatim from caller input. A caller who supplies a lowercase `from` — common, since explorers and event logs emit lowercase — gets checksummed override keys next to a lowercase `from`, and the provider's rejection surfaces as a spurious `StateOverrideUnsupportedError` on an RPC that actually supports state overrides. walletchan patched this exact asymmetry (see `docs/walletchan-learnings-2026-07-12.md` item 2). Pure input normalization; no pinned invariant is touched.

## Current state

Every outgoing RPC request in the library flows through exactly two builders in `src/internal/rpc.ts`, neither of which normalizes addresses:

```ts
// src/internal/rpc.ts:42-57 (buildCallParameters — used by runSimulator and readUint256Call for every eth_call)
export function buildCallParameters(
  args: {
    account: Address;
    to: Address;
    ...
): CallParameters {
  const base = {
    account: args.account,
    to: args.to,
    data: args.data,
    ...
```

```ts
// src/internal/rpc.ts:88-94 (createAccessList — every eth_createAccessList)
  const request = {
    from: args.from,
    to: args.to,
    data: args.data,
    ...(args.value !== undefined ? { value: numberToHex(args.value) } : {}),
    ...(args.gas !== undefined ? { gas: numberToHex(args.gas) } : {}),
  } satisfies AccessListRpcRequest;
```

- `normalizeAddress` already exists: `src/internal/data.ts:4-6` (`getAddress` from viem — checksums, throws on invalid input).
- Override keys are already checksummed: `buildStateOverride` at `src/internal/simulator.ts:263-266` calls `normalizeAddress(entry.address)`.
- fakeClient test infrastructure: `test/helpers/fakeClient.ts` builds a real viem `PublicClient` over a `custom` transport with per-method responders receiving raw `params`; `test/errors.test.ts` is the exemplar for its use, and `encodeSimulationResult()` (same helper file) fabricates valid simulator returndata for `eth_call` responders.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Focused tests | `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts` | all pass |
| Full gate | `pnpm verify` | exit 0 |

## Scope

**In scope** (the only files you should modify/create):
- `src/internal/rpc.ts`
- `test/errors.test.ts` (new fakeClient tests)
- `.changeset/<new-file>.md` (create)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `src/internal/simulator.ts`, `src/internal/probes.ts`, `src/internal/queryDiscovery.ts` — fixing at the two rpc.ts chokepoints covers every call site; per-site normalization would be the symptom-patch this plan exists to avoid.
- `src/internal/data.ts` — `normalizeAddress` is used as-is.
- Addresses inside ABI-encoded calldata (`calls[].to` encoded into the simulator's arguments) — the EVM is case-insensitive there; only JSON-RPC request fields matter.

## Git workflow

- Branch: `advisor/045-checksum-normalize-rpc-addresses`
- Message style: `fix: checksum-normalize from/to at the RPC boundary`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Normalize in the two builders

In `src/internal/rpc.ts`:

1. Import `normalizeAddress` from `./data.js`.
2. In `buildCallParameters`, build `base` with `account: normalizeAddress(args.account)` and `to: normalizeAddress(args.to)`.
3. In `createAccessList`, build `request` with `from: normalizeAddress(args.from)` and `to: normalizeAddress(args.to)`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Tests — lowercase input produces checksummed request fields

In `test/errors.test.ts` (fakeClient tests live here; follow the existing responder pattern), add two tests. Use a real checksummed address constant and its `.toLowerCase()` as input.

Test A (`eth_call` path): script an `eth_call` responder that captures its `params` argument and returns `encodeSimulationResult()`. Call `TxSimulator.create({ client }).simulate({ from: lowercaseFrom, calls: [{ to: lowercaseFrom, data: "0x" }], balanceQueries: [{ asset: "native", account: lowercaseFrom }] })`. Assert on the captured params (shape `[txObject, block, stateOverride]`):
- `txObject.from` and `txObject.to` equal the checksummed address;
- every address key in the state-override param equals its checksummed form (this pins the existing `buildStateOverride` behavior alongside the fix, guarding the agreement between the two, which is what providers actually check).

Note: inspect the captured params once with `console.log` to confirm viem's exact serialized shape before writing assertions, then remove the log.

Test B (`eth_createAccessList` path): script `eth_createAccessList` capturing params and returning `{ accessList: [] }`, plus an `eth_call` responder returning `encodeSimulationResult()`. Call `sim.balanceQueries.discoverErc20s({ from: lowercaseFrom, calls: [{ to: lowercaseOther, data: "0x" }] })`. Assert the captured request's `from`/`to` are checksummed.

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts` → all pass, including 2 new tests.

### Step 3: Changeset and index

Patch changeset (`.changeset/checksum-rpc-addresses.md`):

```markdown
---
"viem-tx-sim": patch
---

Checksum-normalize `from`/`to` on every outgoing eth_call and eth_createAccessList so lowercase caller addresses no longer produce mixed-casing requests that some RPC proxies reject with -32602.
```

Update this plan's row in `plans/README.md`.

**Verify**: `pnpm verify` → exit 0.

## Test plan

- Test A: lowercase `from` → checksummed `from`/`to` and checksummed override keys in the outgoing `eth_call` (the regression this plan fixes).
- Test B: lowercase `from`/`to` → checksummed fields in the outgoing `eth_createAccessList`.
- Existing suite unchanged and green (normalization must be behavior-invisible everywhere else).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "normalizeAddress" src/internal/rpc.ts` → import + 4 use sites (account, to, from, to)
- [ ] `pnpm verify` exits 0
- [ ] 2 new tests exist and pass; no existing test modified
- [ ] Patch changeset present
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The rpc.ts excerpts in "Current state" don't match the live code.
- Any existing test fails after Step 1 — in particular, if a test intentionally passes an invalid address expecting it to reach the transport, `getAddress` now throws earlier; that ordering change needs a maintainer decision, not a workaround.
- viem's transport serialization turns out to re-lowercase addresses (Test A's captured `from` is lowercase despite Step 1) — the fix would then be dead code and the finding needs re-evaluation against viem's actual behavior.

## Maintenance notes

- Any future RPC method added to `rpc.ts` must route its address fields through `normalizeAddress` — the file's header comment already says new RPC methods belong here; this is one more reason.
- `normalizeAddress` throws `InvalidAddressError` (viem) on garbage input; that error now surfaces before any RPC call is made. That is a stricter, earlier failure than before and is the desired behavior.
- Plan 046 edits the same `createAccessList` request builder; run this plan first so 046 rebases onto the normalized shape.
