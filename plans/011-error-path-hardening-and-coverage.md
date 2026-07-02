# Plan 011: Wrap simulator result decoding in the library error type and cover the error paths with tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7f94c6f..HEAD -- src/internal/simulator.ts src/errors.ts test`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (if plan 009 has landed, `test/requirements.test.ts` will have extra tests — irrelevant to this plan)
- **Category**: bug + tests
- **Planned at**: commit `7f94c6f`, 2026-07-02

## Why this matters

The library defines three typed errors (`AccessListUnsupportedError`,
`StateOverrideUnsupportedError`, `InvalidSimulationInputError`) so wallet
integrators can branch on RPC capability problems. Two gaps undermine that
contract. First, in `runSimulator` the RPC call is wrapped and re-thrown as
`StateOverrideUnsupportedError`, but the **decode of the returned data is
not** — an RPC that returns success with malformed/empty data (some providers
return `0x` for calls they mishandle) throws a raw viem `AbiDecodingError` or
a TypeError from property access, which callers have no stable way to handle.
Second, **none of the three error classes, nor the probes' silent
`undefined`-on-failure fallbacks, have any test coverage** — the entire error
surface of a library whose callers are RPC-capability-diverse wallets is
unverified.

## Current state

### The unwrapped decode — `src/internal/simulator.ts:75-127`

```ts
  let callData: Hex;
  try {
    const result = await withRpcDebug( /* ... */ () =>
        args.client.call( /* ... */ ),
    );
    callData = getCallData(result);
  } catch (cause) {
    throw new StateOverrideUnsupportedError(
      formatRpcError("eth_call with state override failed", cause),
    );
  }

  const decoded = decodeFunctionResult({        // <-- NOT wrapped
    abi: txSimulatorAbi,
    functionName: "simulate",
    data: callData,
  }) as unknown;
  const tuple = Array.isArray(decoded) ? decoded[0] : decoded;
  const result = tuple as { success: boolean; /* ... */ };
```

Note `getCallData` (`src/internal/hex.ts`) returns `"0x"` when the RPC result
has no data — `decodeFunctionResult` on `"0x"` throws.

### The error classes — `src/errors.ts` (complete file, 25 lines)

```ts
export class TxSimError extends Error {
  override readonly name: string = "TxSimError";
}
export class AccessListUnsupportedError extends TxSimError { /* default message */ }
export class StateOverrideUnsupportedError extends TxSimError { /* default message */ }
export class InvalidSimulationInputError extends TxSimError {}
```

Raise sites: `src/simulate.ts:12-14` and `src/requirements.ts:38-40` (empty
calls); `src/internal/rpc.ts:69-72` (`AccessListUnsupportedError` — but note
`createAccessList` deliberately returns `[]` for "execution reverted"
failures, only throwing for non-revert failures); `src/internal/simulator.ts:104-108`.

Silent fallbacks: `src/internal/probes.ts` — `discoverBalanceSlot` /
`discoverAllowanceSlot` return `undefined` if the access-list probe throws
(`catch { return undefined; }` at `:106-108` and `:162-164`), and
`readUint256Call` returns `undefined` on any error (`:232-234`). Public
`discoverBalanceSlots`/`discoverAllowanceSlots` (`src/slots.ts`) then omit
those entries.

### Test conventions

Anvil-backed vitest, one anvil per test (`test/helpers/anvil.ts`
`startAnvil()`); RPC behavior is patched by wrapping
`ctx.publicClient.request` — precedent existed in an earlier revision of
`test/simulate.test.ts` as:

