// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

contract StoredTokenSpender {
    error PullFailed();
    error ZeroToken();

    address public immutable TOKEN;

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroToken();
        TOKEN = token_;
    }

    function pull(uint256 amount) external {
        if (!IERC20(TOKEN).transferFrom(msg.sender, address(this), amount)) revert PullFailed();
    }
}
