# Context

Domain glossary for `viem-tx-sim`. Terms defined here are the project's vocabulary — use them exactly in issues, specs, tests, and reviews.

## Glossary

**Ghost contract** — the never-deployed `TxSimulator` bytecode injected at the user's own address via `eth_call` state overrides, so downstream contracts see `msg.sender == from`. It exists only for the duration of one `eth_call`.

**Checkpoint grid** — the flat `uint256[]` of balance/allowance readings the ghost contract returns, logically a grid of one row per probe with `calls + 1` entries per row (a reading before each call plus one after the last). The row layout (stride `calls + 1`, row-major per probe) is defined by the contract; TypeScript decodes it in exactly one place.

**Probe row** — one row of the checkpoint grid: the `calls + 1` readings for a single probe (a balance query or an allowance pair). Before/after/by-call deltas and allowance drawdowns are all derived from probe rows.

**Probe** — one thing the ghost contract measures at every checkpoint: a `(token, account)` balance or a `(token, owner, spender)` allowance.

**Sentinel** — `OVERRIDE_TOKEN_AMOUNT` (`10^50`), the deliberately-below-max value written to candidate storage slots to verify a slot really backs `balanceOf`/`allowance`. Kept below `uint256.max` so allowance decrements from `transferFrom` remain observable.

**Debug step** — the name attached to each debug event a simulation emits (e.g. `txSimulator.simulate`, `balanceSlot.verify`). The step vocabulary is a pinned invariant: tests assert exact step names and counts to detect hidden RPC calls. See ADR-0001 for who is allowed to import the constants.
