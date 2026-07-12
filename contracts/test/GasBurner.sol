// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Burns all forwarded gas on any call. Used to prove one hostile candidate/query
/// cannot OOG the ghost contract's probe loop.
contract GasBurner {
    fallback() external payable {
        while (true) {}
    }
}
