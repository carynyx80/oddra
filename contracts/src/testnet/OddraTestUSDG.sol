// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OddraTestUSDG
/// @notice A testnet stand-in for USDG with a public faucet. It is NOT USDG, has no value, and refuses to deploy on
///         Robinhood Chain mainnet (4663). Real USDG exists on the testnet (0x7E95…802F) but cannot be minted freely,
///         which is why Oddra's testnet uses this token.
contract OddraTestUSDG is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    address public immutable minter;
    mapping(address => uint256) public lastDrip;

    error MainnetForbidden();
    error FaucetCooldown(uint256 nextAt);
    error NotMinter();

    constructor() ERC20("Oddra Test USDG (no value)", "tUSDG") {
        if (block.chainid == 4663) revert MainnetForbidden();
        minter = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice 1,000 tUSDG per address per hour.
    function faucet() external {
        uint256 next = lastDrip[msg.sender] + FAUCET_COOLDOWN;
        if (lastDrip[msg.sender] != 0 && block.timestamp < next) revert FaucetCooldown(next);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice For seeding the testnet treasury.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }
}
