import { DEFAULT_SIMULATION_GAS_LIMIT } from "./constants.js";
import { InvalidSimulationInputError } from "./errors.js";
import { discoverRequirements } from "./internal/requirements.js";
import { blockOptionsSpread, type ClientArgs } from "./internal/rpc.js";
import { discoverCandidateAddresses, runSimulator } from "./internal/simulator.js";
import { discoverAllowanceSlots, discoverBalanceSlots } from "./internal/slots.js";
import type {
  AllowanceSlotDiscovery,
  BalanceSlotDiscovery,
  DiscoverAllowanceSlotsArgs,
  DiscoverBalanceSlotsArgs,
  DiscoverRequirementsArgs,
  DiscoveredRequirements,
  SimulateArgs,
  SimulatedCall,
  SimulationResult,
  TxSimulatorConfig,
} from "./types.js";

type BoundCallDefaults = {
  gas?: bigint;
  debug?: TxSimulatorConfig["debug"];
  errorAbi?: TxSimulatorConfig["errorAbi"];
};

/**
 * Bound transaction simulator for one viem public client.
 *
 * Bind the RPC client once, then pass `from` per call so applications can switch accounts without
 * rebuilding the simulator. Per-call `gas` and `debug` override defaults supplied to
 * {@link TxSimulator.create}.
 */
export interface TxSimulator {
  /**
   * Simulates one call or sequential batch and returns raw native/token balance deltas.
   *
   * This uses `eth_createAccessList` for candidate discovery and one `eth_call` with state
   * overrides that injects the simulator at `from`. It does not automatically forge balances or
   * allowances; discovery methods return ready-to-use `tokenSlotOverrides` for view-only or
   * unfunded accounts. Transaction reverts return `status: "reverted"` instead of throwing.
   *
   * @throws InvalidSimulationInputError when `calls` is empty.
   * @throws AccessListUnsupportedError when the RPC endpoint cannot provide access lists.
   * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides or
   * returns undecodable simulator output.
   *
   * @example
   * ```ts
   * const sim = TxSimulator.create({ client });
   * const result = await sim.simulate({
   *   from,
   *   calls: [{ to, data, value: 0n }],
   * });
   * ```
   */
  simulate: (args: SimulateArgs) => Promise<SimulationResult>;

  /**
   * Discovers ERC-20 balance storage slots for tokens owned by `from`.
   *
   * Each token is probed with RPC-only access lists and sentinel state overrides. Tokens the
   * simulator cannot `deal` by verified storage write are returned in `unresolved` rather than
   * thrown.
   *
   * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
   */
  discoverBalanceSlots: (args: DiscoverBalanceSlotsArgs) => Promise<BalanceSlotDiscovery>;

  /**
   * Discovers ERC-20 allowance storage slots for token/spender pairs owned by `from`.
   *
   * Standard Solidity allowance layouts are inferred after one verified probe per token where
   * possible; non-standard layouts fall back to per-pair probing. Pairs the simulator cannot `deal`
   * by verified storage write are returned in `unresolved` rather than thrown.
   *
   * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
   */
  discoverAllowanceSlots: (args: DiscoverAllowanceSlotsArgs) => Promise<AllowanceSlotDiscovery>;

  /**
   * Measures required balances and approvals by forging generous state and observing outflows.
   *
   * Use this when the tokens or spenders are not known ahead of time. Returned amounts are measured
   * under forged balances/allowances and should be padded before display or transaction assembly;
   * unreliable measurements are reported under `unresolved`.
   *
   * @throws InvalidSimulationInputError when `calls` is empty.
   * @throws AccessListUnsupportedError when the RPC endpoint cannot provide access lists.
   * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides or
   * returns undecodable simulator output.
   */
  discoverRequirements: (args: DiscoverRequirementsArgs) => Promise<DiscoveredRequirements>;
}

/** Factory for {@link TxSimulator} instances bound to one viem public client. */
export const TxSimulator = {
  /**
   * Creates a simulator with optional default gas and debug settings.
   *
   * `gas` defaults to `DEFAULT_SIMULATION_GAS_LIMIT`; `debug` may be `true` for console logging or a
   * callback for structured events. Per-call `gas` and `debug` take precedence over these defaults.
   *
   * @example
   * ```ts
   * const sim = TxSimulator.create({ client, debug: true });
   * const result = await sim.simulate({ from, calls });
   * ```
   */
  create(bound: TxSimulatorConfig): TxSimulator {
    const defaults = (args: BoundCallDefaults) => {
      const gas = args.gas ?? bound.gas ?? DEFAULT_SIMULATION_GAS_LIMIT;
      const debug = args.debug ?? bound.debug;

      return {
        gas,
        ...(debug !== undefined ? { debug } : {}),
      };
    };
    const revertDefaults = (args: BoundCallDefaults) => {
      const errorAbi = [...(bound.errorAbi ?? []), ...(args.errorAbi ?? [])];

      return {
        ...defaults(args),
        ...(errorAbi.length > 0 ? { errorAbi } : {}),
      };
    };

    return {
      simulate: (args) => runSimulate({ ...args, ...revertDefaults(args), client: bound.client }),
      discoverBalanceSlots: (args) =>
        discoverBalanceSlots({ ...args, ...defaults(args), client: bound.client }),
      discoverAllowanceSlots: (args) =>
        discoverAllowanceSlots({ ...args, ...defaults(args), client: bound.client }),
      discoverRequirements: (args) =>
        discoverRequirements({ ...args, ...revertDefaults(args), client: bound.client }),
    };
  },
};

async function runSimulate(args: SimulateArgs & ClientArgs): Promise<SimulationResult> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("simulate requires at least one call.");
  }

  const calls = args.calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];
  const candidateAddresses = await discoverCandidateAddresses({
    client: args.client,
    from: args.from,
    calls,
    ...blockOptionsSpread(args),
    gas: args.gas,
    ...(args.debug !== undefined ? { debug: args.debug } : {}),
  });

  const tokenSlotOverrides = args.tokenSlotOverrides ?? [];

  return runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: [...candidateAddresses, ...tokenSlotOverrides.map((slot) => slot.token)],
    tokenSlotOverrides,
    debug: args.debug,
    ...blockOptionsSpread(args),
    gas: args.gas,
    ...(args.errorAbi !== undefined ? { errorAbi: args.errorAbi } : {}),
  });
}
