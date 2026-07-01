// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TxSimulator {
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID_VALUE = 0xffffffff;
    bytes4 internal constant BALANCE_OF_SELECTOR = 0x70a08231;

    struct SimulatedCall {
        address to;
        uint256 value;
        bytes data;
    }

    struct SimulationResult {
        bool success;
        uint256 failingCallIndex;
        bytes revertData;
        int256 nativeDelta;
        address[] observedTokens;
        address[] deltaTokens;
        int256[] tokenDeltas;
    }

    function simulate(
        SimulatedCall[] calldata calls,
        address[] calldata candidates
    ) external returns (SimulationResult memory result) {
        uint256 nativeBefore = address(this).balance;
        uint256[] memory beforeBalances = new uint256[](candidates.length);
        bool[] memory isToken = new bool[](candidates.length);
        address[] memory observedScratch = new address[](candidates.length);
        uint256 observedCount;

        for (uint256 i; i < candidates.length; ++i) {
            (bool ok, uint256 balance) = _tryBalanceOf(candidates[i], address(this));
            if (ok) {
                isToken[i] = true;
                beforeBalances[i] = balance;
                observedScratch[observedCount++] = candidates[i];
            }
        }

        result.success = true;
        result.failingCallIndex = type(uint256).max;

        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory revertData) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                result.success = false;
                result.failingCallIndex = i;
                result.revertData = revertData;
                break;
            }
        }

        result.nativeDelta = _signedDelta(address(this).balance, nativeBefore);
        result.observedTokens = _trimAddresses(observedScratch, observedCount);

        address[] memory deltaTokensScratch = new address[](candidates.length);
        int256[] memory tokenDeltasScratch = new int256[](candidates.length);
        uint256 deltaCount;

        for (uint256 i; i < candidates.length; ++i) {
            if (!isToken[i]) continue;

            (bool ok, uint256 afterBalance) = _tryBalanceOf(candidates[i], address(this));
            if (!ok) continue;

            int256 delta = _signedDelta(afterBalance, beforeBalances[i]);
            if (delta != 0) {
                deltaTokensScratch[deltaCount] = candidates[i];
                tokenDeltasScratch[deltaCount] = delta;
                ++deltaCount;
            }
        }

        result.deltaTokens = _trimAddresses(deltaTokensScratch, deltaCount);
        result.tokenDeltas = _trimInts(tokenDeltasScratch, deltaCount);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _recover(hash, signature) == address(this) ? ERC1271_MAGIC_VALUE : ERC1271_INVALID_VALUE;
    }

    receive() external payable {}

    function _tryBalanceOf(address token, address owner) internal view returns (bool ok, uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(BALANCE_OF_SELECTOR, owner));
        if (!success || data.length < 32) return (false, 0);
        return (true, abi.decode(data, (uint256)));
    }

    function _signedDelta(uint256 afterBalance, uint256 beforeBalance) internal pure returns (int256) {
        if (afterBalance >= beforeBalance) {
            uint256 positiveDiff = afterBalance - beforeBalance;
            if (positiveDiff > uint256(type(int256).max)) return type(int256).max;
            // forge-lint: disable-next-line(unsafe-typecast)
            return int256(positiveDiff);
        }

        uint256 negativeDiff = beforeBalance - afterBalance;
        if (negativeDiff > uint256(type(int256).max)) return type(int256).min;
        // forge-lint: disable-next-line(unsafe-typecast)
        return -int256(negativeDiff);
    }

    function _trimAddresses(address[] memory input, uint256 length) internal pure returns (address[] memory output) {
        output = new address[](length);
        for (uint256 i; i < length; ++i) output[i] = input[i];
    }

    function _trimInts(int256[] memory input, uint256 length) internal pure returns (int256[] memory output) {
        output = new int256[](length);
        for (uint256 i; i < length; ++i) output[i] = input[i];
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
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
            assembly {
                r := calldataload(signature.offset)
                vs := calldataload(add(signature.offset, 0x20))
            }
            bytes32 s = bytes32(uint256(vs) & 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
            uint8 v = uint8((uint256(vs) >> 255) + 27);
            return ecrecover(hash, v, r, s);
        }

        return address(0);
    }
}
