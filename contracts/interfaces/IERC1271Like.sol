// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC1271Like {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}
