// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

contract RefundingSpender {
    error PullFailed();
    error RefundFailed();

    function pull(address token, uint256 amount) external {
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert PullFailed();
    }

    function refund(address token, uint256 amount) external {
        if (!IERC20(token).transfer(msg.sender, amount)) revert RefundFailed();
    }
}
