// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestToken} from "./TestToken.sol";
import {IPermitToken} from "./IPermitToken.sol";

contract PermitToken is TestToken, IPermitToken {
    error ZeroAddress();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) TestToken(name_, symbol_, decimals_) {}

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (owner == address(0) || spender == address(0)) revert ZeroAddress();
        deadline;
        v;
        r;
        s;
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
