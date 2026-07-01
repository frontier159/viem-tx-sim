// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SimpleProxy {
    uint256 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address implementation, bytes memory initData) {
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
        if (initData.length > 0) {
            (bool ok, bytes memory data) = implementation.delegatecall(initData);
            if (!ok) {
                assembly {
                    revert(add(data, 32), mload(data))
                }
            }
        }
    }

    fallback() external payable {
        _delegate();
    }

    receive() external payable {
        _delegate();
    }

    function _delegate() internal {
        address implementation;
        assembly {
            implementation := sload(IMPLEMENTATION_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}
