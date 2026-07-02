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

export type BalanceSlot = {
  token: Address;
  slot: Hex;
};

export type AllowanceSlot = {
  token: Address;
  spender: Address;
  slot: Hex;
};

export type TokenSlotOverride = {
  token: Address;
  slot: Hex;
  /** Value written to the slot before simulating. Defaults to 10^50. */
  amount?: bigint;
};

export type SimulateArgs = {
  client: PublicClient;
  from: Address;
  calls: readonly SimulatedCall[];
  blockNumber?: bigint;
  blockTag?: BlockTag;
  gas?: bigint;
  debug?: SimulationDebug;
  /** Storage-slot overrides applied before simulating. Usually from discoverBalanceSlots/discoverAllowanceSlots. */
  tokenSlotOverrides?: readonly TokenSlotOverride[];
};

export type RequiredBalance = {
  token: Address;
  amount: bigint;
};

export type RequiredAllowance = {
  token: Address;
  spender: Address;
  amount: bigint;
};

export type DiscoveredRequirements = {
  /** Outcome of the fully-forged measurement simulation. */
  status: "success" | "reverted";
  /** Max cumulative native outflow across call boundaries. */
  native: bigint;
  balances: RequiredBalance[];
  allowances: RequiredAllowance[];
  /** Verified slots discovered along the way - pass to simulate() as tokenSlotOverrides. */
  slots: TokenSlotOverride[];
  revertData?: Hex;
  revertReason?: string;
  failingCallIndex?: number;
};

export type AssetBalanceDelta = {
  asset: "native" | Address;
  delta: bigint;
};

export type SimulationResult = {
  status: "success" | "reverted";
  assetBalanceDeltas: AssetBalanceDelta[];
  revertData?: Hex;
  revertReason?: string;
  failingCallIndex?: number;
};
