import type { Address } from "viem";

import type { BalanceQuery, ForUserBalanceQueriesArgs, SimulatedCall } from "../types.js";
import { uniqueAddresses } from "./data.js";
import type { ClientArgs } from "./rpc.js";
import { blockOptionsSpread, isInsufficientFunds } from "./rpc.js";
import { DEBUG_STEPS } from "./debugSteps.js";
import { discoverCandidateAddresses, runSimulator } from "./simulator.js";

/** @internal Implements {@link TxSimulator.balanceQueries.forUser}. Prefer the instance API from the package root. */
export async function forUserBalanceQueries(
  args: ForUserBalanceQueriesArgs & ClientArgs,
): Promise<BalanceQuery[]> {
  const tokens = await discoverErc20s(args);

  return [
    { asset: "native", account: args.from },
    ...tokens.map((asset) => ({ asset, account: args.from })),
  ];
}

/** @internal Implements {@link TxSimulator.balanceQueries.discoverErc20s}. Prefer the instance API from the package root. */
export async function discoverErc20s(
  args: ForUserBalanceQueriesArgs & ClientArgs,
): Promise<Address[]> {
  const calls = args.calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
  let candidates: Address[];
  try {
    candidates = await discoverCandidateAddresses({
      client: args.client,
      from: args.from,
      calls,
      gas: args.gas,
      accessListGas: args.accessListGas,
      debug: args.debug,
      ...blockOptionsSpread(args),
    });
  } catch (cause) {
    if (!isInsufficientFunds(cause)) throw cause;
    candidates = uniqueAddresses(calls.map((call) => call.to));
  }
  const result = await runSimulator({
    client: args.client,
    from: args.from,
    calls: [],
    candidates,
    debug: args.debug,
    debugStep: DEBUG_STEPS.balanceQueriesTokenFilter,
    gas: args.gas,
    ...blockOptionsSpread(args),
  });

  return result.probeData.observedTokens;
}
