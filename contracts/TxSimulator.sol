// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271Like} from "./interfaces/IERC1271Like.sol";

contract TxSimulator is IERC1271Like {
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID_VALUE = 0xffffffff;
    bytes4 internal constant BALANCE_OF_SELECTOR = 0x70a08231;
    bytes4 internal constant ALLOWANCE_SELECTOR = 0xdd62ed3e;
    uint256 internal constant MAX_INT256 = 2 ** 255 - 1;

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
        int256 nativeDelta;
        address[] observedTokens;
        address[] deltaTokens;
        int256[] tokenDeltas;
        uint256[] maxTokenOutflows;
        uint256 maxNativeOutflow;
        uint256[] allowanceCheckpoints;
        uint256[] balanceCheckpoints;
        bool[] balanceProbeOk;
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
        uint256 stride;
    }

    function simulate(
        SimulatedCall[] calldata calls,
        address[] calldata candidates,
        AllowanceProbe[] calldata probes,
        BalanceProbe[] calldata balanceProbes
    ) external returns (SimulationResult memory result) {
        uint256 nativeBefore = address(this).balance;
        TokenState memory tokenState = _snapshotTokens(candidates);
        uint256 stride = calls.length + 1;
        result.balanceCheckpoints = new uint256[](balanceProbes.length * stride);
        result.balanceProbeOk = new bool[](balanceProbes.length);

        result.allowanceCheckpoints = new uint256[](probes.length * stride);
        ExecutionState memory executionState = ExecutionState({
            isToken: tokenState.isToken,
            minBalances: tokenState.minBalances,
            allowanceCheckpoints: result.allowanceCheckpoints,
            balanceCheckpoints: result.balanceCheckpoints,
            balanceProbeOk: result.balanceProbeOk,
            stride: stride
        });
        uint256 nativeMin;
        (result.success, result.failingCallIndex, result.revertData, nativeMin) =
            _executeCalls(calls, candidates, probes, balanceProbes, executionState);

        result.nativeDelta = _signedDelta(address(this).balance, nativeBefore);
        result.observedTokens = _trimAddresses(tokenState.observedScratch, tokenState.observedCount);
        result.maxNativeOutflow = nativeBefore >= nativeMin ? nativeBefore - nativeMin : 0;
        _writeTokenResults(candidates, tokenState, result);
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

    function _writeTokenResults(
        address[] calldata candidates,
        TokenState memory tokenState,
        SimulationResult memory result
    ) internal view {
        result.maxTokenOutflows = new uint256[](candidates.length);
        address[] memory deltaTokensScratch = new address[](candidates.length);
        int256[] memory tokenDeltasScratch = new int256[](candidates.length);
        uint256 deltaCount = 0;

        for (uint256 i = 0; i < candidates.length; ++i) {
            if (!tokenState.isToken[i]) continue;

            if (tokenState.beforeBalances[i] >= tokenState.minBalances[i]) {
                result.maxTokenOutflows[i] = tokenState.beforeBalances[i] - tokenState.minBalances[i];
            }

            (bool ok, uint256 afterBalance) = _tryBalanceOf(candidates[i], address(this));
            if (!ok) continue;

            int256 delta = _signedDelta(afterBalance, tokenState.beforeBalances[i]);
            if (delta != 0) {
                deltaTokensScratch[deltaCount] = candidates[i];
                tokenDeltasScratch[deltaCount] = delta;
                ++deltaCount;
            }
        }

        result.deltaTokens = _trimAddresses(deltaTokensScratch, deltaCount);
        result.tokenDeltas = _trimInts(tokenDeltasScratch, deltaCount);
    }

    function _executeCalls(
        SimulatedCall[] calldata calls,
        address[] calldata candidates,
        AllowanceProbe[] calldata probes,
        BalanceProbe[] calldata balanceProbes,
        ExecutionState memory executionState
    ) internal returns (bool success, uint256 failingCallIndex, bytes memory revertData, uint256 nativeMin) {
        success = true;
        failingCallIndex = type(uint256).max;
        nativeMin = address(this).balance;
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

        for (uint256 i = 0; i < calls.length; ++i) {
            (success, revertData) = _executeCall(calls[i]);
            if (!success) {
                failingCallIndex = i;
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
                break;
            }

            uint256 nativeAfter = address(this).balance;
            if (nativeAfter < nativeMin) nativeMin = nativeAfter;
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
        }
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
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(BALANCE_OF_SELECTOR, owner));
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
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(ALLOWANCE_SELECTOR, owner, spender));
        if (!success || data.length < 32) return (ok, allowance);
        ok = success;
        allowance = abi.decode(data, (uint256));
    }

    function _signedDelta(uint256 afterBalance, uint256 beforeBalance) internal pure returns (int256) {
        if (afterBalance >= beforeBalance) {
            uint256 positiveDiff = afterBalance - beforeBalance;
            if (positiveDiff > MAX_INT256) return type(int256).max;
            // forge-lint: disable-next-line(unsafe-typecast)
            return int256(positiveDiff);
        }

        uint256 negativeDiff = beforeBalance - afterBalance;
        if (negativeDiff > MAX_INT256) return type(int256).min;
        // forge-lint: disable-next-line(unsafe-typecast)
        return -int256(negativeDiff);
    }

    function _trimAddresses(address[] memory input, uint256 length) internal pure returns (address[] memory output) {
        output = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            output[i] = input[i];
        }
    }

    function _trimInts(int256[] memory input, uint256 length) internal pure returns (int256[] memory output) {
        output = new int256[](length);
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
