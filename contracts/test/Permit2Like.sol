// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271Like} from "../interfaces/IERC1271Like.sol";
import {IERC20} from "./IERC20.sol";

contract Permit2Like {
    error Bad1271Signature();
    error BadEoaSignature();
    error PullFailed();

    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    function pullWithSignature(address token, uint256 amount, bytes32 hash, bytes calldata signature) external {
        if (msg.sender.code.length > 0) {
            if (IERC1271Like(msg.sender).isValidSignature(hash, signature) != ERC1271_MAGIC_VALUE) {
                revert Bad1271Signature();
            }
        } else if (_recover(hash, signature) != msg.sender) {
            revert BadEoaSignature();
        }

        if (!IERC20(token).transferFrom(msg.sender, address(this), amount)) revert PullFailed();
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        // forge-lint: disable-next-line(inline-assembly)
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
