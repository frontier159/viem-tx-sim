import {
  createPublicClient,
  custom,
  encodeFunctionResult,
  type Hex,
  type PublicClient,
} from "viem";

import { txSimulatorAbi } from "../../src/internal/simulator.js";

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

type SimulationResultStruct = {
  success: boolean;
  failingCallIndex: bigint;
  revertData: Hex;
  observedTokens: readonly Hex[];
  maxTokenOutflows: readonly bigint[];
  maxNativeOutflow: bigint;
  allowanceCheckpoints: readonly bigint[];
  balanceCheckpoints: readonly bigint[];
  balanceProbeOk: readonly boolean[];
  permit2Checkpoints: readonly bigint[];
};

/** Encodes a ghost-contract `SimulationResult` the way a node would return it from `eth_call`. */
export function encodeSimulationResult(overrides: Partial<SimulationResultStruct> = {}): Hex {
  const result: SimulationResultStruct = {
    success: true,
    failingCallIndex: 0n,
    revertData: "0x",
    observedTokens: [],
    maxTokenOutflows: [],
    maxNativeOutflow: 0n,
    allowanceCheckpoints: [],
    balanceCheckpoints: [],
    balanceProbeOk: [],
    permit2Checkpoints: [],
    ...overrides,
  };
  return encodeFunctionResult({ abi: txSimulatorAbi, functionName: "simulate", result });
}
