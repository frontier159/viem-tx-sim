// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal hand-rolled ERC-721 Enumerable that mints with plain `_mint` (no receiver callback), so
/// the ghost's receiver hooks never fire and the token is discoverable only via the Enumerable walk
/// over `tokenOfOwnerByIndex` — the flagship case (e.g. a Uniswap V3 position mint). `safeMint`
/// additionally fires the receiver hook so the same collection exercises the dedup path.
contract EnumerableMint721 {
    error UnsafeRecipient();

    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    // Per-owner token list backing `tokenOfOwnerByIndex`, with an id→index map for swap-and-pop.
    mapping(address => uint256[]) private _ownedTokens;
    mapping(uint256 => uint256) private _ownedIndex;
    uint256 private _nextId;

    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256) {
        return _ownedTokens[owner][index];
    }

    /// Plain mint: assigns `n` sequential ids to `to` with no receiver callback.
    function mint(address to, uint256 n) external {
        for (uint256 i = 0; i < n; ++i) {
            _mint(to);
        }
    }

    /// Safe mint: same enumerable bookkeeping, but also invokes the ERC-721 receiver hook so `to`
    /// records a hook receipt for a token the Enumerable walk would also surface (dedup fixture).
    function safeMint(address to, uint256 n) external {
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = _mint(to);
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

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "not owner");
        _removeFromOwner(from, id);
        ownerOf[id] = to;
        _addToOwner(to, id);
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
    }

    function _mint(address to) internal returns (uint256 id) {
        id = _nextId++;
        ownerOf[id] = to;
        _addToOwner(to, id);
        balanceOf[to] += 1;
    }

    function _addToOwner(address owner, uint256 id) internal {
        _ownedIndex[id] = _ownedTokens[owner].length;
        _ownedTokens[owner].push(id);
    }

    function _removeFromOwner(address owner, uint256 id) internal {
        uint256 lastIndex = _ownedTokens[owner].length - 1;
        uint256 index = _ownedIndex[id];
        uint256 lastId = _ownedTokens[owner][lastIndex];
        _ownedTokens[owner][index] = lastId;
        _ownedIndex[lastId] = index;
        _ownedTokens[owner].pop();
    }
}
