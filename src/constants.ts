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
 * Default forged Permit2 internal-allowance amount written into the packed allowance slot.
 *
 * Distinct from {@link OVERRIDE_TOKEN_AMOUNT} because Permit2 packs the amount into a `uint160`
 * field, and `10^50` exceeds `2^160 - 1`. This value must satisfy two constraints: it must fit
 * `uint160` (`10^45 < 2^160 - 1`), and it must stay below `type(uint160).max` so Permit2's amount
 * decrement still fires (Permit2, like ERC-20, skips the decrement at exactly max), keeping forged
 * pulls observable.
 */
export const OVERRIDE_PERMIT2_AMOUNT = 10n ** 45n;

/**
 * Maximum gas attached to `eth_createAccessList` requests.
 *
 * Providers cap this method far below their `eth_call` cap (Alchemy mainnet rejects the default
 * simulation budget while accepting ~10M), so the simulation gas budget is clamped to this ceiling
 * for access-list requests only.
 */
export const ACCESS_LIST_GAS_LIMIT = 10_000_000n;
