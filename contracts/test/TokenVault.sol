// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

contract TokenVault {
    error DepositFailed();
    error ZeroUnderlying();

    address public immutable UNDERLYING;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address underlying_) {
        if (underlying_ == address(0)) revert ZeroUnderlying();
        UNDERLYING = underlying_;
    }

    function deposit(uint256 assets) external {
        if (!IERC20(UNDERLYING).transferFrom(msg.sender, address(this), assets)) revert DepositFailed();
        balanceOf[msg.sender] += assets;
        totalSupply += assets;
    }
}
