// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OddraMarkets} from "../src/OddraMarkets.sol";

contract MarketsHarness {
    function winMask(uint8 h, uint8 a, uint8 f) external pure returns (uint32) {
        return OddraMarkets.winMask(h, a, f);
    }

    function scenarioMask(uint256 i) external pure returns (uint32) {
        return OddraMarkets.scenarioMask(i);
    }
}

contract MarketsTest is Test {
    MarketsHarness internal m = new MarketsHarness();

    function bit(uint256 s) internal pure returns (uint32) {
        return uint32(1) << s;
    }

    function test_HomeWin_2_1_HomeFirst() public view {
        uint32 w = m.winMask(2, 1, 1);
        assertEq(w, bit(0) | bit(3) | bit(4) | bit(6) | bit(8) | bit(10) | bit(13 + 2 * 4 + 1));
    }

    function test_GoallessDraw() public view {
        uint32 w = m.winMask(0, 0, 0);
        assertEq(w, bit(1) | bit(3) | bit(5) | bit(7) | bit(9) | bit(12) | bit(13));
    }

    function test_AwayWin_OtherScore() public view {
        uint32 w = m.winMask(1, 5, 1);
        assertEq(w, bit(2) | bit(4) | bit(5) | bit(6) | bit(8) | bit(10) | bit(29));
    }

    function test_ScoreDraw_3_3() public view {
        uint32 w = m.winMask(3, 3, 2);
        assertEq(w, bit(1) | bit(3) | bit(5) | bit(6) | bit(8) | bit(11) | bit(13 + 15));
    }

    function test_RejectsImpossibleResults() public {
        vm.expectRevert(OddraMarkets.InvalidResult.selector);
        m.winMask(0, 0, 1); // a first scorer in a 0-0
        vm.expectRevert(OddraMarkets.InvalidResult.selector);
        m.winMask(2, 0, 2); // away scored first but never scored
        vm.expectRevert(OddraMarkets.InvalidResult.selector);
        m.winMask(1, 1, 0); // goals but no first scorer
    }

    /// @notice Each market has exactly one (or, for double chance, exactly two) winning selections in every result.
    function test_MarketsAreMutuallyExclusive() public view {
        for (uint256 i = 0; i < OddraMarkets.SCENARIOS; i++) {
            uint32 w = m.scenarioMask(i);
            assertEq(popcount(w & 0x7), 1, "1X2");
            assertEq(popcount((w >> 3) & 0x7), 2, "double chance");
            assertEq(popcount((w >> 6) & 0x3), 1, "totals");
            assertEq(popcount((w >> 8) & 0x3), 1, "btts");
            assertEq(popcount((w >> 10) & 0x7), 1, "first scorer");
            assertEq(popcount(w >> 13), 1, "correct score");
        }
    }

    function test_ScenariosAreDistinct() public view {
        for (uint256 i = 0; i < OddraMarkets.SCENARIOS; i++) {
            for (uint256 j = i + 1; j < OddraMarkets.SCENARIOS; j++) {
                assertTrue(m.scenarioMask(i) != m.scenarioMask(j));
            }
        }
    }

    /// @notice The 33 scenarios cover every possible result: whatever happens, its win mask is one of them. This is what
    ///         makes "reserve the worst scenario" a true worst case.
    function testFuzz_ScenariosCoverEveryResult(uint8 h, uint8 a, uint8 f) public view {
        h = uint8(bound(h, 0, 15));
        a = uint8(bound(a, 0, 15));
        f = uint8(bound(f, 0, 2));
        if (h + a == 0) f = 0;
        else if (f == 0) f = h > 0 ? 1 : 2;
        if (f == 1 && h == 0) f = 2;
        if (f == 2 && a == 0) f = 1;
        uint32 w = m.winMask(h, a, f);
        bool found;
        for (uint256 i = 0; i < OddraMarkets.SCENARIOS; i++) {
            if (m.scenarioMask(i) == w) found = true;
        }
        assertTrue(found, "result not covered by any scenario");
    }

    function popcount(uint32 x) internal pure returns (uint256 n) {
        while (x != 0) {
            n += x & 1;
            x >>= 1;
        }
    }
}
