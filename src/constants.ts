/**
 * Default gas budget for simulator `eth_call` executions.
 *
 * The injected simulator changes gas accounting, so this is intentionally a generous execution
 * budget rather than a gas estimate for the real transaction.
 */
export const DEFAULT_SIMULATION_GAS_LIMIT = 16_000_000n;

/**
 * Default forged token balance or allowance written by slot overrides.
 *
 * This is deliberately below `uint256.max`: standard ERC-20 implementations skip allowance
 * decrements at exactly max allowance, which would hide required approvals during measurement.
 */
export const OVERRIDE_TOKEN_AMOUNT = 10n ** 50n;

/**
 * Maximum gas attached to `eth_createAccessList` requests.
 *
 * Providers cap this method far below their `eth_call` cap (Alchemy mainnet rejects the default
 * simulation budget while accepting ~10M), so the simulation gas budget is clamped to this ceiling
 * for access-list requests only.
 */
export const ACCESS_LIST_GAS_LIMIT = 10_000_000n;
