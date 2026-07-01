// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC1271Like {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

interface IERC20ForPermit2Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract Permit2Like {
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    function pullWithSignature(address token, uint256 amount, bytes32 hash, bytes calldata signature) external {
        if (msg.sender.code.length > 0) {
            require(IERC1271Like(msg.sender).isValidSignature(hash, signature) == ERC1271_MAGIC_VALUE, "bad 1271 sig");
        } else {
            require(_recover(hash, signature) == msg.sender, "bad eoa sig");
        }

        require(IERC20ForPermit2Like(token).transferFrom(msg.sender, address(this), amount), "pull failed");
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
