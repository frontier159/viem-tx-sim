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
import type { SimulationDebug, SimulationDebugEvent } from "../types.js";
import { normalizeAddress } from "./data.js";
import { DEBUG_STEPS } from "./debugSteps.js";
import type { DebugStep } from "./debugSteps.js";

// Internal RPC layer: shared argument types, call-shaping helpers, then RPC wrappers.
// Add new RPC methods here so debug and infrastructure-error behavior stays consistent.
export type BlockOptions = {
  blockNumber?: bigint;
  blockTag?: BlockTag;
};

/** Attaches the bound viem client to public per-call args for internal implementations. */
export type ClientArgs = { client: PublicClient };

export type RpcCallArgs = {
  client: PublicClient;
  gas?: bigint;
  debug?: SimulationDebug;
} & BlockOptions;

/** Returns the block selector for RPC calls; `blockNumber` takes precedence over `blockTag`. */
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
    account: normalizeAddress(args.account),
    to: normalizeAddress(args.to),
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
    debugStep?: DebugStep;
  },
): Promise<AccessList> {
  const request = {
    from: normalizeAddress(args.from),
    to: normalizeAddress(args.to),
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
        step: args.debugStep ?? DEBUG_STEPS.createAccessList,
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

// Classifies an execution revert on structured signals, not exact provider prose: JSON-RPC error
// code 3 (geth-family's `execution reverted` code, preserved by viem on the cause chain) or a
// message containing "revert". Providers word reverts differently, so match the signal, not the text.
function hasRevertCode(cause: unknown): boolean {
  for (let c = cause; typeof c === "object" && c !== null; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === 3) return true;
  }
  return false;
}

function isExecutionRevert(cause: unknown): boolean {
  if (hasRevertCode(cause)) return true;
  return cause instanceof Error && /revert/i.test(cause.message);
}

function isRpcExecutionRevert(error: AccessListRpcResult["error"]): boolean {
  if (hasRevertCode(error)) return true;
  const message = typeof error === "string" ? error : error?.message;
  return message !== undefined && /revert/i.test(message);
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

function emitDebug(debug: SimulationDebug | undefined, event: SimulationDebugEvent): void {
  if (typeof debug === "function") {
    debug(event);
    return;
  }

  if (debug === true || envDebugEnabled()) {
    console.debug(formatDebugEvent(event));
  }
}

export async function withRpcDebug<T>(
  debug: SimulationDebug | undefined,
  event: Omit<SimulationDebugEvent, "phase">,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  emitDebug(debug, { ...event, phase: "start" });

  try {
    const result = await run();
    emitDebug(debug, { ...event, phase: "success", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    emitDebug(debug, {
      ...event,
      phase: "error",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function envDebugEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.VIEM_TX_SIM_DEBUG_RPC === "1";
}

function formatDebugEvent(event: SimulationDebugEvent): string {
  const parts = [
    `[viem-tx-sim] ${event.phase} ${event.method}`,
    `step=${event.step}`,
    ...(event.durationMs === undefined ? [] : [`durationMs=${event.durationMs}`]),
    ...Object.entries(event.details ?? {}).map(([key, value]) => `${key}=${formatValue(value)}`),
    ...(event.error ? [`error=${event.error}`] : []),
  ];
  return parts.join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatValue).join(",")}]`;
  return String(value);
}
