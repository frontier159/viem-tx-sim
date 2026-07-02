/** Base class for typed infrastructure and input errors thrown by viem-tx-sim. */
export class TxSimError extends Error {
  override readonly name: string = "TxSimError";
}

/**
 * Thrown when the RPC endpoint cannot run `eth_createAccessList` for a non-transaction-revert reason.
 *
 * Transaction execution reverts during access-list creation are normalized to an empty access list;
 * this error means provider capability or infrastructure failure. Try another RPC endpoint that
 * supports EIP-2930 access lists for historical/state-overridden calls.
 */
export class AccessListUnsupportedError extends TxSimError {
  override readonly name = "AccessListUnsupportedError";

  constructor(message = "RPC endpoint does not support eth_createAccessList for this simulation.") {
    super(message);
  }
}

/**
 * Thrown when the RPC endpoint cannot execute `eth_call` with state overrides or returns bad output.
 *
 * This is usually a provider capability issue, including unsupported state overrides or simulator
 * output that cannot be decoded. Retrying the same request generally will not help unless the RPC
 * failure was transient; use a provider with state-override support.
 */
export class StateOverrideUnsupportedError extends TxSimError {
  override readonly name = "StateOverrideUnsupportedError";

  constructor(
    message = "RPC endpoint does not support eth_call state overrides for this simulation.",
  ) {
    super(message);
  }
}

/**
 * Thrown for caller-side input bugs, such as an empty call batch.
 *
 * This is not an RPC/provider issue and should be fixed before retrying.
 */
export class InvalidSimulationInputError extends TxSimError {
  override readonly name = "InvalidSimulationInputError";
}
