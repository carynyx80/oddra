// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OddraBook} from "../src/OddraBook.sol";
import {OddraMatchRegistry} from "../src/OddraMatchRegistry.sol";
import {OddraRiskManager} from "../src/OddraRiskManager.sol";
import {OddraTreasury} from "../src/OddraTreasury.sol";
import {Base} from "./Base.t.sol";

/// @dev A bettor contract that can refuse ETH, to exercise failed ETH payouts.
contract Picky {
    bool public refuse;

    function setRefuse(bool r) external {
        refuse = r;
    }

    function bet(OddraBook book, uint256 id, uint8 sel) external payable returns (uint256) {
        return book.placeBetETH{value: msg.value}(id, sel, 0);
    }

    receive() external payable {
        require(!refuse, "no thanks");
    }
}

contract EthBettingTest is Base {
    function test_EthStakeGoesToTreasuryEthBook() public {
        openMatch(1, flatOdds(250));
        uint256 before = address(treasury).balance;
        uint256 id = betEth(alice, 1, 0, 0.1 ether);
        assertEq(address(treasury).balance - before, 0.1 ether);
        assertEq(address(book).balance, 0, "book never holds ETH");
        OddraBook.Bet memory b = book.getBet(id);
        assertEq(b.asset, ETH);
        assertEq(b.stake, 0.1 ether);
        assertEq(b.payout, 0.25 ether);
        assertEq(treasury.totalStakes(ETH), 0.1 ether);
        assertEq(treasury.totalStakes(address(usdg)), 0);
    }

    function test_EthWinnerPaidInEthUsdgLoserUntouched() public {
        openMatch(1, flatOdds(200));
        uint256 e = betEth(alice, 1, 0, 0.5 ether); // home
        uint256 u = bet(bob, 1, 2, 50 * U); // away
        finish(1, 2, 0, 1);
        uint256 a0 = alice.balance;
        book.claim(e);
        assertEq(alice.balance - a0, 1 ether);
        assertEq(book.claimable(u), 0);
        assertEq(treasury.totalReserved(ETH), 0);
        assertEq(treasury.totalReserved(address(usdg)), 0);
        assertSolvent();
    }

    function test_AssetsReserveSeparately() public {
        openMatch(1, flatOdds(300));
        betEth(alice, 1, 0, 0.2 ether);
        bet(bob, 1, 0, 100 * U);
        assertEq(treasury.totalReserved(ETH), 0.6 ether);
        assertEq(treasury.totalReserved(address(usdg)), 300 * U);
    }

    function test_EthLimitsAreIndependent() public {
        openMatch(1, flatOdds(200));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OddraRiskManager.StakeOutOfRange.selector, 2 ether));
        book.placeBetETH{value: 2 ether}(1, 0, 0);
        vm.prank(alice);
        vm.expectRevert(OddraBook.BadStake.selector);
        book.placeBetETH{value: 0}(1, 0, 0);
    }

    function test_EthVoidRefunds() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(400));
        uint256 id = betEth(alice, 1, 5, 0.3 ether);
        vm.warp(kickoff + registry.REVEAL_WINDOW() + 1);
        registry.voidMatch(1);
        uint256 a0 = alice.balance;
        book.claim(id);
        assertEq(alice.balance - a0, 0.3 ether);
        assertEq(treasury.totalReserved(ETH), 0);
    }

    function test_FailedEthPayoutStaysClaimable() public {
        Picky p = new Picky();
        vm.deal(address(p), 1 ether);
        openMatch(1, flatOdds(200));
        uint256 id = p.bet{value: 0.1 ether}(book, 1, 0);
        finish(1, 1, 0, 1);
        p.setRefuse(true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        assertEq(book.payoutBatch(ids), 0);
        assertEq(uint8(book.betStatus(id)), uint8(OddraBook.BetStatus.Won));
        assertSolvent();
        p.setRefuse(false);
        book.claim(id);
        assertEq(uint8(book.betStatus(id)), uint8(OddraBook.BetStatus.Paid));
        assertEq(treasury.totalReserved(ETH), 0);
    }

    function test_TreasuryRefusesUntrackedEth() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = address(treasury).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_AdminCannotWithdrawReservedEth() public {
        openMatch(1, flatOdds(500));
        betEth(alice, 1, 0, 1 ether);
        uint256 free = treasury.freeBalance(ETH);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(OddraTreasury.ExceedsFree.selector, ETH, free, free + 1));
        treasury.withdraw(ETH, admin, free + 1);
    }

    function test_EthCreatorFeesForwardedAsEth() public {
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(collector).call{value: 2 ether}("");
        assertTrue(ok);
        uint256 before = treasury.balance(ETH);
        collector.forwardETH();
        assertEq(treasury.balance(ETH) - before, 2 ether);
        assertEq(treasury.totalCreatorFees(ETH), 2 ether);
    }

    function test_EthDailyLimitSeparateFromUsdg() public {
        openMatch(1, flatOdds(200));
        vm.prank(alice);
        book.setDailyLimit(ETH, 0.1 ether);
        betEth(alice, 1, 0, 0.1 ether);
        bet(alice, 1, 0, 100 * U); // USDG unaffected
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OddraBook.DailyLimitExceeded.selector, uint128(0.1 ether)));
        book.placeBetETH{value: 0.01 ether}(1, 0, 0);
    }

    /// @notice Random ETH and USDG bets, any result: both asset books stay solvent and end fully released.
    function testFuzz_MixedAssetSolvency(uint256 seed, uint8 h, uint8 a) public {
        h = uint8(bound(h, 0, 5));
        a = uint8(bound(a, 0, 5));
        uint8 first = h + a == 0 ? 0 : (h == 0 ? 2 : a == 0 ? 1 : uint8(1 + (seed % 2)));
        uint32[30] memory o;
        for (uint256 i = 0; i < 30; i++) {
            o[i] = uint32(101 + (uint256(keccak256(abi.encode(seed, i))) % 2000));
        }
        openMatch(1, o);
        uint256[] memory ids = new uint256[](10);
        uint256 n;
        for (uint256 k = 0; k < 10; k++) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            address who = k % 2 == 0 ? alice : bob;
            uint8 sel = uint8(r % 30);
            if ((r >> 40) % 2 == 0) {
                vm.prank(who);
                try book.placeBetETH{value: 0.001 ether * (1 + (r >> 8) % 50)}(1, sel, 0) returns (uint256 id) {
                    ids[n++] = id;
                } catch {}
            } else {
                vm.prank(who);
                try book.placeBet(1, sel, uint128((1 + (r >> 8) % 50) * U), 0) returns (uint256 id) {
                    ids[n++] = id;
                } catch {}
            }
            assertSolvent();
        }
        finish(1, h, a, first);
        book.settleBook(1); // what the keeper does at full time, even when nobody won
        assertSolvent();
        for (uint256 k = 0; k < n; k++) {
            if (book.claimable(ids[k]) > 0) book.claim(ids[k]);
            assertSolvent();
        }
        assertEq(treasury.totalReserved(ETH), 0);
        assertEq(treasury.totalReserved(address(usdg)), 0);
    }
}

