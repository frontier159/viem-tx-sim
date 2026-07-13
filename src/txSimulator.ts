import type { Address } from "viem";
import { decodeAbiParameters } from "viem";

import { DEFAULT_SIMULATION_GAS_LIMIT } from "./constants.js";
import { InvalidSimulationInputError } from "./errors.js";
import { buildBalanceResults } from "./internal/checkpoints.js";
import { discoverErc20s, forUserBalanceQueries } from "./internal/queryDiscovery.js";
import { estimateAssetRequirements } from "./internal/requirements.js";
import { blockOptionsSpread, type ClientArgs } from "./internal/rpc.js";
import { intrinsicAndCalldataGas } from "./internal/gas.js";
import { runBatchGas, runSimulator, type RawNftReceipt } from "./internal/simulator.js";
import {
  prepareAllowanceOverrides,
  prepareBalanceOverrides,
  preparePermit2Overrides,
} from "./internal/slots.js";
import type {
  BalanceQuery,
  BatchGasEstimate,
  EstimateBatchGasArgs,
  ForPermit2AllowancesArgs,
  ForUserBalanceQueriesArgs,
  PreparedAllowanceOverrides,
  PreparedBalanceOverrides,
  PreparedPermit2Overrides,
  PrepareAllowanceOverridesArgs,
  PrepareBalanceOverridesArgs,
  EstimateAssetRequirementsArgs,
  EstimatedAssetRequirements,
  NftReceipt,
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
     * When the provider rejects access lists because `from` cannot fund the calls, discovery
     * degrades to the direct call targets (direct transfers still discovered; intermediary tokens
     * touched later in the call may be missed).
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
     * When the provider rejects access lists because `from` cannot fund the calls, discovery
     * degrades to the direct call targets (direct transfers still discovered; intermediary tokens
     * touched later in the call may be missed).
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
     * @throws AccessListUnsupportedError when the RPC endpoint cannot provide access lists.
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
     * @throws AccessListUnsupportedError when the RPC endpoint cannot provide access lists.
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
     */
    forAllowances: (args: PrepareAllowanceOverridesArgs) => Promise<PreparedAllowanceOverrides>;

    /**
     * Prepares Permit2 internal-allowance overrides for `from` and the requested token/spender pairs.
     *
     * Permit2's allowance lives in a triple-nested `allowance(owner, token, spender)` mapping the
     * ERC-20 `forAllowances` probing cannot reach. Each override is sentinel-verified, forges a
     * generous amount and far-future expiration, and preserves the on-chain nonce so signed
     * `permit()` calls still verify. Returned `slots[i].token` is the Permit2 address (the account
     * whose storage is overridden), index-aligned with `pairs`; spread `slots` into
     * `simulate({ tokenSlotOverrides })`. Pairs that cannot be verified are returned in `unresolved`
     * rather than thrown.
     *
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides.
     */
    forPermit2Allowances: (args: ForPermit2AllowancesArgs) => Promise<PreparedPermit2Overrides>;

    /**
     * Estimates the balances and approvals needed to execute the observed path.
     *
     * Use this when the tokens or spenders are not known ahead of time. Returned amounts are
     * estimated under forged balances/allowances and should be padded before display or transaction
     * assembly; unreliable measurements are reported under `unresolved`.
     *
     * On Permit2-routed paths (the batch touches the `permit2Address` singleton, canonical by
     * default), the estimator also forges and measures the Permit2 internal allowance per (token,
     * spender), reported as `permit2Allowances`; batches that never touch Permit2 are unchanged.
     * Batch-permit (`PermitBatch`) in-batch grants are not detected, so such a batch may over-report.
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

  readonly gas: {
    /**
     * Measures per-call execution gas for a sequential batch, in one `eth_call`, zero access lists.
     *
     * Dependent non-atomic legs (approve-then-swap) can't be `eth_estimateGas`-ed standalone — the
     * second leg reverts without the first leg's state. The ghost runs the batch sequentially in one
     * frame through a probe-free entry point and returns each call's `gasleft()` delta, on top of which
     * this adds intrinsic + calldata gas (EIP-7623-aware).
     *
     * Pass the **same state-override args as `simulate`** (`tokenSlotOverrides`,
     * `nativeBalanceOverrides`): an unfunded account can't measure a swap, so prepare overrides with
     * `tokenOverrides.*` first. Discovery is not run inside this method.
     *
     * `suggestedLimit` is **pre-buffer** — apply your own EIP-150 headroom (2× recommended) before
     * using it as a per-leg limit. On a revert, `byCall` entries from `failingCallIndex` onward are all
     * `0n`. Transaction reverts are reported via `failingCallIndex`, not thrown.
     *
     * @throws InvalidSimulationInputError when `calls` is empty.
     * @throws StateOverrideUnsupportedError when the RPC endpoint cannot execute state overrides or
     * returns undecodable simulator output.
     */
    estimateBatch: (args: EstimateBatchGasArgs) => Promise<BatchGasEstimate>;
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
      // No DEFAULT_SIMULATION_GAS_LIMIT fallback: `undefined` means "caller chose no gas", which
      // makes createAccessList apply its 10M default rather than the simulation budget.
      const accessListGas = args.gas ?? bound.gas;

      return {
        gas,
        ...(accessListGas !== undefined ? { accessListGas } : {}),
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
          prepareBalanceOverrides({ ...args, ...defaults(args), client: bound.client }),
        forAllowances: (args) =>
          prepareAllowanceOverrides({ ...args, ...defaults(args), client: bound.client }),
        forPermit2Allowances: (args) =>
          preparePermit2Overrides({ ...args, ...defaults(args), client: bound.client }),
        estimateRequirements: (args) =>
          estimateAssetRequirements({
            ...args,
            ...revertDefaults(args),
            client: bound.client,
          }),
      },
      gas: {
        estimateBatch: (args) =>
          runEstimateBatchGas({ ...args, ...defaults(args), client: bound.client }),
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
    nftCollections: args.nftQueries ?? [],
    debug: args.debug,
    ...blockOptionsSpread(args),
    gas: args.gas,
    ...(args.errorAbi !== undefined ? { errorAbi: args.errorAbi } : {}),
  });
  const balances = buildBalanceResults(args.balanceQueries, result.probeData, calls.length);
  const nftReceipts = result.probeData.nftReceipts.map(decodeNftReceipt);

  if (result.status === "reverted") {
    return {
      status: "reverted",
      ...balances,
      nftReceipts,
      revertData: result.revertData,
      ...(result.revertReason !== undefined ? { revertReason: result.revertReason } : {}),
      ...(result.revertError !== undefined ? { revertError: result.revertError } : {}),
      ...(result.revertSelector !== undefined ? { revertSelector: result.revertSelector } : {}),
      failingCallIndex: result.failingCallIndex,
    };
  }

  return { status: "success", ...balances, nftReceipts };
}

