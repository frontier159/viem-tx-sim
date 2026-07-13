// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// forge-lint: disable-next-line(multi-contract-file)
interface IMockPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// Router-shaped fixture: pulls the user's tokens through Permit2's internal allowance,
/// so the estimator must discover and measure the (token, router) Permit2 requirement.
// forge-lint: disable-next-line(multi-contract-file)
contract Permit2Router {
    function pull(address permit2, address token, address from, uint160 amount) external {
        IMockPermit2(permit2).transferFrom(from, address(this), amount, token);
    }
}
