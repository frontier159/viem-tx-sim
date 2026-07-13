// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Safe-minting ERC-721 whose `tokenURI` returns ~200KB of data cheaply (well within the metadata
/// gas budget) — the return-copy bomb that a plain `staticcall{gas: budget}` cannot bound, because
/// Solidity charges the returndata copy to the OUTER frame. Proves the ghost's size cap drops the
/// oversized payload (`tokenUri` undefined) instead of expanding memory toward OOG.
contract MetadataBombNft {
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

    function tokenURI(uint256) external pure returns (string memory) {
        // 200_000 bytes → ~200KB of returndata, far above the 64KB capture cap but cheap to produce.
        return string(new bytes(200_000));
    }
}
