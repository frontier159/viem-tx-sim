// The complete debug-step vocabulary. Every emit site in src/ sources its step
// name here, so a typo is a type error. Not exported from the public barrel;
// the public debug-event type keeps `step: string`. Tests pin these names as
// literals from outside the seam (see docs/adr/0001) — do not import this there.
export const DEBUG_STEPS = {
  txSimulatorSimulate: "txSimulator.simulate",
  candidateDiscoveryAccessList: "candidateDiscovery.accessList",
  createAccessList: "createAccessList",
  erc20Allowance: "erc20.allowance",
  balanceQueriesTokenFilter: "balanceQueries.tokenFilter",
  balanceSlotAccessList: "balanceSlot.accessList",
  balanceSlotVerify: "balanceSlot.verify",
  allowanceSlotAccessList: "allowanceSlot.accessList",
  allowanceSlotVerify: "allowanceSlot.verify",
  allowanceSlotComputedVerify: "allowanceSlot.computedVerify",
} as const;

export type DebugStep = (typeof DEBUG_STEPS)[keyof typeof DEBUG_STEPS];