```ts
const original = ctx.publicClient.request.bind(ctx.publicClient);
const replacement = (async (request: { method: string }, options?: unknown) => {
  // intercept by request.method, else delegate to original
}) as typeof ctx.publicClient.request;
Object.assign(ctx.publicClient, { request: replacement });
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | all pass (needs `anvil`, `forge`) |
| One file | `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts` | all pass |
| Lint | `pnpm lint` | exit 0 |

## Scope

**In scope**:

- `src/internal/simulator.ts` (wrap decode only)
- `test/errors.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/errors.ts` — the classes are fine as-is.
- `src/internal/probes.ts` behavior — silent `undefined` is the documented
  contract ("omits tokens whose slot cannot be verified", `src/slots.ts:8`);
  this plan TESTS it, it does not change it.
- `src/internal/rpc.ts` — the revert-vs-failure classification stands.
- Existing test files.

## Git workflow

- Do not commit, push, or open a PR unless the operator instructed it.

## Steps

### Step 1: Wrap the decode

In `src/internal/simulator.ts`, wrap the `decodeFunctionResult` call and the
tuple extraction (through the `result` cast) in try/catch, throwing:

```ts
throw new StateOverrideUnsupportedError(
  formatRpcError("eth_call returned undecodable simulator output", cause),
);
```

Keep the two try/catch blocks separate (RPC failure vs decode failure keep
their distinct messages). Do not widen the cast or change decoding logic.

**Verify**: `pnpm typecheck` → exit 0; `pnpm test` → existing suite passes.

### Step 2: Create `test/errors.test.ts`

Model setup on `test/requirements.test.ts` (per-test `startAnvil`, afterEach
stop). Include a local `patchRpc(ctx, method, impl)` helper using the
`Object.assign(ctx.publicClient, { request })` pattern above. Tests:

1. **empty calls**: `simulate({ client, from, calls: [] })` rejects with
   `InvalidSimulationInputError`; same for `discoverRequirements`. Use
   `await expect(...).rejects.toBeInstanceOf(InvalidSimulationInputError)`.
2. **access list unsupported**: patch `eth_createAccessList` to throw
   `new Error("the method eth_createAccessList does not exist/is not available")`;
   `simulate()` with one trivial call rejects with
   `AccessListUnsupportedError`. (Message must NOT match the
   `/execution reverted/i` classifier in `src/internal/rpc.ts:80-88`, which
   would instead return `[]`.)
3. **access list revert is NOT an error**: patch `eth_createAccessList` to
   throw `new Error("execution reverted")`; `simulate()` still resolves (the
   classifier returns an empty candidate list and the sim proceeds).
4. **state override unsupported**: patch `eth_call` to throw
   `new Error("state override not supported")` **only when** the request
   params include a third (state override) element, delegating otherwise;
   `simulate()` rejects with `StateOverrideUnsupportedError`.
5. **undecodable simulator output**: patch `eth_call` to resolve `"0x"` for
   the simulator call (params include state override), delegate otherwise;
   `simulate()` rejects with `StateOverrideUnsupportedError` and the message
   contains `undecodable` — this pins Step 1.
6. **probe failure degrades silently**: deploy a `TestToken`, patch
   `eth_createAccessList` to throw a non-revert error; `discoverBalanceSlots({
   client, owner, tokens: [token] })` resolves to `[]` (no throw).

Patching note: viem may route `client.call` through `request` with varying
param shapes; match on `request.method` and inspect `request.params` length
for the override discrimination. If viem batches or renames internally and a
patch never triggers, prefer asserting via a one-off custom transport
(`createPublicClient({ transport: custom({ request: impl }) })`) for that test
instead — note the substitution in your report.

**Verify**: `pnpm build:contracts && pnpm exec vitest run test/errors.test.ts`
→ 6+ tests pass. Then `pnpm test` → full suite green.

## Test plan

Step 2 IS the test plan: six error-path tests in a new `test/errors.test.ts`,
patterned on `test/requirements.test.ts` setup and the request-patching
precedent. Full suite as regression.

## Done criteria

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0
- [ ] `src/internal/simulator.ts` decode is inside a try/catch throwing `StateOverrideUnsupportedError` (grep: `undecodable`)
- [ ] `test/errors.test.ts` exists; ≥6 tests; each of the three error classes asserted via `rejects.toBeInstanceOf` at least once
- [ ] `git status --porcelain` shows changes only to in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- Patching `publicClient.request` doesn't intercept `client.call` at all AND
  the custom-transport fallback also fails — report viem's call path rather
  than restructuring source code to be mockable.
- Step 1 causes any existing test to fail (would mean real traffic hits the
  decode-failure path — investigate and report).

## Maintenance notes

- If a future viem major changes `request` routing, these tests fail loudly —
  that's intended; update the patch helper, not the assertions.
- The silent-`undefined` probe contract is now pinned by test 6; if the API
  later grows explicit failure reporting (e.g. returning `{found, failed}`),
  update that test deliberately.
