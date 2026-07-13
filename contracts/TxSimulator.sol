// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271Like} from "./interfaces/IERC1271Like.sol";
import {IERC165} from "./interfaces/IERC165.sol";

contract TxSimulator is IERC1271Like, IERC165 {
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant ERC1271_INVALID_VALUE = 0xffffffff;
    bytes4 internal constant BALANCE_OF_SELECTOR = 0x70a08231;
    bytes4 internal constant ALLOWANCE_SELECTOR = 0xdd62ed3e;
    /// Permit2 `allowance(address owner, address token, address spender)` — verified via `cast sig`.
    bytes4 internal constant PERMIT2_ALLOWANCE_SELECTOR = 0x927da105;
    /// ERC-721 Enumerable `tokenOfOwnerByIndex(address,uint256)` — verified via `cast sig`.
    bytes4 internal constant TOKEN_OF_OWNER_BY_INDEX_SELECTOR = 0x2f745c59;
    /// ERC-721 Metadata `tokenURI(uint256)` — verified via `cast sig`.
    bytes4 internal constant TOKEN_URI_SELECTOR = 0xc87b56dd;
    /// ERC-1155 Metadata `uri(uint256)` — verified via `cast sig`.
    bytes4 internal constant ERC1155_URI_SELECTOR = 0x0e89341c;

    /// Receiver-hook return magic values (the selector of each hook). `ONERC721_RECEIVED` doubles as
    /// the ERC-721 TokenReceiver interface id (single-function interface → id equals the selector).
    bytes4 internal constant ONERC721_RECEIVED = 0x150b7a02;
    bytes4 internal constant ONERC1155_RECEIVED = 0xf23a6e61;
    bytes4 internal constant ONERC1155_BATCH_RECEIVED = 0xbc197c81;
    /// ERC-165 `supportsInterface(bytes4)` interface id, and the ERC-1155 TokenReceiver interface id.
    bytes4 internal constant ERC165_INTERFACE_ID = 0x01ffc9a7;
    bytes4 internal constant ERC1155_RECEIVER_INTERFACE_ID = 0x4e2312e0;

    /// Gas forwarded to best-effort balance/allowance probes. Bounds hostile or pathological
    /// implementations (e.g. a balanceOf that infinite-loops) to a fixed cost so one bad candidate
    /// cannot OOG the whole simulation. 150k covers proxied tokens with hooks; walletchan ships 100k.
    uint256 internal constant PROBE_GAS_LIMIT = 150_000;

    /// Per-collection cap on the Enumerable walk: a positive balance delta above this is treated as
    /// "not an NFT mint" and skipped, bounding the `tokenOfOwnerByIndex` probe loop.
    uint256 internal constant MAX_ENUMERATE_PER_COLLECTION = 50;
    /// Per-receipt gas budget for post-state `tokenURI`/`uri` metadata capture. On-chain SVG
    /// renderers are genuinely heavy; walletchan ships the same 5M/500k split. The budget bounds the
    /// callee's execution, and the return copy is separately size-capped at `METADATA_MAX_RETURN_BYTES`
    /// so a hostile renderer cannot force a huge outer-frame returndata copy within its gas budget.
    uint256 internal constant METADATA_GAS_LIMIT = 5_000_000;
    /// Gas reserved so metadata capture can never starve the ABI-encoding of the return value.
    uint256 internal constant METADATA_RETURN_GAS_RESERVE = 500_000;
    /// Hard cap on captured metadata returndata. Solidity's automatic returndata copy charges the
    /// OUTER frame, so a renderer returning megabytes within its gas budget would still expand this
    /// frame's memory toward OOG; oversized returns are dropped (empty `tokenUriRaw`) instead.
    uint256 internal constant METADATA_MAX_RETURN_BYTES = 65_536;

    /// The ghost executes at `from`, whose REAL storage persists under a code-only state override.
    /// Low slots collide with smart-wallet layouts (a Safe proxy keeps its singleton at slot 0), so
    /// capture state lives at namespaced hashed slots instead (ERC-7201 spirit).
    bytes32 internal constant NFT_RECEIPTS_SLOT = keccak256("viem-tx-sim.TxSimulator.nftReceipts");
    bytes32 internal constant NFT_CAPTURE_ENABLED_SLOT = keccak256("viem-tx-sim.TxSimulator.nftCaptureEnabled");

    struct SimulatedCall {
        address to;
        uint256 value;
        bytes data;
    }

    struct AllowanceProbe {
        address token;
        address spender;
    }

    struct BalanceProbe {
        address token;
        address account;
    }

    struct NftReceipt {
        address collection;
        uint256 tokenId;
        uint256 amount;
        bool erc1155;
        bytes tokenUriRaw;
    }

    struct NftSnapshot {
        uint256[] beforeBalances;
        bool[] ok;
    }

    struct SimulationResult {
        bool success;
        uint256 failingCallIndex;
        bytes revertData;
        address[] observedTokens;
        uint256[] maxTokenOutflows;
        uint256 maxNativeOutflow;
        uint256[] allowanceCheckpoints;
        uint256[] balanceCheckpoints;
        bool[] balanceProbeOk;
        uint256[] permit2Checkpoints;
        NftReceipt[] nftReceipts;
    }

    struct TokenState {
        uint256[] beforeBalances;
        uint256[] minBalances;
        bool[] isToken;
        address[] observedScratch;
        uint256 observedCount;
    }

    struct ExecutionState {
        bool[] isToken;
        uint256[] minBalances;
        uint256[] allowanceCheckpoints;
        uint256[] balanceCheckpoints;
        bool[] balanceProbeOk;
        uint256[] permit2Checkpoints;
        address permit2;
        uint256 stride;
    }

    function simulate(
        SimulatedCall[] calldata calls,
        address[] calldata candidates,
        AllowanceProbe[] calldata probes,
        BalanceProbe[] calldata balanceProbes,
        address permit2,
        AllowanceProbe[] calldata permit2Probes,
        address[] calldata nftCollections
    ) external returns (SimulationResult memory result) {
        // Flag-gate recording so the OFF path pays no SSTORE and the receiver hooks stay effectively
        // pure. Snapshot per-collection balances before the batch for the post-state Enumerable walk.
        NftSnapshot memory nftSnapshot;
        if (nftCollections.length > 0) {
            _setCaptureEnabled();
            nftSnapshot = _snapshotNftBalances(nftCollections);
        }

        TokenState memory tokenState = _snapshotTokens(candidates);
        // Built in a helper so the checkpoint-array allocations don't pin extra stack slots in this
        // frame; the arrays are shared by reference with `result` below.
        ExecutionState memory executionState = _newExecutionState(
            tokenState, calls.length + 1, probes.length, balanceProbes.length, permit2Probes.length, permit2
        );
        result.allowanceCheckpoints = executionState.allowanceCheckpoints;
        result.balanceCheckpoints = executionState.balanceCheckpoints;
        result.balanceProbeOk = executionState.balanceProbeOk;
        result.permit2Checkpoints = executionState.permit2Checkpoints;

        (result.success, result.failingCallIndex, result.revertData, result.maxNativeOutflow) =
            _executeCalls(calls, candidates, probes, balanceProbes, permit2Probes, executionState);

        result.observedTokens = _trimAddresses(tokenState.observedScratch, tokenState.observedCount);

        result.maxTokenOutflows = new uint256[](candidates.length);
        for (uint256 i = 0; i < candidates.length; ++i) {
            if (tokenState.isToken[i] && tokenState.beforeBalances[i] >= tokenState.minBalances[i]) {
                result.maxTokenOutflows[i] = tokenState.beforeBalances[i] - tokenState.minBalances[i];
            }
        }

        // Capture NFTs at the halt point (regardless of success), matching the balance `after`
        // semantics: the Enumerable walk over new tokens, then best-effort metadata, then copy out.
        if (nftCollections.length > 0) {
            _walkEnumerable(nftCollections, nftSnapshot);
            _captureMetadata();
            result.nftReceipts = _receiptsStorage();
        }
    }

    function _newExecutionState(
        TokenState memory tokenState,
        uint256 stride,
        uint256 allowanceProbeCount,
        uint256 balanceProbeCount,
        uint256 permit2ProbeCount,
        address permit2
    ) internal pure returns (ExecutionState memory executionState) {
        executionState.isToken = tokenState.isToken;
        executionState.minBalances = tokenState.minBalances;
        executionState.allowanceCheckpoints = new uint256[](allowanceProbeCount * stride);
        executionState.balanceCheckpoints = new uint256[](balanceProbeCount * stride);
        executionState.balanceProbeOk = new bool[](balanceProbeCount);
        executionState.permit2Checkpoints = new uint256[](permit2ProbeCount * stride);
        executionState.permit2 = permit2;
        executionState.stride = stride;
    }

    /// Probe-free per-call gas measurement for a sequential batch. Runs the same `_executeCall`
    /// primitive `simulate` uses, but with NOTHING between the `gasleft()` reads — no min-balance
    /// updates, no checkpoint recording — so the delta is the call's own execution gas and not probe
    /// overhead. Halt-and-report on the first failure (matching `simulate`): set `allSuccess = false`,
    /// record `failingCallIndex`, and leave `execGasPerCall[i..]` zero-filled. Intrinsic + calldata gas
    /// is added TS-side. Do NOT wire probes into this loop — pollution-freedom is its whole reason for
    /// existing.
    function simulateBatchGas(SimulatedCall[] calldata calls)
        external
        returns (bool allSuccess, uint256 failingCallIndex, uint256[] memory execGasPerCall)
    {
        allSuccess = true;
        failingCallIndex = type(uint256).max;
        execGasPerCall = new uint256[](calls.length);

        for (uint256 i = 0; i < calls.length; ++i) {
            uint256 gasBefore = gasleft();
            (bool ok,) = _executeCall(calls[i]);
            uint256 gasUsed = gasBefore - gasleft();
            if (!ok) {
                allSuccess = false;
                failingCallIndex = i;
                break;
            }
            execGasPerCall[i] = gasUsed;
        }
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _recover(hash, signature) == address(this) ? ERC1271_MAGIC_VALUE : ERC1271_INVALID_VALUE;
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (_captureEnabled()) _recordReceipt(msg.sender, tokenId, 1, false);
        return ONERC721_RECEIVED;
    }

    function onERC1155Received(address, address, uint256 id, uint256 value, bytes calldata)
        external
        returns (bytes4)
    {
        if (_captureEnabled()) _recordReceipt(msg.sender, id, value, true);
        return ONERC1155_RECEIVED;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata ids, uint256[] calldata values, bytes calldata)
        external
        returns (bytes4)
    {
        if (_captureEnabled()) {
            for (uint256 i = 0; i < ids.length; ++i) {
                _recordReceipt(msg.sender, ids[i], values[i], true);
            }
        }
        return ONERC1155_BATCH_RECEIVED;
    }

    /// ERC-165: advertise exactly the receiver interfaces this ghost implements, so senders that
    /// pre-check supportsInterface before safeTransferFrom don't false-revert during simulation
    /// (a real EOA has no code, so on-chain these checks are skipped entirely).
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == ERC165_INTERFACE_ID || interfaceId == ONERC721_RECEIVED
            || interfaceId == ERC1155_RECEIVER_INTERFACE_ID;
    }

    receive() external payable {}

    function _receiptsStorage() private pure returns (NftReceipt[] storage receipts) {
        bytes32 slot = NFT_RECEIPTS_SLOT;
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            receipts.slot := slot
        }
    }

    function _captureEnabled() private view returns (bool enabled) {
        bytes32 slot = NFT_CAPTURE_ENABLED_SLOT;
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            enabled := sload(slot)
        }
    }

    function _setCaptureEnabled() private {
        bytes32 slot = NFT_CAPTURE_ENABLED_SLOT;
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            sstore(slot, 1)
        }
    }

    /// Single recording path for hooks and the Enumerable walk. Aggregates duplicates so the public
    /// result carries one entry per (collection, tokenId, standard): a repeated ERC-1155 (collection,
    /// id) adds to the existing amount; a repeated ERC-721 is a no-op (a token id is owned once).
    function _recordReceipt(address collection, uint256 tokenId, uint256 amount, bool erc1155) private {
        NftReceipt[] storage receipts = _receiptsStorage();
        for (uint256 i = 0; i < receipts.length; ++i) {
            if (receipts[i].collection == collection && receipts[i].tokenId == tokenId && receipts[i].erc1155 == erc1155)
            {
                if (erc1155) receipts[i].amount += amount;
                return;
            }
        }
        NftReceipt storage receipt = receipts.push();
        receipt.collection = collection;
        receipt.tokenId = tokenId;
        receipt.amount = amount;
        receipt.erc1155 = erc1155;
    }

    function _snapshotTokens(address[] calldata candidates) internal view returns (TokenState memory tokenState) {
        tokenState.beforeBalances = new uint256[](candidates.length);
        tokenState.minBalances = new uint256[](candidates.length);
        tokenState.isToken = new bool[](candidates.length);
        tokenState.observedScratch = new address[](candidates.length);

        for (uint256 i = 0; i < candidates.length; ++i) {
            (bool ok, uint256 balance) = _tryBalanceOf(candidates[i], address(this));
            if (ok) {
                tokenState.isToken[i] = true;
                tokenState.beforeBalances[i] = balance;
                tokenState.minBalances[i] = balance;
                tokenState.observedScratch[tokenState.observedCount++] = candidates[i];
            }
        }
    }

    function _snapshotNftBalances(address[] calldata collections)
        internal
        view
        returns (NftSnapshot memory snapshot)
    {
        snapshot.beforeBalances = new uint256[](collections.length);
        snapshot.ok = new bool[](collections.length);
        for (uint256 i = 0; i < collections.length; ++i) {
            (snapshot.ok[i], snapshot.beforeBalances[i]) = _tryBalanceOf(collections[i], address(this));
        }
    }

    /// ERC-721 Enumerable walk: for each collection whose owned-balance grew by a small positive
    /// amount, read the newly-owned token ids at indices `[before, after)` and record them (deduped).
    /// Catches plain-`_mint` Enumerable collections (e.g. Uniswap V3 positions) that fire no hook.
    function _walkEnumerable(address[] calldata collections, NftSnapshot memory snapshot) internal {
        for (uint256 i = 0; i < collections.length; ++i) {
            if (!snapshot.ok[i]) continue;
            uint256 beforeBalance = snapshot.beforeBalances[i];
            (bool okAfter, uint256 afterBalance) = _tryBalanceOf(collections[i], address(this));
            if (!okAfter || afterBalance <= beforeBalance) continue;
            if (afterBalance - beforeBalance > MAX_ENUMERATE_PER_COLLECTION) continue;

            for (uint256 idx = beforeBalance; idx < afterBalance; ++idx) {
                (bool ok, uint256 tokenId) = _tryTokenOfOwnerByIndex(collections[i], idx);
                if (!ok) continue;
                // `_recordReceipt` dedups against hook-recorded ids, so the same token surfaced by both
                // the hook and this walk stays a single entry.
                _recordReceipt(collections[i], tokenId, 1, false);
            }
        }
    }

    function _tryTokenOfOwnerByIndex(address collection, uint256 index)
        internal
        view
        returns (bool ok, uint256 tokenId)
    {
        return _tryStaticUint(collection, abi.encodeWithSelector(TOKEN_OF_OWNER_BY_INDEX_SELECTOR, address(this), index), 32);
    }

    /// Post-state metadata capture: staticcall `tokenURI(id)` / `uri(id)` per receipt under a gas
    /// budget, storing raw returndata. Never reverts — a renderer that burns its budget just leaves
    /// `tokenUriRaw` empty rather than sinking the whole simulation.
    function _captureMetadata() internal {
        NftReceipt[] storage receipts = _receiptsStorage();
        for (uint256 i = 0; i < receipts.length; ++i) {
            if (gasleft() <= METADATA_RETURN_GAS_RESERVE) break;
            uint256 available = gasleft() - METADATA_RETURN_GAS_RESERVE;
            uint256 budget = available < METADATA_GAS_LIMIT ? available : METADATA_GAS_LIMIT;

            NftReceipt storage receipt = receipts[i];
            bytes4 selector = receipt.erc1155 ? ERC1155_URI_SELECTOR : TOKEN_URI_SELECTOR;
            (bool ok, bytes memory data) =
                _boundedMetadataCall(receipt.collection, abi.encodeWithSelector(selector, receipt.tokenId), budget);
            if (ok && data.length > 0) receipt.tokenUriRaw = data;
        }
    }

    /// Metadata staticcall with a size-capped return copy. A plain `staticcall{gas: budget}` bounds the
    /// callee but Solidity's automatic returndata copy charges THIS frame, so a hostile renderer could
    /// force a huge memory expansion within its budget. Capping `returndatasize()` before copying keeps
    /// the outer-frame cost bounded; oversized or failed calls return empty `data` (valid empty bytes).
    function _boundedMetadataCall(address target, bytes memory callData, uint256 gasBudget)
        private
        view
        returns (bool ok, bytes memory data)
    {
        uint256 maxBytes = METADATA_MAX_RETURN_BYTES;
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            ok := staticcall(gasBudget, target, add(callData, 0x20), mload(callData), 0, 0)
            let size := returndatasize()
            if gt(size, maxBytes) { ok := 0 }
            if ok {
                data := mload(0x40)
                mstore(data, size)
                returndatacopy(add(data, 0x20), 0, size)
                mstore(0x40, add(add(data, 0x20), and(add(size, 31), not(31))))
            }
        }
    }

    function _executeCalls(
        SimulatedCall[] calldata calls,
        address[] calldata candidates,
        AllowanceProbe[] calldata probes,
        BalanceProbe[] calldata balanceProbes,
        AllowanceProbe[] calldata permit2Probes,
        ExecutionState memory executionState
    ) internal returns (bool success, uint256 failingCallIndex, bytes memory revertData, uint256 nativeOutflow) {
        success = true;
        failingCallIndex = type(uint256).max;
        uint256 nativeStart = address(this).balance;
        uint256 nativeMin = nativeStart;
        if (probes.length > 0) {
            _recordAllowanceCheckpoints(probes, executionState.stride, 0, executionState.allowanceCheckpoints);
        }
        if (balanceProbes.length > 0) {
            _recordBalanceCheckpoints(
                balanceProbes,
                executionState.stride,
                0,
                executionState.balanceCheckpoints,
                executionState.balanceProbeOk
            );
        }
        if (permit2Probes.length > 0) {
            _recordPermit2Checkpoints(
                executionState.permit2, permit2Probes, executionState.stride, 0, executionState.permit2Checkpoints
            );
        }

        for (uint256 i = 0; i < calls.length; ++i) {
            (success, revertData) = _executeCall(calls[i]);
            if (!success) {
                failingCallIndex = i;
                if (probes.length > 0) {
                    _fillRemainingCheckpoints(
                        probes.length, executionState.stride, i, executionState.allowanceCheckpoints
                    );
                }
                if (balanceProbes.length > 0) {
                    _fillRemainingCheckpoints(
                        balanceProbes.length, executionState.stride, i, executionState.balanceCheckpoints
                    );
                }
                if (permit2Probes.length > 0) {
                    _fillRemainingCheckpoints(
                        permit2Probes.length, executionState.stride, i, executionState.permit2Checkpoints
                    );
                }
                break;
            }

            uint256 nativeAfter = address(this).balance;
            if (nativeAfter < nativeMin) nativeMin = nativeAfter;
            _updateMinBalances(candidates, executionState.isToken, executionState.minBalances);
            if (probes.length > 0) {
                _recordAllowanceCheckpoints(probes, executionState.stride, i + 1, executionState.allowanceCheckpoints);
            }
            if (balanceProbes.length > 0) {
                _recordBalanceCheckpoints(
                    balanceProbes,
                    executionState.stride,
                    i + 1,
                    executionState.balanceCheckpoints,
                    executionState.balanceProbeOk
                );
            }
            if (permit2Probes.length > 0) {
                _recordPermit2Checkpoints(
                    executionState.permit2, permit2Probes, executionState.stride, i + 1, executionState.permit2Checkpoints
                );
            }
        }

        nativeOutflow = nativeStart >= nativeMin ? nativeStart - nativeMin : 0;
    }

    function _executeCall(SimulatedCall calldata call_) internal returns (bool ok, bytes memory revertData) {
        // forge-lint: disable-next-line(low-level-calls, arbitrary-send-eth, calls-loop)
        (ok, revertData) = call_.to.call{value: call_.value}(call_.data);
        if (ok) revertData = "";
    }

    function _updateMinBalances(address[] calldata candidates, bool[] memory isToken, uint256[] memory minBalances)
        internal
        view
    {
        for (uint256 i = 0; i < candidates.length; ++i) {
            if (!isToken[i]) continue;

            (bool ok, uint256 afterBalance) = _tryBalanceOf(candidates[i], address(this));
            if (ok && afterBalance < minBalances[i]) minBalances[i] = afterBalance;
        }
    }

    function _recordAllowanceCheckpoints(
        AllowanceProbe[] calldata probes,
        uint256 stride,
        uint256 offset,
        uint256[] memory checkpoints
    ) internal view {
        for (uint256 i = 0; i < probes.length; ++i) {
            (bool ok, uint256 allowance) = _tryAllowance(probes[i].token, address(this), probes[i].spender);
            checkpoints[i * stride + offset] = ok ? allowance : 0;
        }
    }

    function _recordPermit2Checkpoints(
        address permit2,
        AllowanceProbe[] calldata probes,
        uint256 stride,
        uint256 offset,
        uint256[] memory checkpoints
    ) internal view {
        for (uint256 i = 0; i < probes.length; ++i) {
            (bool ok, uint256 amount) =
                _tryPermit2Allowance(permit2, probes[i].token, address(this), probes[i].spender);
            checkpoints[i * stride + offset] = ok ? amount : 0;
        }
    }

    function _recordBalanceCheckpoints(
        BalanceProbe[] calldata probes,
        uint256 stride,
        uint256 offset,
        uint256[] memory checkpoints,
        bool[] memory ok
    ) internal view {
        for (uint256 i = 0; i < probes.length; ++i) {
            (bool readOk, uint256 balance) = _readBalanceProbe(probes[i]);
            checkpoints[i * stride + offset] = readOk ? balance : 0;
            ok[i] = offset == 0 ? readOk : ok[i] && readOk;
        }
    }

    function _fillRemainingCheckpoints(
        uint256 probeCount,
        uint256 stride,
        uint256 lastOffset,
        uint256[] memory checkpoints
    ) internal pure {
        for (uint256 i = 0; i < probeCount; ++i) {
            uint256 last = checkpoints[i * stride + lastOffset];
            for (uint256 offset = lastOffset + 1; offset < stride; ++offset) {
                checkpoints[i * stride + offset] = last;
            }
        }
    }

    /// Shared best-effort read primitive: gas-capped staticcall, minimum-return-length check, then
    /// decode the first 32-byte word as a uint256. All one-word `_try*` probes route through here so
    /// there is a single hardening surface (the `PROBE_GAS_LIMIT` cap) instead of four copies.
    /// `minReturnBytes` guards each getter's ABI shape (32 for a single word; 96 for Permit2's
    /// three-word getter, whose first word — the uint160 amount — is what we decode).
    function _tryStaticUint(address target, bytes memory callData, uint256 minReturnBytes)
        private
        view
        returns (bool ok, uint256 value)
    {
        // Bounded read: only the first 32 bytes of returndata are ever copied (into scratch space),
        // so a hostile probe target cannot charge this frame memory expansion via an oversized
        // return. `returndatasize()` still validates the getter's full ABI shape against
        // `minReturnBytes` without copying it.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            let success := staticcall(PROBE_GAS_LIMIT, target, add(callData, 0x20), mload(callData), 0, 0)
            if and(success, iszero(lt(returndatasize(), minReturnBytes))) {
                returndatacopy(0, 0, 32)
                value := mload(0)
                ok := 1
            }
        }
    }

    function _tryBalanceOf(address token, address owner) internal view returns (bool ok, uint256 balance) {
        return _tryStaticUint(token, abi.encodeWithSelector(BALANCE_OF_SELECTOR, owner), 32);
    }

    function _readBalanceProbe(BalanceProbe calldata probe) internal view returns (bool ok, uint256 balance) {
        if (probe.token == address(0)) {
            ok = true;
            balance = probe.account.balance;
            return (ok, balance);
        }
        return _tryBalanceOf(probe.token, probe.account);
    }

    function _tryAllowance(address token, address owner, address spender)
        internal
        view
        returns (bool ok, uint256 allowance)
    {
        return _tryStaticUint(token, abi.encodeWithSelector(ALLOWANCE_SELECTOR, owner, spender), 32);
    }

    /// Best-effort Permit2 internal-allowance read. The getter returns (uint160 amount, uint48
    /// expiration, uint48 nonce) as three words; only the amount (first word) is relevant to
    /// measurement, so we require the full 96-byte return and decode the leading word.
    function _tryPermit2Allowance(address permit2, address token, address owner, address spender)
        internal
        view
        returns (bool ok, uint256 amount)
    {
        return _tryStaticUint(permit2, abi.encodeWithSelector(PERMIT2_ALLOWANCE_SELECTOR, owner, token, spender), 96);
    }

    function _trimAddresses(address[] memory input, uint256 length) internal pure returns (address[] memory output) {
        output = new address[](length);
        for (uint256 i = 0; i < length; ++i) {
            output[i] = input[i];
        }
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            // forge-lint: disable-next-line(inline-assembly)
            assembly ("memory-safe") {
                r := calldataload(signature.offset)
                s := calldataload(add(signature.offset, 0x20))
                v := byte(0, calldataload(add(signature.offset, 0x40)))
            }
            if (v < 27) v += 27;
            if (v != 27 && v != 28) return address(0);
            return ecrecover(hash, v, r, s);
        }

        if (signature.length == 64) {
            bytes32 r;
            bytes32 vs;
            // forge-lint: disable-next-line(inline-assembly)
            assembly ("memory-safe") {
                r := calldataload(signature.offset)
                vs := calldataload(add(signature.offset, 0x20))
            }
            bytes32 s = bytes32(uint256(vs) & 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 v = uint8((uint256(vs) >> 255) + 27);
            return ecrecover(hash, v, r, s);
        }

        return address(0);
    }
}
