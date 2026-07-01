import type { Address, Hex, PublicClient } from "viem";

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
    candidates.push(...extractCalldataAddresses(call.calldata));
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

function extractCalldataAddresses(data: Hex): Address[] {
  const hex = data.slice(2);
  const words = hex.length > 8 ? hex.slice(8) : "";
  const addresses: Address[] = [];

  for (let offset = 0; offset + 64 <= words.length; offset += 64) {
    const word = words.slice(offset, offset + 64);
    if (word.slice(0, 24) !== "0".repeat(24)) continue;

    const address = `0x${word.slice(24)}` as Address;
    if (address !== "0x0000000000000000000000000000000000000000") {
      addresses.push(address);
    }
  }

  return addresses;
}
