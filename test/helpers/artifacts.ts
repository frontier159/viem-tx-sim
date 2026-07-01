import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Abi, Hex } from "viem";

export type ContractArtifact = {
  abi: Abi;
  bytecode: Hex;
};

export function artifact(contractFile: string, contractName: string): ContractArtifact {
  const path = resolve("out", contractFile, `${contractName}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const bytecode = json.bytecode?.object;
  if (!Array.isArray(json.abi) || typeof bytecode !== "string") {
    throw new Error(`Invalid Forge artifact: ${path}`);
  }
  return {
    abi: json.abi,
    bytecode: (bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`) as Hex,
  };
}
