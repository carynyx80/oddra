// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @title OddraRiskManager
/// @notice Betting limits and solvency rules. Changes apply to new bets only; accepted bets are never touched.
contract OddraRiskManager is AccessControlDefaultAdminRules {
    bytes32 public constant RISK_ROLE = keccak256("RISK_ROLE");

    struct Limits {
        uint128 minStake;
        uint128 maxStake;
        uint128 maxPayout;
        /// @notice Total potential payout on one selection of one match.
        uint128 maxSelectionLiability;
        /// @notice Reserved worst case for one match.
        uint128 maxMatchLiability;
        /// @notice Unreserved USDG that must remain after any bet.
        uint128 minFreeReserve;
        /// @notice All reserved liabilities may not exceed this share of the treasury balance (basis points).
        uint16 maxTotalLiabilityBps;
        /// @notice A single bet's payout may not exceed this share of the free balance (basis points).
        uint16 maxPayoutOfFreeBps;
    }

    Limits public limits;

    event LimitsUpdated(Limits limits);

    error StakeOutOfRange(uint256 stake);
    error PayoutTooHigh(uint256 payout, uint256 max);
    error SelectionLiabilityTooHigh(uint256 liability);
    error MatchLiabilityTooHigh(uint256 liability);
    error TotalLiabilityTooHigh(uint256 reserved, uint256 max);
    error ReserveBreached(uint256 free, uint256 minFree);
    error BadLimits();

    constructor(address admin, Limits memory initial) AccessControlDefaultAdminRules(1 days, admin) {
        _set(initial);
    }

    function setLimits(Limits calldata next) external onlyRole(RISK_ROLE) {
        _set(next);
    }

    function _set(Limits memory l) internal {
        if (
            l.minStake == 0 || l.maxStake < l.minStake || l.maxPayout < l.maxStake || l.maxTotalLiabilityBps > 10_000
                || l.maxPayoutOfFreeBps > 10_000 || l.maxPayoutOfFreeBps == 0
        ) revert BadLimits();
        limits = l;
        emit LimitsUpdated(l);
    }

    /// @notice Reverts unless a bet keeps the book within every limit.
    /// @param freeBefore unreserved treasury USDG before this bet's stake arrived and before its reservation
    /// @param balanceAfter treasury balance including this stake
    /// @param reservedAfter total reserved after this bet's reservation
    function check(
        uint256 stake,
        uint256 payout,
        uint256 selectionLiability,
        uint256 matchLiability,
        uint256 freeBefore,
        uint256 balanceAfter,
        uint256 reservedAfter
    ) external view {
        Limits memory l = limits;
        if (stake < l.minStake || stake > l.maxStake) revert StakeOutOfRange(stake);
        uint256 maxPay = l.maxPayout;
        uint256 exposureCap = (freeBefore * l.maxPayoutOfFreeBps) / 10_000;
        if (exposureCap < maxPay) maxPay = exposureCap;
        if (payout > maxPay) revert PayoutTooHigh(payout, maxPay);
        if (selectionLiability > l.maxSelectionLiability) revert SelectionLiabilityTooHigh(selectionLiability);
        if (matchLiability > l.maxMatchLiability) revert MatchLiabilityTooHigh(matchLiability);
        uint256 maxTotal = (balanceAfter * l.maxTotalLiabilityBps) / 10_000;
        if (reservedAfter > maxTotal) revert TotalLiabilityTooHigh(reservedAfter, maxTotal);
        uint256 freeAfter = balanceAfter > reservedAfter ? balanceAfter - reservedAfter : 0;
        if (freeAfter < l.minFreeReserve) revert ReserveBreached(freeAfter, l.minFreeReserve);
    }
}
