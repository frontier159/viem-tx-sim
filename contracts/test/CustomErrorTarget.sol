// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

error Unauthorized();
error InsufficientBalance(uint256 have, uint256 want);

contract CustomErrorTarget {
    function failPlain() external pure {
        revert Unauthorized();
    }

    function failWithArgs(uint256 have, uint256 want) external pure {
        revert InsufficientBalance(have, want);
    }

    function failString() external pure {
        // forge-lint: disable-next-line(custom-errors)
        revert("string revert");
    }
}