contract DisputeTest is Base {
    address internal watcher = makeAddr("watcher");

    function setUp() public override {
        super.setUp();
        vm.deal(watcher, 1 ether);
    }

    function test_ResultIsNotFinalDuringWindow() public {
        openMatch(1, flatOdds(200));
        uint256 id = bet(alice, 1, 0, 10 * U);
        propose(1, 1, 0, 1);
        vm.expectRevert(OddraMatchRegistry.TooEarly.selector);
        registry.finalize(1);
        vm.expectRevert(OddraBook.NotSettled.selector);
        book.claim(id);
        vm.warp(block.timestamp + registry.disputeWindow());
        registry.finalize(1);
        book.claim(id);
    }

    function test_UpheldDisputeForfeitsBondToTreasury() public {
        openMatch(1, flatOdds(200));
        propose(1, 1, 0, 1);
        uint256 t0 = treasury.balance(ETH);
        vm.prank(watcher);
        registry.dispute{value: 0.005 ether}(1);
        vm.prank(arbiter);
        registry.resolveDispute(1, 1, 0, 1, keccak256("result"));
        assertEq(uint8(registry.status(1)), uint8(OddraMatchRegistry.Status.Settled));
        assertEq(treasury.balance(ETH) - t0, 0.005 ether);
        assertEq(watcher.balance, 1 ether - 0.005 ether);
    }

    function test_OverturnedResultPaysTheCorrectWinnersAndRefundsBond() public {
        openMatch(1, flatOdds(200));
        uint256 home = bet(alice, 1, 0, 10 * U);
        uint256 away = bet(bob, 1, 2, 10 * U);
        propose(1, 1, 0, 1); // operator claims a home win
        vm.prank(watcher);
        registry.dispute{value: 0.005 ether}(1);
        vm.prank(arbiter);
        registry.resolveDispute(1, 0, 2, 2, keccak256("true result")); // replay says away won
        assertEq(watcher.balance, 1 ether, "bond returned");
        book.settleBook(1);
        assertEq(book.claimable(home), 0);
        assertEq(book.claimable(away), 20 * U);
    }

    function test_DisputeRules() public {
        openMatch(1, flatOdds(200));
        propose(1, 1, 0, 1);
        vm.prank(watcher);
        vm.expectRevert(OddraMatchRegistry.BadBond.selector);
        registry.dispute{value: 0.001 ether}(1);
        vm.prank(operator);
        vm.expectRevert(); // only the arbiter rules
        registry.resolveDispute(1, 1, 0, 1, keccak256("result"));
        vm.warp(block.timestamp + registry.disputeWindow());
        vm.prank(watcher);
        vm.expectRevert(OddraMatchRegistry.TooLate.selector);
        registry.dispute{value: 0.005 ether}(1);
    }

    function test_UnresolvedDisputeVoidsAndRefundsEveryone() public {
        openMatch(1, flatOdds(300));
        uint256 id = betEth(alice, 1, 0, 0.2 ether);
        propose(1, 1, 0, 1);
        vm.prank(watcher);
        registry.dispute{value: 0.005 ether}(1);
        vm.expectRevert();
        registry.voidMatch(1);
        vm.warp(block.timestamp + registry.ARBITRATION_WINDOW() + 1);
        registry.voidMatch(1);
        assertEq(watcher.balance, 1 ether, "bond returned");
        uint256 a0 = alice.balance;
        book.claim(id);
        assertEq(alice.balance - a0, 0.2 ether);
    }

    function test_ForfeitedBondGoesToAPlainWalletSink() public {
        vm.prank(admin);
        registry.setDisputeParams(10 minutes, 0.005 ether, admin); // exchange mode: no treasury
        openMatch(1, flatOdds(200));
        propose(1, 1, 0, 1);
        uint256 a0 = admin.balance;
        vm.prank(watcher);
        registry.dispute{value: 0.005 ether}(1);
        vm.prank(arbiter);
        registry.resolveDispute(1, 1, 0, 1, keccak256("result"));
        assertEq(admin.balance - a0, 0.005 ether);
    }

    function test_OnlyAdminSetsDisputeParamsWithinBounds() public {
        vm.prank(operator);
        vm.expectRevert();
        registry.setDisputeParams(5 minutes, 0.01 ether, address(treasury));
        vm.prank(admin);
        vm.expectRevert(OddraMatchRegistry.BadParams.selector);
        registry.setDisputeParams(30 seconds, 0.01 ether, address(treasury));
    }
}
