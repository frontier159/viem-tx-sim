import type { Abi, Address, BlockTag, Hex, PublicClient } from "viem";

/** One transaction-like call to execute during a simulation batch. */
export type SimulatedCall = {
  /** Target contract or recipient address. */
  to: Address;
  /** ABI-encoded calldata. Use `"0x"` for a plain native transfer. */
  data: Hex;
  /** Native value to send with this call; omitted means zero. */
  value?: bigint;
};

/** Structured event emitted before and after each RPC call when debug logging is enabled. */
export type SimulationDebugEvent = {
  /** Lifecycle phase for the RPC operation. */
  phase: "start" | "success" | "error";
  /** RPC method being issued. */
  method: "eth_call" | "eth_createAccessList";
  /** Stable step name used by tests and consumers to count RPCs. */
  step: string;
  /** Step-specific metadata, intentionally small and non-sensitive. */
  details?: Record<string, unknown>;
  /** Elapsed RPC time in milliseconds, present on success/error phases. */
  durationMs?: number;
  /** Human-readable error summary, present on error phases. */
  error?: string;
};

/** Callback form for receiving structured simulation debug events. */
export type SimulationDebugLogger = (event: SimulationDebugEvent) => void;

/** Debug option: `true` logs to the console, a callback receives structured events. */
export type SimulationDebug = boolean | SimulationDebugLogger;

/** Shared per-call options for block selection, gas budget, and debug events. */
type SimulationOptions = {
  /** Historical block number to simulate against; if both block options are set, this wins. */
  blockNumber?: bigint;
  /** Block tag to simulate against when `blockNumber` is not set. */
  blockTag?: BlockTag;
  /** Gas budget for simulation RPC calls. Defaults to `DEFAULT_SIMULATION_GAS_LIMIT`. */
  gas?: bigint;
  /** Enables console logging or structured debug events for simulator RPC calls. */
  debug?: SimulationDebug;
};

/**
 * Storage-slot override: the unit that flows from discovery methods into
 * `simulate({ tokenSlotOverrides })`.
 */
export type TokenSlotOverride = {
  /** Token contract whose storage should be overridden. */
  token: Address;
  /** Storage slot to write. Usually discovered by `discoverBalanceSlots` or `discoverAllowanceSlots`. */
  slot: Hex;
  /** Value written to the slot. Must be below uint256 max. */
  amount: bigint;
};

/** Verified ERC-20 allowance mapping slot for one token, owner, and spender. */
export type AllowanceSlot = TokenSlotOverride & {
  spender: Address;
};

/** Token/spender pair whose allowance slot should be discovered or reported unresolved. */
export type AllowanceSlotPair = {
  token: Address;
  spender: Address;
};

/** Result of balance-slot discovery. */
export type BalanceSlotDiscovery = {
  /** Verified slots that can be passed to `simulate` as `tokenSlotOverrides`. */
  slots: TokenSlotOverride[];
  /**
   * Tokens the simulator could not `deal` in the Foundry sense: no storage slot could be
   * sentinel-verified for writing hypothetical balances. Deltas for real holdings still come from
   * `balanceOf`, including rebasing tokens.
   */
  unresolved: Address[];
};

/** Result of allowance-slot discovery. */
export type AllowanceSlotDiscovery = {
  /** Verified slots that can be passed to `simulate` as `tokenSlotOverrides`. */
  slots: AllowanceSlot[];
  /** Pairs the simulator could not `deal` as allowances because no slot was sentinel-verified. */
  unresolved: AllowanceSlotPair[];
};

/** ABI-decoded revert error, present when revertData matches supplied error definitions or a built-in Error/Panic. */
export type RevertError = {
  name: string;
  args: readonly unknown[];
};

/** Arguments for `TxSimulator.simulate`. */
export type SimulateArgs = SimulationOptions & {
  /** Account being simulated; the ghost simulator bytecode is injected at this address. */
  from: Address;
  /** One call or an ERC-5792-style sequential batch. Must contain at least one call. */
  calls: readonly SimulatedCall[];
  /** Storage-slot overrides applied before simulating. Usually from slot discovery. */
  tokenSlotOverrides?: readonly TokenSlotOverride[];
  /** Additional error definitions for decoding this call's reverts; merged after the bound errorAbi. */
  errorAbi?: Abi;
};

/** Arguments for `TxSimulator.discoverBalanceSlots`. */
export type DiscoverBalanceSlotsArgs = SimulationOptions & {
  /** Account whose token balance storage slots should be found. */
  from: Address;
  /** Tokens to probe for ERC-20-style balance slots. */
  tokens: readonly Address[];
};

/** Arguments for `TxSimulator.discoverAllowanceSlots`. */
export type DiscoverAllowanceSlotsArgs = SimulationOptions & {
  /** Account whose allowance storage slots should be found. */
  from: Address;
  /** Token/spender allowance pairs to probe. */
  pairs: readonly AllowanceSlotPair[];
};

