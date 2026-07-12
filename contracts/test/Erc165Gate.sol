// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// Mimics a marketplace/router that pre-checks receiver support before a safe transfer.
contract Erc165Gate {
    error ReceiverCheckFailed();

    function requireReceiver(address account) external view {
        IERC165 target = IERC165(account);
        if (!target.supportsInterface(0x01ffc9a7)) revert ReceiverCheckFailed();
        if (!target.supportsInterface(0x150b7a02)) revert ReceiverCheckFailed();
        if (!target.supportsInterface(0x4e2312e0)) revert ReceiverCheckFailed();
        if (target.supportsInterface(0xffffffff)) revert ReceiverCheckFailed();
    }
}
