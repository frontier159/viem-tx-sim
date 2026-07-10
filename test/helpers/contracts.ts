import { getAddress, type Abi, type Address } from "viem";

import { artifact } from "./artifacts.js";
import type { AnvilTestContext } from "./anvil.js";

/** Deploys a Forge artifact through the context wallet and returns its abi + checksummed address. */
export async function deploy(
  ctx: AnvilTestContext,
  contractFile: string,
  contractName: string,
  args: readonly unknown[] = [],
) {
  const contract = artifact(contractFile, contractName);
  const hash = await ctx.walletClient.deployContract({
    abi: contract.abi,
    bytecode: contract.bytecode,
    args,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted" || receipt.contractAddress == null) {
    throw new Error(`deploy of ${contractName} reverted (tx ${hash})`);
  }
  return {
    abi: contract.abi,
    address: getAddress(receipt.contractAddress),
  };
}

/** Sends a state-changing contract call through the context wallet and awaits its receipt. */
export async function write(
  ctx: AnvilTestContext,
  contract: { abi: Abi; address: Address },
  functionName: string,
  args: readonly unknown[] = [],
) {
  const hash = await ctx.walletClient.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") {
    throw new Error(`write ${functionName} reverted (tx ${hash})`);
  }
}
