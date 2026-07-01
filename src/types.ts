import type { Address, BlockTag, Hex, PublicClient } from "viem";

export type SimulatedCall = {
  to: Address;
  calldata: Hex;
  value?: bigint;
};

export type SimulationDebugEvent = {
  phase: "start" | "success" | "error";
  method: "eth_call" | "eth_createAccessList" | "eth_getCode";
  step: string;
  details?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
};

export type SimulationDebugLogger = (event: SimulationDebugEvent) => void;
export type SimulationDebug = boolean | SimulationDebugLogger;

export type SimulateArgs = {
  client: PublicClient;
  from: Address;
  calls: readonly SimulatedCall[];
  blockNumber?: bigint;
  blockTag?: BlockTag;
  gas?: bigint;
  debug?: SimulationDebug;
};

export type AssetBalanceDelta = {
  asset: "native" | Address;
  delta: bigint;
  /** Present for negative ERC-20 deltas when one spender can be isolated. */
  spender?: Address;
  /** Allowance currently available before simulation. */
  currentAllowance?: bigint;
};

export type SimulationResult = {
  status: "success" | "reverted";
  assetBalanceDeltas: AssetBalanceDelta[];
  revertData?: Hex;
  revertReason?: string;
  failingCallIndex?: number;
};
