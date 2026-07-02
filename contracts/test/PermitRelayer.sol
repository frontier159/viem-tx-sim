// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPermitToken} from "./IPermitToken.sol";

contract PermitRelayer {
    error ZeroAddress();

    function relay(address token, address owner, address spender, uint256 value) external {
        if (token == address(0) || owner == address(0) || spender == address(0)) revert ZeroAddress();
        IPermitToken(token).permit(owner, spender, value, 0, 0, bytes32(0), bytes32(0));
    }
}
