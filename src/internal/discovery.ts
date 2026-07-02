import type { Address, PublicClient } from "viem";

import type { SimulationDebug } from "../types.js";
import type { SimulatedCall } from "../types.js";
import { uniqueAddresses } from "./address.js";
import type { BlockOptions } from "./rpc.js";
import { createAccessList } from "./rpc.js";

export async function discoverCandidateAddresses(
  args: {
    client: PublicClient;
    from: Address;
    calls: readonly SimulatedCall[];
    gas?: bigint;
    debug?: SimulationDebug;
  } & BlockOptions,
): Promise<Address[]> {
  const candidates: Address[] = [];

  for (const call of args.calls) {
    candidates.push(call.to);
    const accessList = await createAccessList({
      client: args.client,
      from: args.from,
      to: call.to,
      data: call.calldata,
      value: call.value ?? 0n,
      gas: args.gas,
      debug: args.debug,
      debugStep: "candidateDiscovery.accessList",
      blockNumber: args.blockNumber,
      blockTag: args.blockTag,
    });
    for (const entry of accessList) candidates.push(entry.address);
  }

  return uniqueAddresses(candidates);
}
