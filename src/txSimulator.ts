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

export interface TxSimulator {
  simulate: (args: BoundSimulateArgs) => ReturnType<typeof simulate>;
  discoverBalanceSlots: (args: BoundBalanceSlotsArgs) => ReturnType<typeof discoverBalanceSlots>;
  discoverAllowanceSlots: (
    args: BoundAllowanceSlotsArgs,
  ) => ReturnType<typeof discoverAllowanceSlots>;
  discoverRequirements: (args: BoundRequirementsArgs) => ReturnType<typeof discoverRequirements>;
}

export const TxSimulator = {
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
