import type { Address } from "viem";

import type { SimulatedCall } from "../types.js";
import { uniqueAddresses } from "./address.js";
import type { RpcCallArgs } from "./rpc.js";
import { blockOptionsSpread, createAccessList } from "./rpc.js";

export async function discoverCandidateAddresses(
  args: RpcCallArgs & {
    from: Address;
    calls: readonly SimulatedCall[];
  },
): Promise<Address[]> {
  const accessLists = await Promise.all(
    args.calls.map((call) =>
      createAccessList({
        client: args.client,
        from: args.from,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
        gas: args.gas,
        debug: args.debug,
        debugStep: "candidateDiscovery.accessList",
        ...blockOptionsSpread(args),
      }),
    ),
  );
  const candidates = args.calls.flatMap((call, index) => [
    call.to,
    ...(accessLists[index] ?? []).map((entry) => entry.address),
  ]);

  return uniqueAddresses(candidates);
}
