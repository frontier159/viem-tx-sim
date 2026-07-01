// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract RevertingTarget {
    error AlwaysReverts();

    fallback() external payable {
        revert AlwaysReverts();
    }

    receive() external payable {
        revert AlwaysReverts();
    }
}
