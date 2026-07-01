// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20ForSpender {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract Spender {
    function pull(address token, uint256 amount) external {
        require(IERC20ForSpender(token).transferFrom(msg.sender, address(this), amount), "pull failed");
    }
}
