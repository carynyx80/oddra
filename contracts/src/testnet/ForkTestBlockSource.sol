// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBlockSource} from "../OddraMatchRegistry.sol";

/// @notice TEST ONLY. On an anvil fork of Robinhood Chain, contracts see L1 block numbers and `blockhash` returns 0, so
///         neither ArbSys nor native block hashes are available. This source returns block.number and a deterministic
///         stand-in hash so the full cycle can be exercised against mainnet state. It offers no unpredictability and
///         refuses to deploy on Robinhood Chain mainnet.
contract ForkTestBlockSource is IBlockSource {
    constructor() {
        require(block.chainid != 4663, "test only");
    }

    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function arbBlockHash(uint256 blockNumber) external view returns (bytes32) {
        if (blockNumber >= block.number) return bytes32(0);
        return keccak256(abi.encode(blockNumber, address(this)));
    }
}
