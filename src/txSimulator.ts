import type { PublicClient } from "viem";

import { discoverRequirements } from "./requirements.js";
import { simulate } from "./simulate.js";
import { discoverAllowanceSlots, discoverBalanceSlots } from "./slots.js";
import type { SimulateArgs, SimulationDebug } from "./types.js";

type BoundArgs = {
  client: PublicClient;
  gas?: bigint;
  debug?: SimulationDebug;
};

type BoundCallDefaults = {
  gas?: bigint;
  debug?: SimulationDebug;
};

type BoundSimulateArgs = Omit<SimulateArgs, "client">;
type BoundBalanceSlotsArgs = Omit<Parameters<typeof discoverBalanceSlots>[0], "client">;
type BoundAllowanceSlotsArgs = Omit<Parameters<typeof discoverAllowanceSlots>[0], "client">;
type BoundRequirementsArgs = Omit<Parameters<typeof discoverRequirements>[0], "client">;

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
   * allowances; pass `tokenSlotOverrides` from the discovery methods when previewing view-only or
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
  simulate: (args: BoundSimulateArgs) => ReturnType<typeof simulate>;

  /**
   * Discovers ERC-20 balance storage slots for tokens owned by `from`.
   *
   * Each token is probed with RPC-only access lists and sentinel state overrides. Tokens whose slot
   * cannot be found and verified are returned in `unresolved` rather than thrown.
   *
   * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
   */
  discoverBalanceSlots: (args: BoundBalanceSlotsArgs) => ReturnType<typeof discoverBalanceSlots>;

  /**
   * Discovers ERC-20 allowance storage slots for token/spender pairs owned by `from`.
   *
   * Standard Solidity allowance layouts are inferred after one verified probe per token where
   * possible; non-standard layouts fall back to per-pair probing. Pairs whose slot cannot be found
   * and verified are returned in `unresolved` rather than thrown.
   *
   * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
   */
  discoverAllowanceSlots: (
    args: BoundAllowanceSlotsArgs,
  ) => ReturnType<typeof discoverAllowanceSlots>;

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
  discoverRequirements: (args: BoundRequirementsArgs) => ReturnType<typeof discoverRequirements>;
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
  create(bound: BoundArgs): TxSimulator {
    const defaults = (args: BoundCallDefaults) => {
      const gas = args.gas ?? bound.gas;
      const debug = args.debug ?? bound.debug;

      return {
        ...(gas !== undefined ? { gas } : {}),
        ...(debug !== undefined ? { debug } : {}),
      };
    };

    return {
      simulate: (args) => simulate({ ...args, ...defaults(args), client: bound.client }),
      discoverBalanceSlots: (args) =>
        discoverBalanceSlots({ ...args, ...defaults(args), client: bound.client }),
      discoverAllowanceSlots: (args) =>
        discoverAllowanceSlots({ ...args, ...defaults(args), client: bound.client }),
      discoverRequirements: (args) =>
        discoverRequirements({ ...args, ...defaults(args), client: bound.client }),
    };
  },
};
