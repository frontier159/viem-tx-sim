// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Safe-minting ERC-721 whose `tokenURI` burns ~3000 keccak rounds before returning a
/// `data:application/json;base64,...` string — mirrors walletchan's heavy-on-chain-renderer
/// regression, proving the ghost's metadata capture survives an expensive renderer under budget.
contract HeavyMetadataNft {
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

    function tokenURI(uint256 id) external view returns (string memory) {
        // Deliberately expensive hashing — the fixture's whole point is burning gas in the renderer.
        // forge-lint: disable-start(asm-keccak256)
        bytes32 acc = keccak256(abi.encodePacked(id, address(this)));
        for (uint256 i = 0; i < 3000; ++i) {
            acc = keccak256(abi.encodePacked(acc, i));
        }
        // forge-lint: disable-end(asm-keccak256)
        // Fixed base64 of `{"heavy":true}`; the keccak loop above is the point, not the payload.
        // forge-lint: disable-next-line(custom-errors)
        require(acc != bytes32(0), "unreachable");
        return "data:application/json;base64,eyJoZWF2eSI6dHJ1ZX0=";
    }
}
