import type { Abi, Hex } from "viem";
import { decodeErrorResult, slice, size } from "viem";

export type DecodedRevert = {
  revertReason?: string;
  revertError?: { name: string; args: readonly unknown[] };
  revertSelector?: Hex;
};

export function decodeRevert(data: Hex | undefined, errorAbi?: Abi): DecodedRevert {
  if (!data || data === "0x") return {};

  const revertSelector = size(data) >= 4 ? slice(data, 0, 4) : undefined;
  try {
    const decoded = decodeErrorResult({ abi: errorAbi ?? [], data });
    return {
      revertReason: formatReason(decoded.errorName, decoded.args ?? []),
      revertError: { name: decoded.errorName, args: decoded.args ?? [] },
      ...(revertSelector !== undefined ? { revertSelector } : {}),
    };
  } catch {
    return revertSelector !== undefined ? { revertSelector } : {};
  }
}

function formatReason(name: string, args: readonly unknown[]): string {
  if (name === "Error") return String(args[0]);
  if (name === "Panic") return `Panic(${String(args[0])})`;
  return `${name}(${args.map((arg) => String(arg)).join(", ")})`;
}
