import type { BalanceQuery, ForUserBalanceQueriesArgs, SimulatedCall } from "../types.js";
import type { ClientArgs } from "./rpc.js";
import { blockOptionsSpread } from "./rpc.js";
import { discoverCandidateAddresses, runSimulator } from "./simulator.js";

/** @internal Implements {@link TxSimulator.balanceQueries.forUser}. Prefer the instance API from the package root. */
export async function forUserBalanceQueries(
  args: ForUserBalanceQueriesArgs & ClientArgs,
): Promise<BalanceQuery[]> {
  const calls = args.calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
  const candidates = await discoverCandidateAddresses({
    client: args.client,
    from: args.from,
    calls,
    gas: args.gas,
    debug: args.debug,
    ...blockOptionsSpread(args),
  });
  const result = await runSimulator({
    client: args.client,
    from: args.from,
    calls: [],
    candidates,
    debug: args.debug,
    debugStep: "balanceQueries.tokenFilter",
    gas: args.gas,
    ...blockOptionsSpread(args),
  });

  return [
    { asset: "native", account: args.from },
    ...result.probeData.observedTokens.map((asset) => ({ asset, account: args.from })),
  ];
}
