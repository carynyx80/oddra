// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title OddraTreasury
/// @notice Holds the sportsbook's liquidity in two assets: USDG and native ETH (`ETH = address(0)`). Accounting is kept
///         separately per asset. Every open bet's worst-case payout is reserved in the asset it was staked in, and
///         reserved funds can only leave as a payout to a bettor. Administrators can withdraw only unreserved funds.
contract OddraTreasury is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant BOOK_ROLE = keccak256("BOOK_ROLE");
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    bytes32 public constant SOURCE_CREATOR_FEES = "creator-fees";
    bytes32 public constant SOURCE_HOUSE = "house";
    bytes32 public constant SOURCE_DISPUTE = "dispute-bond";

    address public constant ETH = address(0);
    IERC20 public immutable usdg;

    mapping(address asset => uint256) public totalReserved;
    mapping(address asset => uint256) public totalStakes;
    mapping(address asset => uint256) public totalPayouts;
    mapping(address asset => uint256) public totalContributed;
    mapping(address asset => uint256) public totalCreatorFees;
    mapping(address asset => uint256) public totalWithdrawn;

    event Contributed(address indexed asset, address indexed from, bytes32 indexed source, uint256 amount);
    event StakeRecorded(address indexed asset, uint256 amount);
    event Reserved(address indexed asset, uint256 amount, uint256 totalReserved);
    event Released(address indexed asset, uint256 amount, uint256 totalReserved);
    event Paid(address indexed asset, address indexed to, uint256 amount);
    event Withdrawn(address indexed asset, address indexed to, uint256 amount);

    error UnsupportedAsset(address asset);
    error Insolvent(address asset, uint256 balance, uint256 required);
    error ExceedsFree(address asset, uint256 free, uint256 amount);
    error BadValue();
    error EthTransferFailed();

    constructor(address admin, IERC20 token) AccessControlDefaultAdminRules(1 days, admin) {
        usdg = token;
    }

    modifier supported(address asset) {
        if (asset != ETH && asset != address(usdg)) revert UnsupportedAsset(asset);
        _;
    }

    /// @dev Untracked ETH is refused: every wei must come in through an accounted path.
    receive() external payable {
        revert BadValue();
    }

    function balance(address asset) public view supported(asset) returns (uint256) {
        return asset == ETH ? address(this).balance : usdg.balanceOf(address(this));
    }

    /// @notice Funds not backing any obligation.
    function freeBalance(address asset) public view returns (uint256) {
        uint256 b = balance(asset);
        return b > totalReserved[asset] ? b - totalReserved[asset] : 0;
    }

    /// @notice Add liquidity. For ETH send it as value with `amount == msg.value`.
    function contribute(address asset, uint256 amount, bytes32 source) external payable nonReentrant supported(asset) {
        if (asset == ETH) {
            if (msg.value != amount) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            usdg.safeTransferFrom(msg.sender, address(this), amount);
        }
        totalContributed[asset] += amount;
        if (source == SOURCE_CREATOR_FEES) totalCreatorFees[asset] += amount;
        emit Contributed(asset, msg.sender, source, amount);
    }

    // ------------------------------------------------------------------ book only

    /// @dev USDG stakes are transferred in by the book before this call; ETH stakes arrive as the call's value.
    function recordStake(address asset, uint256 amount) external payable onlyRole(BOOK_ROLE) supported(asset) {
        if (asset == ETH ? msg.value != amount : msg.value != 0) revert BadValue();
        totalStakes[asset] += amount;
        emit StakeRecorded(asset, amount);
    }

    function reserve(address asset, uint256 amount) external onlyRole(BOOK_ROLE) {
        uint256 next = totalReserved[asset] + amount;
        uint256 b = balance(asset);
        if (next > b) revert Insolvent(asset, b, next);
        totalReserved[asset] = next;
        emit Reserved(asset, amount, next);
    }

    function release(address asset, uint256 amount) external onlyRole(BOOK_ROLE) {
        totalReserved[asset] -= amount;
        emit Released(asset, amount, totalReserved[asset]);
    }

    /// @notice Pay a bettor out of reserved funds. Reverts if the transfer fails, so the caller can retry later.
    function pay(address asset, address to, uint256 amount) external onlyRole(BOOK_ROLE) nonReentrant {
        totalReserved[asset] -= amount;
        totalPayouts[asset] += amount;
        _send(asset, to, amount);
        emit Paid(asset, to, amount);
    }

    // ------------------------------------------------------------------ treasurer

    function withdraw(address asset, address to, uint256 amount) external onlyRole(TREASURER_ROLE) nonReentrant {
        uint256 free = freeBalance(asset);
        if (amount > free) revert ExceedsFree(asset, free, amount);
        totalWithdrawn[asset] += amount;
        _send(asset, to, amount);
        emit Withdrawn(asset, to, amount);
    }

    function _send(address asset, address to, uint256 amount) private {
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            usdg.safeTransfer(to, amount);
        }
    }
}
