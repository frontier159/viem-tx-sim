// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal ERC-1155 that fires the receiver hooks, for exercising the ghost's ERC-1155 receipt
/// aggregation. `mint` and `safeTransferFrom` invoke `onERC1155Received`; `safeBatchTransferFrom`
/// invokes `onERC1155BatchReceived`. Note `balanceOf` here is `(id, account)`, so the ghost's
/// `balanceOf(address)` NFT snapshot/walk staticcall simply fails and the hooks do all the work.
contract MockERC1155 {
    error UnsafeRecipient();

    bytes4 internal constant ERC1155_RECEIVED = 0xf23a6e61;
    bytes4 internal constant ERC1155_BATCH_RECEIVED = 0xbc197c81;

    mapping(uint256 => mapping(address => uint256)) public balanceOf;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[id][to] += amount;
        _acceptanceCheck(address(0), to, id, amount);
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata) external {
        balanceOf[id][from] -= amount;
        balanceOf[id][to] += amount;
        _acceptanceCheck(from, to, id, amount);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata
    ) external {
        // forge-lint: disable-start(costly-loop)
        for (uint256 i = 0; i < ids.length; ++i) {
            balanceOf[ids[i]][from] -= amounts[i];
            balanceOf[ids[i]][to] += amounts[i];
        }
        // forge-lint: disable-end(costly-loop)
        _batchAcceptanceCheck(from, to, ids, amounts);
    }

    function _acceptanceCheck(address from, address to, uint256 id, uint256 amount) internal {
        if (to.code.length == 0) return;
        // forge-lint: disable-start(low-level-calls)
        (bool ok, bytes memory data) =
            to.call(abi.encodeWithSelector(ERC1155_RECEIVED, msg.sender, from, id, amount, ""));
        // forge-lint: disable-end(low-level-calls)
        if (!ok || data.length < 32 || abi.decode(data, (bytes4)) != ERC1155_RECEIVED) revert UnsafeRecipient();
    }

    function _batchAcceptanceCheck(address from, address to, uint256[] calldata ids, uint256[] calldata amounts)
        internal
    {
        if (to.code.length == 0) return;
        // forge-lint: disable-start(low-level-calls)
        (bool ok, bytes memory data) =
            to.call(abi.encodeWithSelector(ERC1155_BATCH_RECEIVED, msg.sender, from, ids, amounts, ""));
        // forge-lint: disable-end(low-level-calls)
        if (!ok || data.length < 32 || abi.decode(data, (bytes4)) != ERC1155_BATCH_RECEIVED) revert UnsafeRecipient();
    }
}
