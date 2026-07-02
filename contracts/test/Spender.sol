// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20TransferFrom} from "./IERC20TransferFrom.sol";

contract Spender {
    error PullFailed();

    function pull(address token, uint256 amount) external {
        if (!IERC20TransferFrom(token).transferFrom(msg.sender, address(this), amount)) revert PullFailed();
    }
}
