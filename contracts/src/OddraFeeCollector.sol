// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OddraTreasury} from "./OddraTreasury.sol";

/// @notice Pons V2 fee escrow (verified on Robinhood Chain mainnet at 0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e):
///         `claim()` sends the caller's accrued creator fees as native ETH.
interface IPonsFeeEscrow {
    function claim() external;
    function balanceOf(address recipient) external view returns (uint256);
}

/// @notice Converts native ETH into USDG and returns the USDG received. No adapter ships with Oddra yet: one must be
///         written against a verified, liquid ETH/USDG route and audited before it is set.
interface ISwapAdapter {
    function swapEthForUsdg(uint256 minOut, address recipient) external payable returns (uint256 out);
}

/// @title OddraFeeCollector
/// @notice The $ODRA creator-fee recipient. Every asset it receives can only go one way: into the sportsbook treasury,
///         as USDG, recorded on-chain as a creator-fee contribution.
contract OddraFeeCollector is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    IERC20 public immutable usdg;
    OddraTreasury public immutable treasury;

    IPonsFeeEscrow public feeEscrow;
    ISwapAdapter public swapAdapter;

    uint256 public totalEthReceived;
    uint256 public totalEthConverted;
    uint256 public totalUsdgForwarded;

    event EthReceived(address indexed from, uint256 amount);
    event EscrowClaimed(uint256 amount);
    event Converted(uint256 ethIn, uint256 usdgOut, uint256 minOut);
    event Forwarded(uint256 amount);
    event FeeEscrowSet(address escrow);
    event SwapAdapterSet(address adapter);

    error NoAdapter();
    error NoEscrow();
    error SlippageExceeded(uint256 out, uint256 minOut);

    constructor(address admin, IERC20 token, OddraTreasury treasury_) AccessControlDefaultAdminRules(1 days, admin) {
        usdg = token;
        treasury = treasury_;
    }

    receive() external payable {
        totalEthReceived += msg.value;
        emit EthReceived(msg.sender, msg.value);
    }

    function setFeeEscrow(IPonsFeeEscrow escrow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        feeEscrow = escrow;
        emit FeeEscrowSet(address(escrow));
    }

    function setSwapAdapter(ISwapAdapter adapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        swapAdapter = adapter;
        emit SwapAdapterSet(address(adapter));
    }

    /// @notice Pull accrued creator fees from the launch platform's escrow. Anyone may call.
    function claimFromEscrow() external nonReentrant returns (uint256 amount) {
        if (address(feeEscrow) == address(0)) revert NoEscrow();
        uint256 before = address(this).balance;
        feeEscrow.claim();
        amount = address(this).balance - before;
        emit EscrowClaimed(amount);
    }

    /// @notice Convert ETH to USDG through the configured adapter, with a keeper-supplied minimum output.
    function convert(uint256 ethAmount, uint256 minOut) external onlyRole(KEEPER_ROLE) nonReentrant returns (uint256 out) {
        if (address(swapAdapter) == address(0)) revert NoAdapter();
        uint256 before = usdg.balanceOf(address(this));
        swapAdapter.swapEthForUsdg{value: ethAmount}(minOut, address(this));
        out = usdg.balanceOf(address(this)) - before;
        if (out < minOut) revert SlippageExceeded(out, minOut);
        totalEthConverted += ethAmount;
        emit Converted(ethAmount, out, minOut);
    }

    /// @notice Send every USDG held here to the treasury as a creator-fee contribution. Anyone may call.
    function forward() external nonReentrant returns (uint256 amount) {
        amount = usdg.balanceOf(address(this));
        if (amount == 0) return 0;
        usdg.forceApprove(address(treasury), amount);
        treasury.contribute(amount, treasury.SOURCE_CREATOR_FEES());
        totalUsdgForwarded += amount;
        emit Forwarded(amount);
    }
}
