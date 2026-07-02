import type { Address, BlockTag, Hex, PublicClient } from "viem";

export type SimulatedCall = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type SimulationDebugEvent = {
  phase: "start" | "success" | "error";
  method: "eth_call" | "eth_createAccessList";
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

type DiscoveredRequirementsBase = {
  /** Max cumulative native outflow across call boundaries. */
  native: bigint;
  balances: RequiredBalance[];
  allowances: RequiredAllowance[];
  /** Verified slots discovered along the way - pass to simulate() as tokenSlotOverrides. */
  slots: TokenSlotOverride[];
};

export type DiscoveredRequirementsSuccess = DiscoveredRequirementsBase & {
  status: "success";
};

export type DiscoveredRequirementsReverted = DiscoveredRequirementsBase & {
  status: "reverted";
  revertData: Hex;
  revertReason?: string;
  failingCallIndex: number;
};

export type DiscoveredRequirements = DiscoveredRequirementsSuccess | DiscoveredRequirementsReverted;

export type AssetBalanceDelta = {
  asset: "native" | Address;
  delta: bigint;
};

export type SimulationSuccess = {
  status: "success";
  assetBalanceDeltas: AssetBalanceDelta[];
};

export type SimulationReverted = {
  status: "reverted";
  assetBalanceDeltas: AssetBalanceDelta[];
  revertData: Hex;
  /** Present when revertData decodes as a standard Error(string)/Panic. */
  revertReason?: string;
  failingCallIndex: number;
};

export type SimulationResult = SimulationSuccess | SimulationReverted;
