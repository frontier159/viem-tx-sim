import { describe, expect, it } from "vitest";

import { txSimulatorAbi } from "../src/internal/simulator.js";
import { artifact } from "./helpers/artifacts.js";

/** Strips forge-only `internalType` annotations so shapes compare against parseAbi output. */
function stripInternalType(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInternalType);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "internalType")
        .map(([key, entry]) => [key, stripInternalType(entry)]),
    );
  }
  return value;
}

/**
 * Normalizes a function ABI entry for comparison: strips forge-only
 * `internalType`, then drops the top-level output-parameter `name`. Solidity's
 * named return variable (`returns (SimulationResult result)`) makes forge emit
 * `name: "result"`; viem's `parseAbi` omits it for the unnamed `returns
 * (SimulationResult)`. An output-parameter label is not part of the ABI
 * signature, so this normalization loses nothing the guard cares about — every
 * input name and every struct-component name stays intact and compared, so a
 * renamed/reordered/retyped field still fails.
 */
function normalizeFn(entry: unknown): unknown {
  const stripped = stripInternalType(entry) as Record<string, unknown>;
  const outputs = stripped.outputs;
  if (Array.isArray(outputs)) {
    stripped.outputs = outputs.map((output) => {
      if (typeof output === "object" && output !== null) {
        const { name: _name, ...rest } = output as Record<string, unknown>;
        return rest;
      }
      return output;
    });
  }
  return stripped;
}

describe("txSimulatorAbi drift guard", () => {
  it("matches the compiled TxSimulator artifact for every declared function", () => {
    const compiled = artifact("TxSimulator.sol", "TxSimulator").abi;
    const declaredFunctions = txSimulatorAbi.filter((entry) => entry.type === "function");
    expect(declaredFunctions.length).toBeGreaterThan(0);

    for (const declared of declaredFunctions) {
      const counterpart = compiled.find(
        (entry) => entry.type === "function" && entry.name === declared.name,
      );
      expect(counterpart, `function ${declared.name} missing from artifact`).toBeDefined();
      expect(normalizeFn(counterpart)).toEqual(normalizeFn(JSON.parse(JSON.stringify(declared))));
    }
  });
});
