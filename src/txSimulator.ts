import type { Address } from "viem";

import { DEFAULT_SIMULATION_GAS_LIMIT } from "./constants.js";
import { InvalidSimulationInputError } from "./errors.js";
import { discoverErc20s, forUserBalanceQueries } from "./internal/queryDiscovery.js";
import { estimateTokenOverrideRequirements } from "./internal/requirements.js";
import { blockOptionsSpread, type ClientArgs } from "./internal/rpc.js";
import { runSimulator } from "./internal/simulator.js";
import { prepareAllowanceTokenOverrides, prepareBalanceTokenOverrides } from "./internal/slots.js";
import type {
  BalanceDelta,
  BalanceQuery,
  ForUserBalanceQueriesArgs,
  PreparedAllowanceOverrides,
  PreparedBalanceOverrides,
  PrepareAllowanceOverridesArgs,
  PrepareBalanceOverridesArgs,
  EstimateAssetRequirementsArgs,
  EstimatedAssetRequirements,
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
   * Simulates one call or sequential batch and returns requested balance deltas.
   *
   * This performs one `eth_call` with state overrides that inject the simulator at `from`.
   * Balances are observed only for `balanceQueries`; query the tokens you forge if you want to
   * observe them. Transaction reverts return `status: "reverted"` instead of throwing.
   *
   * @throws InvalidSimulationInputError when `calls` is empty.
   * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides or
   * returns undecodable simulator output.
   *
   * @example
   * ```ts
   * const sim = TxSimulator.create({ client });
   * const result = await sim.simulate({
   *   from,
   *   calls: [{ to, data, value: 0n }],
   *   balanceQueries: [{ asset: "native", account: from }],
   * });
   * ```
   */
  simulate: (args: SimulateArgs) => Promise<SimulationResult>;

  readonly balanceQueries: {
    /**
     * Discovers wallet-style balance queries for `from`.
     *
     * This runs access-list candidate discovery, then one token-filter `eth_call`, and returns
     * native plus token balance queries for `from`. Pass the result to `simulate`.
     *
     * @throws AccessListUnsupportedError when the RPC endpoint cannot provide access lists.
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
     */
    forUser: (args: ForUserBalanceQueriesArgs) => Promise<BalanceQuery[]>;

    /**
     * Discovers ERC-20 contracts touched by the calls that answer `balanceOf(from)`.
     *
     * This is the discovery half of `forUser`; map the returned addresses yourself when observing a
     * different account.
     *
     * @throws AccessListUnsupportedError when the RPC endpoint cannot provide access lists.
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
     */
    discoverErc20s: (args: ForUserBalanceQueriesArgs) => Promise<Address[]>;
  };

  readonly tokenOverrides: {
    /**
     * Prepares ERC-20 balance overrides for `from`.
     *
     * Each token is probed with RPC-only access lists and sentinel state overrides. Tokens the
     * simulator cannot `deal` by verified storage write are returned in `unresolved` rather than
     * thrown.
     *
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
     */
    forBalances: (args: PrepareBalanceOverridesArgs) => Promise<PreparedBalanceOverrides>;

    /**
     * Prepares ERC-20 allowance overrides for `from` and the requested token/spender pairs.
     *
     * Standard Solidity allowance layouts are inferred after one verified probe per token where
     * possible; non-standard layouts fall back to per-pair probing. Pairs the simulator cannot
     * `deal` via verified storage write are returned in `unresolved` rather than thrown.
     *
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
     */
    forAllowances: (args: PrepareAllowanceOverridesArgs) => Promise<PreparedAllowanceOverrides>;

    /**
     * Estimates the balances and approvals needed to execute the observed path.
     *
     * Use this when the tokens or spenders are not known ahead of time. Returned amounts are
     * estimated under forged balances/allowances and should be padded before display or transaction
     * assembly; unreliable measurements are reported under `unresolved`.
     *
     * @throws InvalidSimulationInputError when `calls` is empty.
     * @throws AccessListUnsupportedError when the RPC endpoint cannot provide access lists.
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides or
     * returns undecodable simulator output.
     */
    estimateRequirements: (
      args: EstimateAssetRequirementsArgs,
    ) => Promise<EstimatedAssetRequirements>;
  };
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
      balanceQueries: {
        forUser: (args) =>
          forUserBalanceQueries({ ...args, ...defaults(args), client: bound.client }),
        discoverErc20s: (args) =>
          discoverErc20s({ ...args, ...defaults(args), client: bound.client }),
      },
      tokenOverrides: {
        forBalances: (args) =>
          prepareBalanceTokenOverrides({ ...args, ...defaults(args), client: bound.client }),
        forAllowances: (args) =>
          prepareAllowanceTokenOverrides({ ...args, ...defaults(args), client: bound.client }),
        estimateRequirements: (args) =>
          estimateTokenOverrideRequirements({
            ...args,
            ...revertDefaults(args),
            client: bound.client,
          }),
      },
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
  const tokenSlotOverrides = args.tokenSlotOverrides ?? [];

  const result = await runSimulator({
    client: args.client,
    from: args.from,
    calls,
    candidates: [],
    tokenSlotOverrides,
    extraStateOverrides: (args.nativeBalanceOverrides ?? []).map((override) => ({
      address: override.account,
      balance: override.amount,
    })),
    balanceProbes: args.balanceQueries.map((query) => ({
      token: query.asset,
      account: query.account,
    })),
    debug: args.debug,
    ...blockOptionsSpread(args),
    gas: args.gas,
    ...(args.errorAbi !== undefined ? { errorAbi: args.errorAbi } : {}),
  });
  const balances = buildBalanceResults(args.balanceQueries, result.probeData, calls.length);

  if (result.status === "reverted") {
    return {
      status: "reverted",
      ...balances,
      revertData: result.revertData,
      ...(result.revertReason !== undefined ? { revertReason: result.revertReason } : {}),
      ...(result.revertError !== undefined ? { revertError: result.revertError } : {}),
      ...(result.revertSelector !== undefined ? { revertSelector: result.revertSelector } : {}),
      failingCallIndex: result.failingCallIndex,
    };
  }

  return { status: "success", ...balances };
}

type BalanceResultFields = {
  balanceDeltas: BalanceDelta[];
  unresolved: BalanceQuery[];
};

function buildBalanceResults(
  queries: readonly BalanceQuery[],
  probeData: {
    balanceCheckpoints: readonly bigint[];
    balanceProbeOk: readonly boolean[];
  },
  callsLength: number,
): BalanceResultFields {
  const balanceDeltas: BalanceDelta[] = [];
  const unresolved: BalanceQuery[] = [];
  const stride = callsLength + 1;

  for (let i = 0; i < queries.length; ++i) {
    const query = queries[i];
    if (query === undefined) continue;
    if (probeData.balanceProbeOk[i] !== true) {
      unresolved.push(query);
      continue;
    }
    const base = i * stride;
    const before = probeData.balanceCheckpoints[base] ?? 0n;
    const after = probeData.balanceCheckpoints[base + callsLength] ?? 0n;
    const byCall = Array.from(
      { length: callsLength },
      (_, callIndex) =>
        (probeData.balanceCheckpoints[base + callIndex + 1] ?? 0n) -
        (probeData.balanceCheckpoints[base + callIndex] ?? 0n),
    );
    balanceDeltas.push({
      asset: query.asset,
      account: query.account,
      before,
      after,
      delta: after - before,
      byCall,
    });
  }

  return { balanceDeltas, unresolved };
}
