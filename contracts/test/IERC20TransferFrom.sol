// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20TransferFrom {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
