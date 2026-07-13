// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// Storage-layout-faithful slice of canonical Permit2's AllowanceTransfer:
/// slot 0 mirrors SignatureTransfer.nonceBitmap, so `allowance` lands at slot 1 like the real thing.
// forge-lint: disable-next-line(missing-inheritance)
contract MockPermit2 {
    error AllowanceExpired();
    error InsufficientAllowance();

    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(uint256 => uint256)) public nonceBitmap; // slot 0 filler
    mapping(address => mapping(address => mapping(address => PackedAllowance))) public allowance; // slot 1

    function setNonce(address owner, address token, address spender, uint48 nonce) external {
        allowance[owner][token][spender].nonce = nonce;
    }

    /// Canonical AllowanceTransfer.approve signature: sets amount + expiration for the caller as owner,
    /// leaving the nonce untouched. Lets a batch grant the internal allowance in-band.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        PackedAllowance storage allowed = allowance[msg.sender][token][spender];
        allowed.amount = amount;
        allowed.expiration = expiration;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > allowed.expiration) revert AllowanceExpired();
        if (allowed.amount != type(uint160).max) {
            if (allowed.amount < amount) revert InsufficientAllowance();
            allowed.amount -= amount;
        }
        // Arbitrary-from pull is canonical Permit2 semantics — the fixture exists to reproduce it.
        // forge-lint: disable-next-line(custom-errors, arbitrary-send-erc20)
        require(IERC20(token).transferFrom(from, to, amount), "pull failed");
    }
}
