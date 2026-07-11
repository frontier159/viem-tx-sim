# Handle reverts and debug RPC activity

Transaction reverts are returned as data:

```ts
const result = await simulator.simulate({ from, calls, balanceQueries });

if (result.status === "reverted") {
  console.log(result.failingCallIndex);
  console.log(result.revertData);
  console.log(result.revertSelector);
  console.log(result.revertReason);
  console.log(result.revertError);
}
```

Built-in `Error(string)` and `Panic(uint256)` values are decoded automatically. Add protocol errors at creation time or for one call:

```ts
import { parseAbi } from "viem";

const customErrorSimulator = TxSimulator.create({
  client,
  errorAbi: parseAbi(["error Unauthorized()"]),
});

const result = await customErrorSimulator.simulate({
  from,
  calls,
  balanceQueries,
  errorAbi: parseAbi(["error InsufficientBalance(uint256 have, uint256 want)"]),
});
```

Enable RPC debug events with a callback:

```ts
const debugSimulator = TxSimulator.create({
  client,
  debug: (event) => {
    console.log(event.phase, event.method, event.step, event.durationMs);
  },
});
```

Pass `debug: true` for console output. In Node.js, `VIEM_TX_SIM_DEBUG_RPC=1` also enables console logging. Per-call `debug` overrides the default passed to `TxSimulator.create()`.

Provider and contract text can appear in errors and `revertReason`. Treat it as untrusted before rendering it in a UI.

[Back to examples](./README.md)