/** Arguments for `TxSimulator.discoverRequirements`. */
export type DiscoverRequirementsArgs = SimulationOptions & {
  /** Account whose balances and approvals should be measured. */
  from: Address;
  /** One call or an ERC-5792-style sequential batch. Must contain at least one call. */
  calls: readonly SimulatedCall[];
  /** Additional error definitions for decoding this call's reverts; merged after the bound errorAbi. */
  errorAbi?: Abi;
};

/** Configuration for `TxSimulator.create`. */
export type TxSimulatorConfig = {
  client: PublicClient;
  /** Default gas budget for all calls; per-call `gas` wins. */
  gas?: bigint;
  /** Default debug setting for all calls; per-call `debug` wins. */
  debug?: SimulationDebug;
  /** Error definitions used to decode custom-error reverts; merged with per-call errorAbi. */
  errorAbi?: Abi;
};

/** Minimum token balance requirement measured under forged state. */
export type RequiredBalance = {
  token: Address;
  amount: bigint;
};

/** Minimum total allowance requirement measured under forged state. */
export type RequiredAllowance = {
  token: Address;
  spender: Address;
  amount: bigint;
};

type DiscoveredRequirementsBase = {
  /** Maximum cumulative native outflow across call boundaries. */
  native: bigint;
  /** Minimum token balances needed to execute the observed path. */
  balances: RequiredBalance[];
  /** Minimum allowances needed before the batch, excluding allowances set inside the batch. */
  allowances: RequiredAllowance[];
  /** Verified slots discovered along the way; pass to `simulate` as `tokenSlotOverrides`. */
  slots: TokenSlotOverride[];
  /** Values the requirement probe could not verify or could not trust. */
  unresolved: {
    /**
     * Tokens the requirement probe could not `deal` in the Foundry sense: no balance slot could be
     * sentinel-verified for writing hypothetical balances. Real-holding deltas are unaffected.
     */
    balanceSlots: Address[];
    /** Token/spender pairs the requirement probe could not `deal` as allowances. */
    allowanceSlots: AllowanceSlotPair[];
    /** Token/spender pairs measured but discarded as unreliable, usually because they exceeded gross outflow. */
    allowances: AllowanceSlotPair[];
  };
};

/** Successful requirement measurement. */
export type DiscoveredRequirementsSuccess = DiscoveredRequirementsBase & {
  status: "success";
};

/** Requirement measurement that still observed a transaction revert after forging available state. */
export type DiscoveredRequirementsReverted = DiscoveredRequirementsBase & {
  status: "reverted";
  /** Raw EVM revert data from the failing simulated call. */
  revertData: Hex;
  /** Human-readable decoded revert; present when revertData decodes via supplied error definitions or as built-in Error/Panic. */
  revertReason?: string;
  /** Decoded error when revertData matches supplied error definitions or built-in Error/Panic. */
  revertError?: RevertError;
  /** First 4 bytes of revertData; present whenever revertData carries a selector. */
  revertSelector?: Hex;
  /** Zero-based index of the call that reverted. */
  failingCallIndex: number;
};

/** Requirement measurement result; check `status` before reading revert fields. */
export type DiscoveredRequirements = DiscoveredRequirementsSuccess | DiscoveredRequirementsReverted;

/** Raw balance delta for native ETH or an ERC-20-style `balanceOf(address)` asset. */
export type AssetBalanceDelta = {
  /** `"native"` for ETH, otherwise the token contract address. */
  asset: "native" | Address;
  /** Signed raw-unit balance change for `from`; negative means the account lost assets. */
  delta: bigint;
};

/** Successful simulation result. */
export type SimulationSuccess = {
  status: "success";
  /** Non-zero raw balance deltas observed during the simulated execution. */
  assetBalanceDeltas: AssetBalanceDelta[];
};

/** Simulation result for a transaction revert; infrastructure failures throw typed errors instead. */
export type SimulationReverted = {
  status: "reverted";
  /** Non-zero raw balance deltas observed before the failing call. */
  assetBalanceDeltas: AssetBalanceDelta[];
  /** Raw EVM revert data from the failing simulated call. */
  revertData: Hex;
  /** Human-readable decoded revert; present when revertData decodes via supplied error definitions or as built-in Error/Panic. */
  revertReason?: string;
  /** Decoded error when revertData matches supplied error definitions or built-in Error/Panic. */
  revertError?: RevertError;
  /** First 4 bytes of revertData; present whenever revertData carries a selector. */
  revertSelector?: Hex;
  /** Zero-based index of the call that reverted. */
  failingCallIndex: number;
};

/** Simulation result; transaction reverts are data, while RPC/infrastructure failures throw. */
export type SimulationResult = SimulationSuccess | SimulationReverted;
