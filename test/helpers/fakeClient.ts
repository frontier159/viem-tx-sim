import {
  createPublicClient,
  custom,
  encodeFunctionResult,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * A real viem `PublicClient` over a `custom` transport with scripted per-RPC-method responders, so
 * error-path tests exercise viem's genuine action/error wrapping without a chain. Each responder
 * returns the RPC result or throws; unscripted methods throw loudly.
 *
 * The library only reaches the transport via `client.call` (`eth_call`) and
 * `client.request({ method: "eth_createAccessList" })`, so the script surface is those two methods.
 */
export function fakeClient(responders: Record<string, (params: unknown) => unknown>): PublicClient {
  return createPublicClient({
    transport: custom({
      async request({ method, params }) {
        const responder = responders[method];
        if (responder === undefined) {
          throw new Error(`fakeClient: unscripted RPC method ${method}`);
        }
        return responder(params);
      },
    }),
  });
}

// Mirror of the ghost contract's return ABI (src/internal/simulator.ts) so tests can script the
// `eth_call` result the way a real node would encode it.
const simulatorAbi = parseAbi([
  "struct SimulatedCall { address to; uint256 value; bytes data; }",
  "struct AllowanceProbe { address token; address spender; }",
  "struct BalanceProbe { address token; address account; }",
  "struct SimulationResult { bool success; uint256 failingCallIndex; bytes revertData; int256 nativeDelta; address[] observedTokens; address[] deltaTokens; int256[] tokenDeltas; uint256[] maxTokenOutflows; uint256 maxNativeOutflow; uint256[] allowanceCheckpoints; uint256[] balanceCheckpoints; bool[] balanceProbeOk; }",
  "function simulate(SimulatedCall[] calls, address[] candidates, AllowanceProbe[] probes, BalanceProbe[] balanceProbes) returns (SimulationResult)",
]);

type SimulationResultStruct = {
  success: boolean;
  failingCallIndex: bigint;
  revertData: Hex;
  nativeDelta: bigint;
  observedTokens: readonly Hex[];
  deltaTokens: readonly Hex[];
  tokenDeltas: readonly bigint[];
  maxTokenOutflows: readonly bigint[];
  maxNativeOutflow: bigint;
  allowanceCheckpoints: readonly bigint[];
  balanceCheckpoints: readonly bigint[];
  balanceProbeOk: readonly boolean[];
};

/** Encodes a ghost-contract `SimulationResult` the way a node would return it from `eth_call`. */
export function encodeSimulationResult(overrides: Partial<SimulationResultStruct> = {}): Hex {
  const result: SimulationResultStruct = {
    success: true,
    failingCallIndex: 0n,
    revertData: "0x",
    nativeDelta: 0n,
    observedTokens: [],
    deltaTokens: [],
    tokenDeltas: [],
    maxTokenOutflows: [],
    maxNativeOutflow: 0n,
    allowanceCheckpoints: [],
    balanceCheckpoints: [],
    balanceProbeOk: [],
    ...overrides,
  };
  return encodeFunctionResult({ abi: simulatorAbi, functionName: "simulate", result });
}
