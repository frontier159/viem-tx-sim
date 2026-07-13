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
 * `10^45` is chosen to serve every forged-state role from one constant:
 * - Deliberately below `uint256.max` so standard ERC-20 allowance decrements stay observable
 *   (implementations skip the decrement at exactly max allowance, which would hide required
 *   approvals during measurement).
 * - Below `type(uint160).max` (~1.46×10^48) so the same constant forges Permit2's packed
 *   `uint160` amount field without overflowing it (Permit2 likewise skips its decrement at max,
 *   so staying non-max keeps forged pulls observable).
 * - Far above any real token's total base units (largest ~10^33) so forged balances always
 *   cover the measured outflows.
 * - Ample headroom under ray-style `10^27` fixed-point math (`10^45 × 10^27 = 10^72 « 2^256`),
 *   where the previous `10^50` sat within ~14% of overflow.
 */
export const OVERRIDE_TOKEN_AMOUNT = 10n ** 45n;

/**
 * Default gas attached to `eth_createAccessList` requests when the caller supplies none.
 *
 * Providers cap this method far below their `eth_call` cap (Alchemy mainnet rejects the default
 * simulation budget while accepting ~10M), so access-list requests default to this provider-safe,
 * walletchan-proven ceiling instead of the simulation budget. Explicitly supplied gas is sent
 * verbatim, never clamped.
 */
export const ACCESS_LIST_GAS_LIMIT = 10_000_000n;
