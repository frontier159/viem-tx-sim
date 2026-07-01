import type { SimulationDebug, SimulationDebugEvent } from "../types.js";

export function emitDebug(debug: SimulationDebug | undefined, event: SimulationDebugEvent): void {
  if (typeof debug === "function") {
    debug(event);
    return;
  }

  if (debug === true || envDebugEnabled()) {
    console.debug(formatDebugEvent(event));
  }
}

export async function withRpcDebug<T>(
  debug: SimulationDebug | undefined,
  event: Omit<SimulationDebugEvent, "phase">,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  emitDebug(debug, { ...event, phase: "start" });

  try {
    const result = await run();
    emitDebug(debug, { ...event, phase: "success", durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    emitDebug(debug, {
      ...event,
      phase: "error",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function envDebugEnabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.VIEM_TX_SIM_DEBUG_RPC === "1" || env?.DEBUG_RPC === "1";
}

function formatDebugEvent(event: SimulationDebugEvent): string {
  const parts = [
    `[viem-tx-sim] ${event.phase} ${event.method}`,
    `step=${event.step}`,
    ...(event.durationMs === undefined ? [] : [`durationMs=${event.durationMs}`]),
    ...Object.entries(event.details ?? {}).map(([key, value]) => `${key}=${formatValue(value)}`),
    ...(event.error ? [`error=${event.error}`] : []),
  ];
  return parts.join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatValue).join(",")}]`;
  return String(value);
}
