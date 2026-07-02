import type {
  AccessList,
  Address,
  BlockTag,
  CallParameters,
  Hex,
  PublicClient,
  StateOverride,
} from "viem";
import { numberToHex } from "viem";

import { AccessListUnsupportedError } from "../errors.js";
import type { SimulationDebug } from "../types.js";
import { withRpcDebug } from "./debug.js";

// Internal RPC layer: shared argument types, call-shaping helpers, then RPC wrappers.
// Add new RPC methods here so debug and infrastructure-error behavior stays consistent.
export type BlockOptions = {
  blockNumber?: bigint;
  blockTag?: BlockTag;
};

export type RpcCallArgs = {
  client: PublicClient;
  gas?: bigint;
  debug?: SimulationDebug;
} & BlockOptions;

export function blockOptionsSpread(args: BlockOptions): BlockOptions {
  return args.blockNumber !== undefined
    ? { blockNumber: args.blockNumber }
    : args.blockTag !== undefined
      ? { blockTag: args.blockTag }
      : {};
}

export function buildCallParameters(
  args: {
    account: Address;
    to: Address;
    data: Hex;
    gas?: bigint;
    stateOverride?: StateOverride;
  } & BlockOptions,
): CallParameters {
  const base = {
    account: args.account,
    to: args.to,
    data: args.data,
    ...(args.stateOverride !== undefined ? { stateOverride: args.stateOverride } : {}),
    ...(args.gas !== undefined ? { gas: args.gas } : {}),
  };
  return (
    args.blockNumber !== undefined
      ? { ...base, blockNumber: args.blockNumber }
      : { ...base, ...(args.blockTag !== undefined ? { blockTag: args.blockTag } : {}) }
  ) satisfies CallParameters;
}

export type AccessListEntry = AccessList[number];

type AccessListRpcRequest = {
  from: Address;
  to: Address;
  data: Hex;
  value?: Hex;
  gas?: Hex;
};

type AccessListRpcResult = {
  accessList?: AccessList;
  gasUsed?: Hex;
  error?: string | { message?: string };
};

export async function createAccessList(
  args: RpcCallArgs & {
    from: Address;
    to: Address;
    data: Hex;
    value?: bigint;
    debugStep?: string;
  },
): Promise<AccessList> {
  const request = {
    from: args.from,
    to: args.to,
    data: args.data,
    ...(args.value !== undefined ? { value: numberToHex(args.value) } : {}),
    ...(args.gas !== undefined ? { gas: numberToHex(args.gas) } : {}),
  } satisfies AccessListRpcRequest;
  const block =
    args.blockNumber !== undefined ? numberToHex(args.blockNumber) : (args.blockTag ?? "latest");

  try {
    const result = await withRpcDebug(
      args.debug,
      {
        method: "eth_createAccessList",
        step: args.debugStep ?? "createAccessList",
        details: {
          from: args.from,
          to: args.to,
          hasValue: (args.value ?? 0n) > 0n,
          hasGas: args.gas !== undefined,
        },
      },
      () => requestAccessList(args.client, request, block),
    );
    if (result.accessList !== undefined) return result.accessList;
    if (isRpcExecutionRevert(result.error)) return [];
    throw new Error(formatRpcError("eth_createAccessList returned no access list", result.error));
  } catch (cause) {
    if (isExecutionRevert(cause)) return [];
    throw new AccessListUnsupportedError(formatRpcError("eth_createAccessList failed", cause));
  }
}

export function formatRpcError(prefix: string, cause: unknown): string {
  if (cause instanceof Error && cause.message) return `${prefix}: ${cause.message}`;
  return prefix;
}

function isExecutionRevert(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return /execution reverted|Execution reverted/i.test(cause.message);
}

function isRpcExecutionRevert(error: AccessListRpcResult["error"]): boolean {
  const message = typeof error === "string" ? error : error?.message;
  return message !== undefined && /execution reverted|Execution reverted/i.test(message);
}

async function requestAccessList(
  client: PublicClient,
  request: AccessListRpcRequest,
  block: Hex | BlockTag,
): Promise<AccessListRpcResult> {
  return client.request<{
    Method: "eth_createAccessList";
    Parameters: [transaction: AccessListRpcRequest, block: Hex | BlockTag];
    ReturnType: AccessListRpcResult;
  }>({
    method: "eth_createAccessList",
    params: [request, block],
  });
}
