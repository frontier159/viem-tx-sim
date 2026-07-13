---
"viem-tx-sim": patch
---

Robustness and RPC hardening:

- The ghost contract's `balanceOf`/`allowance`/probe staticcalls are gas-capped (150k) and copy at most 32 bytes of returndata, so a hostile or gas-burning token degrades to `unresolved` instead of out-of-gassing or memory-bombing the whole simulation `eth_call`.
- `from`/`to` are checksum-normalized on every `eth_call` and `eth_createAccessList`, so lowercase caller addresses no longer draw `-32602` from casing-sensitive RPC proxies.
- `eth_createAccessList` defaults to 10M gas (new exported `ACCESS_LIST_GAS_LIMIT`) and sends explicitly supplied gas verbatim; `eth_call` gas is unchanged.
- The ghost answers ERC-165 `supportsInterface` for the receiver interfaces it implements, so safe-transfer flows that pre-check receiver support no longer false-revert during simulation.
- `balanceQueries.forUser`/`discoverErc20s` degrade to direct call-target candidates when the provider rejects `eth_createAccessList` for an unfunded `from`, instead of throwing `AccessListUnsupportedError`.
- Override preparation (`tokenOverrides.forBalances`/`forAllowances`/`forPermit2Allowances`) throws typed `AccessListUnsupportedError`/`StateOverrideUnsupportedError` on provider/infrastructure failures instead of silently reporting every token as `unresolved`; reverting reads still resolve to `unresolved`.
