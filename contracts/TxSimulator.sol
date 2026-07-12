// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271Like} from "./interfaces/IERC1271Like.sol";

contract TxSimulator is IERC1271Like {
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID_VALUE = 0xffffffff;
    bytes4 internal constant BALANCE_OF_SELECTOR = 0x70a08231;
    bytes4 internal constant ALLOWANCE_SELECTOR = 0xdd62ed3e;
    /// Permit2 `allowance(address owner, address token, address spender)` — verified via `cast sig`.
    bytes4 internal constant PERMIT2_ALLOWANCE_SELECTOR = 0x927da105;

    /// Gas forwarded to best-effort balance/allowance probes. Bounds hostile or pathological
    /// implementations (e.g. a balanceOf that infinite-loops) to a fixed cost so one bad candidate
    /// cannot OOG the whole simulation. 150k covers proxied tokens with hooks; walletchan ships 100k.
    uint256 internal constant PROBE_GAS_LIMIT = 150_000;

    struct SimulatedCall {
        address to;
        uint256 value;
        bytes data;
    }

    struct AllowanceProbe {
        address token;
        address spender;
    }

    struct BalanceProbe {
        address token;
        address account;
    }

    struct SimulationResult {
        bool success;
        uint256 failingCallIndex;
        bytes revertData;
        address[] observedTokens;
        uint256[] maxTokenOutflows;
        uint256 maxNativeOutflow;
        uint256[] allowanceCheckpoints;
        uint256[] balanceCheckpoints;
        bool[] balanceProbeOk;
        uint256[] permit2Checkpoints;
    }

    struct TokenState {
        uint256[] beforeBalances;
        uint256[] minBalances;
        bool[] isToken;
        address[] observedScratch;
        uint256 observedCount;
    }

    struct ExecutionState {
        bool[] isToken;
        uint256[] minBalances;
        uint256[] allowanceCheckpoints;
        uint256[] balanceCheckpoints;
        bool[] balanceProbeOk;
        uint256[] permit2Checkpoints;
        address permit2;
        uint256 stride;
        uint256 nativeStart;
        uint256 nativeMin;
        // Outputs of `_executeCalls`, written here rather than returned to keep that function's stack
        // within the EVM's 16-slot limit alongside its five calldata array parameters.
        bool success;
        uint256 failingCallIndex;
        bytes revertData;
        uint256 nativeOutflow;
    }

    function simulate(
        SimulatedCall[] calldata calls,
        address[] calldata candidates,
        AllowanceProbe[] calldata probes,
        BalanceProbe[] calldata balanceProbes,
        address permit2,
        AllowanceProbe[] calldata permit2Probes
    ) external returns (SimulationResult memory result) {
        TokenState memory tokenState = _snapshotTokens(candidates);
        // Built in a helper so the checkpoint-array allocations don't pin extra stack slots in this
        // frame; the arrays are shared by reference with `result` below.
        ExecutionState memory executionState = _newExecutionState(
            tokenState, calls.length + 1, probes.length, balanceProbes.length, permit2Probes.length, permit2
        );
        result.allowanceCheckpoints = executionState.allowanceCheckpoints;
        result.balanceCheckpoints = executionState.balanceCheckpoints;
        result.balanceProbeOk = executionState.balanceProbeOk;
        result.permit2Checkpoints = executionState.permit2Checkpoints;

        _executeCalls(calls, candidates, probes, balanceProbes, permit2Probes, executionState);
        result.success = executionState.success;
        result.failingCallIndex = executionState.failingCallIndex;
        result.revertData = executionState.revertData;
        result.maxNativeOutflow = executionState.nativeOutflow;

        result.observedTokens = _trimAddresses(tokenState.observedScratch, tokenState.observedCount);

        result.maxTokenOutflows = new uint256[](candidates.length);
        for (uint256 i = 0; i < candidates.length; ++i) {
            if (tokenState.isToken[i] && tokenState.beforeBalances[i] >= tokenState.minBalances[i]) {
                result.maxTokenOutflows[i] = tokenState.beforeBalances[i] - tokenState.minBalances[i];
            }
        }
    }

    function _newExecutionState(
        TokenState memory tokenState,
        uint256 stride,
        uint256 allowanceProbeCount,
        uint256 balanceProbeCount,
        uint256 permit2ProbeCount,
        address permit2
    ) internal pure returns (ExecutionState memory executionState) {
        executionState.isToken = tokenState.isToken;
        executionState.minBalances = tokenState.minBalances;
        executionState.allowanceCheckpoints = new uint256[](allowanceProbeCount * stride);
        executionState.balanceCheckpoints = new uint256[](balanceProbeCount * stride);
        executionState.balanceProbeOk = new bool[](balanceProbeCount);
        executionState.permit2Checkpoints = new uint256[](permit2ProbeCount * stride);
        executionState.permit2 = permit2;
        executionState.stride = stride;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _recover(hash, signature) == address(this) ? ERC1271_MAGIC_VALUE : ERC1271_INVALID_VALUE;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    /// ERC-165: advertise exactly the receiver interfaces this ghost implements, so senders that
    /// pre-check supportsInterface before safeTransferFrom don't false-revert during simulation
    /// (a real EOA has no code, so on-chain these checks are skipped entirely).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x150b7a02 || interfaceId == 0x4e2312e0;
    }

    receive() external payable {}

    function _snapshotTokens(address[] calldata candidates) internal view returns (TokenState memory tokenState) {
        tokenState.beforeBalances = new uint256[](candidates.length);
        tokenState.minBalances = new uint256[](candidates.length);
        tokenState.isToken = new bool[](candidates.length);
        tokenState.observedScratch = new address[](candidates.length);

        for (uint256 i = 0; i < candidates.length; ++i) {
            (bool ok, uint256 balance) = _tryBalanceOf(candidates[i], address(this));
            if (ok) {
                tokenState.isToken[i] = true;
                tokenState.beforeBalances[i] = balance;
                tokenState.minBalances[i] = balance;
                tokenState.observedScratch[tokenState.observedCount++] = candidates[i];
            }
        }
    }

    function _executeCalls(
        SimulatedCall[] calldata calls,
        address[] calldata candidates,
        AllowanceProbe[] calldata probes,
        BalanceProbe[] calldata balanceProbes,
        AllowanceProbe[] calldata permit2Probes,
        ExecutionState memory executionState
    ) internal {
        executionState.success = true;
        executionState.failingCallIndex = type(uint256).max;
        executionState.nativeStart = address(this).balance;
        executionState.nativeMin = executionState.nativeStart;
        if (probes.length > 0) {
            _recordAllowanceCheckpoints(probes, executionState.stride, 0, executionState.allowanceCheckpoints);
        }
        if (balanceProbes.length > 0) {
            _recordBalanceCheckpoints(
                balanceProbes,
                executionState.stride,
                0,
                executionState.balanceCheckpoints,
                executionState.balanceProbeOk
            );
        }
        if (permit2Probes.length > 0) {
            _recordPermit2Checkpoints(
                executionState.permit2, permit2Probes, executionState.stride, 0, executionState.permit2Checkpoints
            );
        }

        for (uint256 i = 0; i < calls.length; ++i) {
            (executionState.success, executionState.revertData) = _executeCall(calls[i]);
            if (!executionState.success) {
                executionState.failingCallIndex = i;
                if (probes.length > 0) {
                    _fillRemainingCheckpoints(
                        probes.length, executionState.stride, i, executionState.allowanceCheckpoints
                    );
                }
                if (balanceProbes.length > 0) {
                    _fillRemainingCheckpoints(
                        balanceProbes.length, executionState.stride, i, executionState.balanceCheckpoints
                    );
                }
                if (permit2Probes.length > 0) {
                    _fillRemainingCheckpoints(
                        permit2Probes.length, executionState.stride, i, executionState.permit2Checkpoints
                    );
                }
                break;
            }

            uint256 nativeAfter = address(this).balance;
            if (nativeAfter < executionState.nativeMin) executionState.nativeMin = nativeAfter;
            _updateMinBalances(candidates, executionState.isToken, executionState.minBalances);
            if (probes.length > 0) {
                _recordAllowanceCheckpoints(probes, executionState.stride, i + 1, executionState.allowanceCheckpoints);
            }
            if (balanceProbes.length > 0) {
                _recordBalanceCheckpoints(
                    balanceProbes,
                    executionState.stride,
                    i + 1,
                    executionState.balanceCheckpoints,
                    executionState.balanceProbeOk
                );
            }
            if (permit2Probes.length > 0) {
                _recordPermit2Checkpoints(
                    executionState.permit2, permit2Probes, executionState.stride, i + 1, executionState.permit2Checkpoints
                );
            }
        }

        executionState.nativeOutflow = executionState.nativeStart >= executionState.nativeMin
            ? executionState.nativeStart - executionState.nativeMin
            : 0;
    }

    function _executeCall(SimulatedCall calldata call_) internal returns (bool ok, bytes memory revertData) {
        // forge-lint: disable-next-line(low-level-calls, arbitrary-send-eth, calls-loop)
        (ok, revertData) = call_.to.call{value: call_.value}(call_.data);
        if (ok) revertData = "";
    }

    function _updateMinBalances(address[] calldata candidates, bool[] memory isToken, uint256[] memory minBalances)
        internal
        view
    {
        for (uint256 i = 0; i < candidates.length; ++i) {
            if (!isToken[i]) continue;

            (bool ok, uint256 afterBalance) = _tryBalanceOf(candidates[i], address(this));
            if (ok && afterBalance < minBalances[i]) minBalances[i] = afterBalance;
        }
    }

    function _recordAllowanceCheckpoints(
        AllowanceProbe[] calldata probes,
        uint256 stride,
        uint256 offset,
        uint256[] memory checkpoints
    ) internal view {
        for (uint256 i = 0; i < probes.length; ++i) {
            (bool ok, uint256 allowance) = _tryAllowance(probes[i].token, address(this), probes[i].spender);
            checkpoints[i * stride + offset] = ok ? allowance : 0;
        }
    }

    function _recordPermit2Checkpoints(
        address permit2,
        AllowanceProbe[] calldata probes,
        uint256 stride,
        uint256 offset,
        uint256[] memory checkpoints
    ) internal view {
        for (uint256 i = 0; i < probes.length; ++i) {
            (bool ok, uint256 amount) =
                _tryPermit2Allowance(permit2, probes[i].token, address(this), probes[i].spender);
            checkpoints[i * stride + offset] = ok ? amount : 0;
        }
    }

    function _recordBalanceCheckpoints(
        BalanceProbe[] calldata probes,
        uint256 stride,
        uint256 offset,
        uint256[] memory checkpoints,
        bool[] memory ok
    ) internal view {
        for (uint256 i = 0; i < probes.length; ++i) {
            (bool readOk, uint256 balance) = _readBalanceProbe(probes[i]);
            checkpoints[i * stride + offset] = readOk ? balance : 0;
            ok[i] = offset == 0 ? readOk : ok[i] && readOk;
        }
    }

    function _fillRemainingCheckpoints(
        uint256 probeCount,
        uint256 stride,
        uint256 lastOffset,
        uint256[] memory checkpoints
    ) internal pure {
        for (uint256 i = 0; i < probeCount; ++i) {
            uint256 last = checkpoints[i * stride + lastOffset];
            for (uint256 offset = lastOffset + 1; offset < stride; ++offset) {
                checkpoints[i * stride + offset] = last;
            }
        }
    }

    function _tryBalanceOf(address token, address owner) internal view returns (bool ok, uint256 balance) {
        // forge-lint: disable-next-line(low-level-calls, calls-loop)
        (bool success, bytes memory data) =
            token.staticcall{gas: PROBE_GAS_LIMIT}(abi.encodeWithSelector(BALANCE_OF_SELECTOR, owner));
        if (!success || data.length < 32) return (ok, balance);
        ok = success;
        balance = abi.decode(data, (uint256));
    }

    function _readBalanceProbe(BalanceProbe calldata probe) internal view returns (bool ok, uint256 balance) {
        if (probe.token == address(0)) {
            ok = true;
            balance = probe.account.balance;
            return (ok, balance);
        }
        return _tryBalanceOf(probe.token, probe.account);
    }

    function _tryAllowance(address token, address owner, address spender)
        internal
        view
        returns (bool ok, uint256 allowance)
    {
        // forge-lint: disable-next-line(low-level-calls, calls-loop)
        (bool success, bytes memory data) =
            token.staticcall{gas: PROBE_GAS_LIMIT}(abi.encodeWithSelector(ALLOWANCE_SELECTOR, owner, spender));
        if (!success || data.length < 32) return (ok, allowance);
        ok = success;
        allowance = abi.decode(data, (uint256));
    }

    /// Best-effort Permit2 internal-allowance read. The getter returns (uint160 amount, uint48
    /// expiration, uint48 nonce) as three words; only the amount is relevant to measurement.
    function _tryPermit2Allowance(address permit2, address token, address owner, address spender)
        internal
        view
        returns (bool ok, uint256 amount)
    {
        bytes memory callData = abi.encodeWithSelector(PERMIT2_ALLOWANCE_SELECTOR, owner, token, spender);
        // forge-lint: disable-next-line(low-level-calls, calls-loop)
        (bool success, bytes memory data) = permit2.staticcall{gas: PROBE_GAS_LIMIT}(callData);
        if (!success || data.length < 96) return (ok, amount);
        ok = success;
        amount = abi.decode(data, (uint160));
    }

    function _trimAddresses(address[] memory input, uint256 length) internal pure returns (address[] memory output) {
        output = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            output[i] = input[i];
        }
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            // forge-lint: disable-next-line(inline-assembly)
            assembly {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 0x20))
                v := byte(0, calldataload(add(signature.offset, 0x40)))
            }
            if (v < 27) v += 27;
            if (v != 27 && v != 28) return address(0);
            return ecrecover(hash, v, r, s);
        }

        if (signature.length == 64) {
            bytes32 r;
            bytes32 vs;
            // forge-lint: disable-next-line(inline-assembly)
            assembly {
                r := calldataload(signature.offset)
                vs := calldataload(add(signature.offset, 0x20))
            }
            bytes32 s = bytes32(uint256(vs) & 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 v = uint8((uint256(vs) >> 255) + 27);
            return ecrecover(hash, v, r, s);
        }

        return address(0);
    }
}
