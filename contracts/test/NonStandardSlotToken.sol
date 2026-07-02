// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

contract NonStandardSlotToken is IERC20 {
    error InsufficientAllowance();
    error InsufficientBalance();

    string public name;
    string public symbol;
    uint8 public decimals;

    uint256 public totalSupply;
    uint256 internal constant BALANCE_BASE = 0x4242;
    uint256 internal constant ALLOWANCE_BASE = 0x4343;

    constructor() {
        name = "NonStandardSlotToken";
        symbol = "NSST";
        decimals = 18;
    }

    function balanceOf(address owner) public view returns (uint256 value) {
        bytes32 slot = _balanceSlot(owner);
        // forge-lint: disable-next-line(inline-assembly)
        assembly {
            value := sload(slot)
        }
    }

    function allowance(address owner, address spender) public view returns (uint256 value) {
        bytes32 slot = _allowanceSlot(owner, spender);
        // forge-lint: disable-next-line(inline-assembly)
        assembly {
            value := sload(slot)
        }
    }

    function mint(address to, uint256 amount) external {
        _writeBalance(to, balanceOf(to) + amount);
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _writeAllowance(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance(from, msg.sender);
        if (currentAllowance < amount) revert InsufficientAllowance();
        if (currentAllowance != type(uint256).max) {
            _writeAllowance(from, msg.sender, currentAllowance - amount);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 fromBalance = balanceOf(from);
        if (fromBalance < amount) revert InsufficientBalance();
        _writeBalance(from, fromBalance - amount);
        _writeBalance(to, balanceOf(to) + amount);
    }

    function _writeBalance(address owner, uint256 value) internal {
        bytes32 slot = _balanceSlot(owner);
        // forge-lint: disable-next-line(inline-assembly)
        assembly {
            sstore(slot, value)
        }
    }

    function _writeAllowance(address owner, address spender, uint256 value) internal {
        bytes32 slot = _allowanceSlot(owner, spender);
        // forge-lint: disable-next-line(inline-assembly)
        assembly {
            sstore(slot, value)
        }
    }

    function _balanceSlot(address owner) internal pure returns (bytes32) {
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(owner, BALANCE_BASE));
    }

    function _allowanceSlot(address owner, address spender) internal pure returns (bytes32) {
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(spender, keccak256(abi.encode(owner, ALLOWANCE_BASE))));
    }
}
