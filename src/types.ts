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

/** One balance to observe during simulation. `asset` is `"native"` or an ERC-20 address. */
export type BalanceQuery = {
  asset: "native" | Address;
  /** Account whose balance is observed; this can be any address, not just `from`. */
  account: Address;
};

/**
 * Balance observation for one query. `before` is after `tokenSlotOverrides` are applied, so deltas
 * describe simulated changes under the supplied state assumptions.
 */
export type BalanceDelta = {
  asset: "native" | Address;
  account: Address;
  before: bigint;
  after: bigint;
  delta: bigint;
  /**
   * Signed change per call, index-aligned with `calls`. Sums to `delta`; on a
   * revert, entries from the failing call onward are 0n.
   */
  byCall: readonly bigint[];
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
 * Storage-slot override: the unit that flows from preparation methods into
 * `simulate({ tokenSlotOverrides })`.
 */
export type TokenSlotOverride = {
  /** Token contract whose storage should be overridden. */
  token: Address;
  /** Storage slot to write. Usually prepared by `tokenOverrides.forBalances` or `tokenOverrides.forAllowances`. */
  slot: Hex;
  /** Value written to the slot. Must be below uint256 max. */
  amount: bigint;
};

/** Verified ERC-20 allowance mapping slot for one token, owner, and spender. */
export type AllowanceSlot = TokenSlotOverride & {
  spender: Address;
};

/** Token/spender pair whose allowance override should be prepared or reported unresolved. */
export type AllowanceSlotPair = {
  token: Address;
  spender: Address;
};

/** Prepared balance storage overrides. */
export type PreparedBalanceOverrides = {
  /** Verified slots that can be passed to `simulate` as `tokenSlotOverrides`. */
  slots: TokenSlotOverride[];
  /**
   * Tokens the simulator could not `deal` in the Foundry sense: no storage slot could be
   * sentinel-verified for writing hypothetical balances. Deltas for real holdings still come from
   * `balanceOf`, including rebasing tokens.
   */
  unresolved: Address[];
};

/** Prepared allowance storage overrides. */
export type PreparedAllowanceOverrides = {
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
  /** Balances to observe. Use `[]` to execute without balance observations. */
  balanceQueries: readonly BalanceQuery[];
  /**
   * Storage-slot overrides applied before simulating. Query the tokens you forge if you want to
   * observe them.
   */
  tokenSlotOverrides?: readonly TokenSlotOverride[];
  /** Additional error definitions for decoding this call's reverts; merged after the bound errorAbi. */
  errorAbi?: Abi;
};

/** Arguments for `TxSimulator.balanceQueries.forUser`. */
export type ForUserBalanceQueriesArgs = SimulationOptions & {
  /** Account whose wallet-style balance queries should be discovered. */
  from: Address;
  /** Calls whose access lists should be searched for token candidates. */
  calls: readonly SimulatedCall[];
};

/** Arguments for `TxSimulator.tokenOverrides.forBalances`. */
export type PrepareBalanceOverridesArgs = SimulationOptions & {
  /** Account whose token balance overrides should be prepared. */
  from: Address;
  /** Tokens to prepare ERC-20-style balance overrides for. */
  tokens: readonly Address[];
};

/** Arguments for `TxSimulator.tokenOverrides.forAllowances`. */
export type PrepareAllowanceOverridesArgs = SimulationOptions & {
  /** Account whose allowance overrides should be prepared. */
  from: Address;
  /** Token/spender allowance pairs to prepare overrides for. */
  pairs: readonly AllowanceSlotPair[];
};

/** Arguments for `TxSimulator.tokenOverrides.estimateRequirements`. */
export type EstimateAssetRequirementsArgs = SimulationOptions & {
  /** Account whose balance and approval needs should be estimated. */
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

/** Estimated minimum token balance needed under forged state. */
export type RequiredBalance = {
  token: Address;
  amount: bigint;
};

/** Estimated minimum total allowance needed under forged state. */
export type RequiredAllowance = {
  token: Address;
  spender: Address;
  amount: bigint;
};

type EstimatedAssetRequirementsBase = {
  /** Maximum cumulative native outflow across call boundaries. */
  native: bigint;
  /** Minimum token balances needed to execute the observed path. */
  balances: RequiredBalance[];
  /** Minimum allowances needed before the batch, excluding allowances set inside the batch. */
  allowances: RequiredAllowance[];
  /** Verified slots prepared along the way; pass to `simulate` as `tokenSlotOverrides`. */
  slots: TokenSlotOverride[];
  /** Values the estimator could not verify or could not trust. */
  unresolved: {
    /**
     * Tokens the estimator could not `deal` in the Foundry sense: no balance slot could be
     * sentinel-verified for writing hypothetical balances. Real-holding deltas are unaffected.
     */
    balanceSlots: Address[];
    /** Token/spender pairs the estimator could not `deal` as allowances. */
    allowanceSlots: AllowanceSlotPair[];
    /** Token/spender pairs measured but discarded as unreliable, usually because they exceeded gross outflow. */
    allowances: AllowanceSlotPair[];
  };
};

/** Successful asset-requirement estimate. */
export type EstimatedAssetRequirementsSuccess = EstimatedAssetRequirementsBase & {
  status: "success";
};

/** Asset-requirement estimate that still observed a transaction revert after forging available state. */
export type EstimatedAssetRequirementsReverted = EstimatedAssetRequirementsBase & {
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

/** Asset-requirement estimate result; check `status` before reading revert fields. */
export type EstimatedAssetRequirements =
  | EstimatedAssetRequirementsSuccess
  | EstimatedAssetRequirementsReverted;

/** Successful simulation result. */
export type SimulationSuccess = {
  status: "success";
  /** Balance observations mirrored 1:1 from successful queries, including zero deltas. */
  balanceDeltas: BalanceDelta[];
  /** Queries that could not be read, usually because an ERC-20 `balanceOf` staticcall failed. */
  unresolved: BalanceQuery[];
};

/** Simulation result for a transaction revert; infrastructure failures throw typed errors instead. */
export type SimulationReverted = {
  status: "reverted";
  /** Balance observations mirrored 1:1 from successful queries, including zero deltas. */
  balanceDeltas: BalanceDelta[];
  /** Queries that could not be read, usually because an ERC-20 `balanceOf` staticcall failed. */
  unresolved: BalanceQuery[];
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