async function runEstimateBatchGas(
  args: EstimateBatchGasArgs & ClientArgs,
): Promise<BatchGasEstimate> {
  if (args.calls.length === 0) {
    throw new InvalidSimulationInputError("gas.estimateBatch requires at least one call.");
  }

  const calls = args.calls.map((call) => ({
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  })) satisfies SimulatedCall[];

  const result = await runBatchGas({
    client: args.client,
    from: args.from,
    calls,
    tokenSlotOverrides: args.tokenSlotOverrides ?? [],
    extraStateOverrides: (args.nativeBalanceOverrides ?? []).map((override) => ({
      address: override.account,
      balance: override.amount,
    })),
    debug: args.debug,
    ...blockOptionsSpread(args),
    gas: args.gas,
  });

  const { failingCallIndex } = result;
  const byCall = calls.map((call, index) => {
    // Zero-tail: from the failing call onward every field is 0n (matches the contract zero-fill).
    if (failingCallIndex !== null && index >= failingCallIndex) {
      return { executionGas: 0n, intrinsicAndCalldataGas: 0n, suggestedLimit: 0n };
    }
    const executionGas = result.execGasPerCall[index] ?? 0n;
    const intrinsic = intrinsicAndCalldataGas(call.data);
    return {
      executionGas,
      intrinsicAndCalldataGas: intrinsic,
      suggestedLimit: executionGas + intrinsic,
    };
  });

  return {
    byCall,
    totalSuggestedLimit: byCall.reduce((sum, entry) => sum + entry.suggestedLimit, 0n),
    failingCallIndex,
  };
}

/** Decodes a ghost-contract NFT receipt, best-effort: malformed/empty `tokenUriRaw` → `tokenUri` undefined. */
function decodeNftReceipt(raw: RawNftReceipt): NftReceipt {
  let tokenUri: string | undefined;
  try {
    if (raw.tokenUriRaw !== "0x") {
      [tokenUri] = decodeAbiParameters([{ type: "string" }], raw.tokenUriRaw);
    }
  } catch {
    tokenUri = undefined;
  }

  return {
    collection: raw.collection,
    tokenId: raw.tokenId,
    amount: raw.amount,
    standard: raw.erc1155 ? "erc1155" : "erc721",
    ...(tokenUri !== undefined ? { tokenUri } : {}),
  };
}
