// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OddraBook} from "../src/OddraBook.sol";
import {OddraRiskManager} from "../src/OddraRiskManager.sol";
import {OddraTreasury} from "../src/OddraTreasury.sol";
import {Base} from "./Base.t.sol";

contract BookTest is Base {
    // selections
    uint8 constant HOME = 0;
    uint8 constant DRAW = 1;
    uint8 constant AWAY = 2;
    uint8 constant HOME_OR_DRAW = 3;
    uint8 constant HOME_OR_AWAY = 4;
    uint8 constant DRAW_OR_AWAY = 5;
    uint8 constant OVER = 6;
    uint8 constant UNDER = 7;
    uint8 constant BTTS_YES = 8;
    uint8 constant BTTS_NO = 9;
    uint8 constant FIRST_HOME = 10;
    uint8 constant FIRST_AWAY = 11;
    uint8 constant FIRST_NONE = 12;
    uint8 constant CS_OTHER = 29;

    function cs(uint8 h, uint8 a) internal pure returns (uint8) {
        return 13 + h * 4 + a;
    }

    // ------------------------------------------------------------------ placing bets

    function test_StakeMovesToTreasuryAtRecordedOdds() public {
        uint32[30] memory o = flatOdds(150);
        o[HOME] = 210;
        openMatch(1, o);
        uint256 tBefore = usdg.balanceOf(address(treasury));
        uint256 id = bet(alice, 1, HOME, 10 * U);
        assertEq(usdg.balanceOf(address(treasury)) - tBefore, 10 * U);
        OddraBook.Bet memory b = book.getBet(id);
        assertEq(b.odds, 210);
        assertEq(b.stake, 10 * U);
        assertEq(b.payout, 21 * U);
        assertEq(b.bettor, alice);
        assertEq(book.betsOf(alice).length, 1);
    }

    function test_LaterOddsChangesNeverTouchAcceptedBets() public {
        openMatch(1, flatOdds(200));
        uint256 id = bet(alice, 1, HOME, 10 * U);
        vm.prank(operator);
        book.publishOdds(1, flatOdds(120));
        assertEq(book.getBet(id).odds, 200);
        finish(1, 1, 0, 1);
        uint256 before = usdg.balanceOf(alice);
        book.claim(id);
        assertEq(usdg.balanceOf(alice) - before, 20 * U);
    }

    function test_MinOddsProtectsAgainstPriceDrop() public {
        openMatch(1, flatOdds(180));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OddraBook.OddsChanged.selector, uint32(180), uint32(200)));
        book.placeBet(1, HOME, uint128(10 * U), 200);
    }

    function test_NoBetsBeforeOpenOrAfterKickoff() public {
        uint64 openTime = uint64(block.timestamp + 100);
        vm.prank(operator);
        registry.createMatch(1, 1, 2, CONFIG, RULES, keccak256(abi.encodePacked(SEED)), openTime, openTime + 300);
        vm.prank(operator);
        book.publishOdds(1, flatOdds(200));
        vm.prank(alice);
        vm.expectRevert(OddraBook.MarketClosed.selector);
        book.placeBet(1, HOME, uint128(10 * U), 0);
        vm.warp(openTime + 300);
        vm.prank(alice);
        vm.expectRevert(OddraBook.MarketClosed.selector);
        book.placeBet(1, HOME, uint128(10 * U), 0);
        vm.prank(operator);
        vm.expectRevert(OddraBook.MarketClosed.selector);
        book.publishOdds(1, flatOdds(300));
    }

    function test_SuspendedSelectionRejected() public {
        uint32[30] memory o = flatOdds(200);
        o[CS_OTHER] = 0;
        openMatch(1, o);
        vm.prank(alice);
        vm.expectRevert(OddraBook.OddsUnavailable.selector);
        book.placeBet(1, CS_OTHER, uint128(10 * U), 0);
    }

    function test_PauseStopsBettingButNotClaims() public {
        openMatch(1, flatOdds(200));
        uint256 id = bet(alice, 1, HOME, 10 * U);
        vm.prank(admin);
        book.pause();
        vm.prank(bob);
        vm.expectRevert();
        book.placeBet(1, HOME, uint128(10 * U), 0);
        finish(1, 1, 0, 1);
        book.claim(id);
        assertEq(uint8(book.betStatus(id)), uint8(OddraBook.BetStatus.Paid));
    }

    // ------------------------------------------------------------------ every market settles correctly

    function test_SettlesAllSixMarkets() public {
        openMatch(1, flatOdds(300));
        uint8[13] memory sels = [
            HOME,
            DRAW,
            AWAY,
            HOME_OR_DRAW,
            HOME_OR_AWAY,
            DRAW_OR_AWAY,
            OVER,
            UNDER,
            BTTS_YES,
            BTTS_NO,
            FIRST_HOME,
            FIRST_AWAY,
            FIRST_NONE
        ];
        uint256[13] memory ids;
        for (uint256 i = 0; i < 13; i++) {
            ids[i] = bet(alice, 1, sels[i], 1 * U);
        }
        uint256 csWin = bet(alice, 1, cs(2, 1), 1 * U);
        uint256 csLose = bet(alice, 1, cs(1, 2), 1 * U);
        uint256 other = bet(alice, 1, CS_OTHER, 1 * U);
        finish(1, 2, 1, 2); // 2-1, away scored first
        bool[13] memory expectWin =
            [true, false, false, true, true, false, true, false, true, false, false, true, false];
        for (uint256 i = 0; i < 13; i++) {
            OddraBook.BetStatus s = book.betStatus(ids[i]);
            if (i == 0) {
                // the first status read happens before the lazy book settlement: drive it
                book.settleBook(1);
                s = book.betStatus(ids[i]);
            }
            assertEq(uint8(s), uint8(expectWin[i] ? OddraBook.BetStatus.Won : OddraBook.BetStatus.Lost), "market");
        }
        assertEq(uint8(book.betStatus(csWin)), uint8(OddraBook.BetStatus.Won));
        assertEq(uint8(book.betStatus(csLose)), uint8(OddraBook.BetStatus.Lost));
        assertEq(uint8(book.betStatus(other)), uint8(OddraBook.BetStatus.Lost));
    }

    function test_OtherScoreAndGoallessDraw() public {
        openMatch(1, flatOdds(500));
        uint256 other = bet(alice, 1, CS_OTHER, 2 * U);
        uint256 nil = bet(alice, 1, cs(0, 0), 2 * U);
        finish(1, 4, 2, 1);
        book.settleBook(1);
        assertEq(book.claimable(other), 10 * U);
        assertEq(book.claimable(nil), 0);

        openMatch(2, flatOdds(500));
        uint256 nil2 = bet(alice, 2, cs(0, 0), 2 * U);
        uint256 none = bet(alice, 2, FIRST_NONE, 2 * U);
        uint256 under = bet(alice, 2, UNDER, 2 * U);
        finish(2, 0, 0, 0);
        book.settleBook(2);
        assertEq(book.claimable(nil2), 10 * U);
        assertEq(book.claimable(none), 10 * U);
        assertEq(book.claimable(under), 10 * U);
    }

    function test_WinnerPaidStakeTimesOdds_LoserGetsNothing() public {
        openMatch(1, flatOdds(200));
        uint256 win = bet(alice, 1, HOME, 10 * U);
        uint256 lose = bet(bob, 1, AWAY, 10 * U);
        finish(1, 3, 0, 1);
        uint256 a0 = usdg.balanceOf(alice);
        book.claim(win);
        assertEq(usdg.balanceOf(alice) - a0, 20 * U);
        vm.expectRevert(OddraBook.NothingToClaim.selector);
        book.claim(lose);
    }

    function test_NoDoubleClaim() public {
        openMatch(1, flatOdds(200));
        uint256 id = bet(alice, 1, HOME, 10 * U);
        finish(1, 1, 0, 1);
        book.claim(id);
        vm.expectRevert(OddraBook.AlreadyPaid.selector);
        book.claim(id);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(book.payoutBatch(ids), 0);
    }

    function test_ClaimByThirdPartyStillPaysBettor() public {
        openMatch(1, flatOdds(200));
        uint256 id = bet(alice, 1, HOME, 10 * U);
        finish(1, 1, 0, 1);
        uint256 a0 = usdg.balanceOf(alice);
        vm.prank(keeper);
        book.claim(id);
        assertEq(usdg.balanceOf(alice) - a0, 20 * U);
    }

    // ------------------------------------------------------------------ automatic payouts

    function test_FailedAutoPayoutKeepsClaimRight() public {
        openMatch(1, flatOdds(200));
        uint256 a = bet(alice, 1, HOME, 10 * U);
        uint256 b = bet(bob, 1, HOME, 10 * U);
        finish(1, 1, 0, 1);
        usdg.setBlocked(alice, true);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        vm.prank(keeper);
        uint256 paid = book.payoutBatch(ids);
        assertEq(paid, 1, "bob paid, alice failed");
        assertEq(uint8(book.betStatus(a)), uint8(OddraBook.BetStatus.Won));
        assertEq(uint8(book.betStatus(b)), uint8(OddraBook.BetStatus.Paid));
        assertSolvent();
        usdg.setBlocked(alice, false);
        book.claim(a);
        assertEq(uint8(book.betStatus(a)), uint8(OddraBook.BetStatus.Paid));
        (,,,, uint256 reserved, uint256 owed) = book.bookState(1);
        assertEq(reserved, 0);
        assertEq(owed, 0);
    }

    // ------------------------------------------------------------------ voids

    function test_VoidRefundsEveryStake() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(400));
        uint256 a = bet(alice, 1, HOME, 10 * U);
        uint256 b = bet(bob, 1, cs(3, 3), 5 * U);
        vm.warp(kickoff + registry.REVEAL_WINDOW() + 1);
        registry.voidMatch(1);
        uint256 a0 = usdg.balanceOf(alice);
        uint256 b0 = usdg.balanceOf(bob);
        book.claim(a);
        book.claim(b);
        assertEq(usdg.balanceOf(alice) - a0, 10 * U);
        assertEq(usdg.balanceOf(bob) - b0, 5 * U);
        assertEq(treasury.totalReserved(), 0);
    }

    // ------------------------------------------------------------------ treasury and risk

    function test_CorrelatedOutcomesAreReservedTogether() public {
        openMatch(1, flatOdds(200));
        bet(alice, 1, HOME, 100 * U); // 200
        bet(alice, 1, OVER, 100 * U); // 200
        bet(alice, 1, cs(3, 1), 100 * U); // 200
        // a 3-1 home win pays all three at once
        assertEq(treasury.totalReserved(), 600 * U);
    }

    function test_MutuallyExclusiveOutcomesReserveOnlyTheWorst() public {
        openMatch(1, flatOdds(250));
        bet(alice, 1, HOME, 100 * U); // 250
        bet(bob, 1, AWAY, 100 * U); // 250
        // only one can win, but refunds (200) must also be covered: max(250, 200)
        assertEq(treasury.totalReserved(), 250 * U);
    }

    function test_ReservationNeverBelowTotalStakesForRefunds() public {
        openMatch(1, flatOdds(101));
        bet(alice, 1, HOME, 100 * U);
        bet(bob, 1, AWAY, 100 * U);
        bet(bob, 1, DRAW, 100 * U);
        assertEq(treasury.totalReserved(), 300 * U);
    }

    function test_SettlementReleasesTheUnneededReserve() public {
        openMatch(1, flatOdds(250));
        uint256 a = bet(alice, 1, HOME, 100 * U);
        bet(bob, 1, AWAY, 100 * U);
        finish(1, 0, 0, 0);
        book.settleBook(1);
        assertEq(treasury.totalReserved(), 0);
        assertEq(book.claimable(a), 0);
        assertSolvent();
    }

    function test_AdminCannotWithdrawReservedFunds() public {
        openMatch(1, flatOdds(200));
        bet(alice, 1, HOME, 500 * U);
        uint256 free = treasury.freeBalance();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(OddraTreasury.ExceedsFree.selector, free, free + 1));
        treasury.withdraw(admin, free + 1);
        vm.prank(admin);
        treasury.withdraw(admin, free);
        assertEq(treasury.freeBalance(), 0);
        assertSolvent();
    }

    function test_RejectsBetTheTreasuryCannotCover() public {
        // drain the treasury down to a small free balance
        vm.prank(admin);
        treasury.withdraw(admin, 98_500 * U);
        openMatch(1, flatOdds(1000));
        vm.prank(alice);
        vm.expectRevert(); // payout 1,000 > 50% of 1,500 free
        book.placeBet(1, HOME, uint128(100 * U), 0);
        assertEq(treasury.totalReserved(), 0);
    }

    function test_StakeLimits() public {
        openMatch(1, flatOdds(200));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OddraRiskManager.StakeOutOfRange.selector, 501 * U));
        book.placeBet(1, HOME, uint128(501 * U), 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OddraRiskManager.StakeOutOfRange.selector, U / 2));
        book.placeBet(1, HOME, uint128(U / 2), 0);
    }

    function test_MatchLiabilityCap() public {
        OddraRiskManager.Limits memory l = defaultLimits();
        l.maxMatchLiability = uint128(1_000 * U);
        vm.prank(admin);
        risk.setLimits(l);
        openMatch(1, flatOdds(300));
        bet(alice, 1, HOME, 300 * U); // 900
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OddraRiskManager.MatchLiabilityTooHigh.selector, 1_200 * U));
        book.placeBet(1, OVER, uint128(100 * U), 0); // correlated with home: 900 + 300
        bet(bob, 1, AWAY, 100 * U); // exclusive with home: still 900 worst case
    }

    function test_CreatorFeesFlowIntoTreasury() public {
        usdg.mint(address(collector), 750 * U);
        uint256 before = treasury.balance();
        collector.forward();
        assertEq(treasury.balance() - before, 750 * U);
        assertEq(treasury.totalCreatorFees(), 750 * U);
        assertEq(collector.totalUsdgForwarded(), 750 * U);
    }

    function test_FeeConversionNeedsAnAdapter() public {
        vm.deal(address(collector), 1 ether);
        vm.prank(keeper);
        vm.expectRevert();
        collector.convert(1 ether, 1);
    }

    // ------------------------------------------------------------------ responsible gambling

    function test_SelfExclusionBlocksBetting() public {
        openMatch(1, flatOdds(200));
        vm.prank(alice);
        book.selfExclude(7 days);
        vm.prank(alice);
        vm.expectRevert();
        book.placeBet(1, HOME, uint128(10 * U), 0);
        vm.prank(alice);
        book.selfExclude(1 hours); // cannot shorten
        assertGt(book.excludedUntil(alice), block.timestamp + 6 days);
    }

    function test_DailyLimitLowersNowRaisesLater() public {
        openMatch(1, flatOdds(200));
        vm.prank(alice);
        book.setDailyLimit(uint128(20 * U));
        bet(alice, 1, HOME, 15 * U);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OddraBook.DailyLimitExceeded.selector, uint128(20 * U)));
        book.placeBet(1, HOME, uint128(10 * U), 0);
        vm.prank(alice);
        book.setDailyLimit(uint128(1_000 * U)); // raise: pending for 24h
        assertEq(book.dailyLimit(alice), 20 * U);
    }

    // ------------------------------------------------------------------ fuzzed solvency

    /// @notice Random bets on random selections, any valid result: the treasury stays solvent throughout, pays every
    ///         winner exactly stake × odds, and ends with nothing reserved.
    function testFuzz_SolventAcrossAnyBetsAndResult(uint256 seed, uint8 h, uint8 a) public {
        h = uint8(bound(h, 0, 6));
        a = uint8(bound(a, 0, 6));
        uint8 first = h + a == 0 ? 0 : (h == 0 ? 2 : a == 0 ? 1 : uint8(1 + (seed % 2)));
        uint32[30] memory o;
        for (uint256 i = 0; i < 30; i++) {
            o[i] = uint32(101 + (uint256(keccak256(abi.encode(seed, i))) % 3000));
        }
        openMatch(1, o);
        uint256 n = 12;
        uint256[] memory ids = new uint256[](n);
        uint256 placed;
        for (uint256 k = 0; k < n; k++) {
            uint256 r = uint256(keccak256(abi.encode(seed, "bet", k)));
            address who = k % 2 == 0 ? alice : bob;
            uint8 sel = uint8(r % 30);
            uint256 stake = (1 + (r >> 8) % 50) * U;
            vm.prank(who);
            try book.placeBet(1, sel, uint128(stake), 0) returns (uint256 id) {
                ids[placed++] = id;
            } catch {}
            assertSolvent();
        }
        finish(1, h, a, first);
        book.settleBook(1);
        assertSolvent();
        for (uint256 k = 0; k < placed; k++) {
            OddraBook.Bet memory b = book.getBet(ids[k]);
            uint256 due = book.claimable(ids[k]);
            if (due > 0) {
                assertEq(due, b.payout);
                uint256 before = usdg.balanceOf(b.bettor);
                book.claim(ids[k]);
                assertEq(usdg.balanceOf(b.bettor) - before, due);
            }
            assertSolvent();
        }
        assertEq(treasury.totalReserved(), 0);
    }
}
