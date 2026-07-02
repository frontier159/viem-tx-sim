// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SimpleProxy {
    error InitFailed(bytes data);
    error ZeroImplementation();

    uint256 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address implementation, bytes memory initData) {
        if (implementation == address(0)) revert ZeroImplementation();
        // forge-lint: disable-next-line(inline-assembly)
        assembly {
            sstore(IMPLEMENTATION_SLOT, implementation)
        }
        if (initData.length > 0) {
            // forge-lint: disable-next-line(low-level-calls, controlled-delegatecall)
            (bool ok, bytes memory data) = implementation.delegatecall(initData);
            if (!ok) revert InitFailed(data);
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
        // forge-lint: disable-next-line(inline-assembly, controlled-delegatecall)
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
