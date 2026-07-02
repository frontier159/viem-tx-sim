// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockERC721 {
    error UnsafeRecipient();

    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    function safeMint(address to, uint256 id) external {
        ownerOf[id] = to;
        balanceOf[to] += 1;

        if (to.code.length > 0) {
            // forge-lint: disable-start(low-level-calls)
            (bool ok, bytes memory data) =
                to.call(abi.encodeWithSelector(ERC721_RECEIVED, msg.sender, address(0), id, ""));
            // forge-lint: disable-end(low-level-calls)
            if (!ok || data.length < 32 || abi.decode(data, (bytes4)) != ERC721_RECEIVED) {
                revert UnsafeRecipient();
            }
        }
    }
}
