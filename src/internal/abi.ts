import { parseAbi } from 'viem';

export const txSimulatorAbi = parseAbi([
  'struct SimulatedCall { address to; uint256 value; bytes data; }',
  'struct SimulationResult { bool success; uint256 failingCallIndex; bytes revertData; int256 nativeDelta; address[] observedTokens; address[] deltaTokens; int256[] tokenDeltas; }',
  'function simulate(SimulatedCall[] calls, address[] candidates) returns (SimulationResult)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

export const erc20ProbeAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
