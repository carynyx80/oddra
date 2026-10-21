// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title OddraMarkets
/// @notice The six launch markets as 30 selections, and the 33 result scenarios that decide them.
/// @dev Every selection is a pure function of (homeGoals, awayGoals, firstScorer). The book reserves, per match, the
///      largest total payout over all scenarios, so correlated selections (Home win + Over 2.5 + 3-1 …) are covered
///      together instead of being summed or treated as independent.
///
///  Selections
///   0 HOME  1 DRAW  2 AWAY                       match result
///   3 HOME_OR_DRAW  4 HOME_OR_AWAY  5 DRAW_OR_AWAY  double chance
///   6 OVER_2_5  7 UNDER_2_5                        total goals
///   8 BTTS_YES  9 BTTS_NO                          both teams to score
///  10 FIRST_HOME  11 FIRST_AWAY  12 FIRST_NONE     first team to score
///  13 + 4*h + a  correct score h-a for h, a in 0..3; 29 = any other score
library OddraMarkets {
    uint256 internal constant SELECTIONS = 30;
    uint256 internal constant SCENARIOS = 33;
    uint8 internal constant CS_OTHER = 29;

    /// @dev Scenario table, three bytes each (home, away, firstScorer: 0 none, 1 home, 2 away). The first 25 cover every
    ///      listed correct score with each possible first scorer; the last 8 cover every distinct way an "other" score
    ///      can settle the remaining markets (always over 2.5; result × both-teams-to-score × first scorer).
    bytes internal constant TABLE = hex"000000" hex"000102" hex"000202" hex"000302" hex"010001" hex"010101" hex"010102"
        hex"010201" hex"010202" hex"010301" hex"010302" hex"020001" hex"020101" hex"020102" hex"020201" hex"020202"
        hex"020301" hex"020302" hex"030001" hex"030101" hex"030102" hex"030201" hex"030202" hex"030301" hex"030302"
        hex"040001" hex"040101" hex"040102" hex"000402" hex"010401" hex"010402" hex"040401" hex"040402";

    error InvalidResult();

    function isValidResult(uint8 h, uint8 a, uint8 first) internal pure returns (bool) {
        if (first > 2) return false;
        if (h == 0 && a == 0) return first == 0;
        if (first == 0) return false;
        if (first == 1) return h > 0;
        return a > 0;
    }

    /// @notice Bitmask of the winning selections for a final result.
    function winMask(uint8 h, uint8 a, uint8 first) internal pure returns (uint32 m) {
        if (!isValidResult(h, a, first)) revert InvalidResult();
        if (h > a) m = (1 << 0) | (1 << 3) | (1 << 4);
        else if (h == a) m = (1 << 1) | (1 << 3) | (1 << 5);
        else m = (1 << 2) | (1 << 4) | (1 << 5);
        m |= (uint16(h) + a > 2) ? uint32(1 << 6) : uint32(1 << 7);
        m |= (h > 0 && a > 0) ? uint32(1 << 8) : uint32(1 << 9);
        m |= first == 1 ? uint32(1 << 10) : first == 2 ? uint32(1 << 11) : uint32(1 << 12);
        m |= (h <= 3 && a <= 3) ? uint32(1) << (13 + h * 4 + a) : uint32(1) << CS_OTHER;
    }

    function scenario(uint256 i) internal pure returns (uint8 h, uint8 a, uint8 first) {
        bytes memory t = TABLE;
        return (uint8(t[i * 3]), uint8(t[i * 3 + 1]), uint8(t[i * 3 + 2]));
    }

    function scenarioMask(uint256 i) internal pure returns (uint32) {
        (uint8 h, uint8 a, uint8 f) = scenario(i);
        return winMask(h, a, f);
    }
}
