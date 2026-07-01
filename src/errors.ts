export class TxSimError extends Error {
  override readonly name: string = "TxSimError";
}

export class AccessListUnsupportedError extends TxSimError {
  override readonly name = "AccessListUnsupportedError";

  constructor(message = "RPC endpoint does not support eth_createAccessList for this simulation.") {
    super(message);
  }
}

export class StateOverrideUnsupportedError extends TxSimError {
  override readonly name = "StateOverrideUnsupportedError";

  constructor(
    message = "RPC endpoint does not support eth_call state overrides for this simulation.",
  ) {
    super(message);
  }
}

export class InvalidSimulationInputError extends TxSimError {
  override readonly name = "InvalidSimulationInputError";
}
