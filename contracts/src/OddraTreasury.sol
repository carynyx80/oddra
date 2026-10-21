// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title OddraTreasury
/// @notice Holds the sportsbook's USDG. Every open bet's worst-case payout is reserved here, and reserved funds can
///         only leave as a payout to a bettor. Administrators can withdraw only the unreserved balance.
contract OddraTreasury is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant BOOK_ROLE = keccak256("BOOK_ROLE");
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    bytes32 public constant SOURCE_CREATOR_FEES = "creator-fees";
    bytes32 public constant SOURCE_HOUSE = "house";

    IERC20 public immutable usdg;

    /// @notice Sum of the worst-case payouts of every unsettled match, plus unclaimed winnings and refunds.
    uint256 public totalReserved;
    uint256 public totalStakes;
    uint256 public totalPayouts;
    uint256 public totalContributed;
    uint256 public totalCreatorFees;
    uint256 public totalWithdrawn;

    event Contributed(address indexed from, bytes32 indexed source, uint256 amount);
    event StakeRecorded(uint256 amount);
    event Reserved(uint256 amount, uint256 totalReserved);
    event Released(uint256 amount, uint256 totalReserved);
    event Paid(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    error Insolvent(uint256 balance, uint256 required);
    error ExceedsFree(uint256 free, uint256 amount);

    constructor(address admin, IERC20 token) AccessControlDefaultAdminRules(1 days, admin) {
        usdg = token;
    }

    function balance() public view returns (uint256) {
        return usdg.balanceOf(address(this));
    }

    /// @notice USDG not backing any obligation.
    function freeBalance() public view returns (uint256) {
        uint256 b = balance();
        return b > totalReserved ? b - totalReserved : 0;
    }

    /// @notice Add liquidity. Creator fees arrive through the fee collector with SOURCE_CREATOR_FEES.
    function contribute(uint256 amount, bytes32 source) external nonReentrant {
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        totalContributed += amount;
        if (source == SOURCE_CREATOR_FEES) totalCreatorFees += amount;
        emit Contributed(msg.sender, source, amount);
    }

    // ------------------------------------------------------------------ book only

    /// @dev The stake has already been transferred in by the book.
    function recordStake(uint256 amount) external onlyRole(BOOK_ROLE) {
        totalStakes += amount;
        emit StakeRecorded(amount);
    }

    function reserve(uint256 amount) external onlyRole(BOOK_ROLE) {
        uint256 next = totalReserved + amount;
        if (next > balance()) revert Insolvent(balance(), next);
        totalReserved = next;
        emit Reserved(amount, next);
    }

    function release(uint256 amount) external onlyRole(BOOK_ROLE) {
        totalReserved -= amount;
        emit Released(amount, totalReserved);
    }

    /// @notice Pay a bettor out of reserved funds. Reverts if the transfer fails, so the caller can retry later.
    function pay(address to, uint256 amount) external onlyRole(BOOK_ROLE) nonReentrant {
        totalReserved -= amount;
        totalPayouts += amount;
        usdg.safeTransfer(to, amount);
        emit Paid(to, amount);
    }

    // ------------------------------------------------------------------ treasurer

    function withdraw(address to, uint256 amount) external onlyRole(TREASURER_ROLE) nonReentrant {
        uint256 free = freeBalance();
        if (amount > free) revert ExceedsFree(free, amount);
        totalWithdrawn += amount;
        usdg.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }
}
