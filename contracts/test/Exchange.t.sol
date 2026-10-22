// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OddraExchange} from "../src/OddraExchange.sol";
import {Base} from "./Base.t.sol";

contract EthRefuser {
    bool public refuse;

    function setRefuse(bool r) external {
        refuse = r;
    }

    function offer(OddraExchange x, uint256 id, uint8 sel, uint32 odds, uint128 amount)
        external
        payable
        returns (uint256)
    {
        return x.placeOffer{value: msg.value}(id, sel, OddraExchange.Side.Back, odds, amount, address(0));
    }

    receive() external payable {
        require(!refuse, "no");
    }
}

contract ExchangeTest is Base {
    OddraExchange internal x;
    address internal carol = makeAddr("carol");
    OddraExchange.Side internal constant BACK = OddraExchange.Side.Back;
    OddraExchange.Side internal constant LAY = OddraExchange.Side.Lay;

    function setUp() public override {
        super.setUp();
        x = new OddraExchange(admin, IERC20(address(usdg)), registry, uint128(1 * U), 0.0001 ether);
        vm.startPrank(admin);
        x.grantRole(x.OPERATOR_ROLE(), operator);
        x.grantRole(x.TREASURER_ROLE(), admin);
        x.grantRole(x.PAUSER_ROLE(), admin);
        vm.stopPrank();
        address[3] memory who = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            usdg.mint(who[i], 10_000 * U);
            vm.prank(who[i]);
            usdg.approve(address(x), type(uint256).max);
            vm.deal(who[i], 10 ether);
        }
    }

    function open1() internal {
        openMatch(1, flatOdds(200));
    }

    function lay(address who, uint8 sel, uint32 odds, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return x.placeOffer(1, sel, LAY, odds, uint128(amount), address(usdg));
    }

    function back(address who, uint8 sel, uint32 odds, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return x.placeOffer(1, sel, BACK, odds, uint128(amount), address(usdg));
    }

    function take(address who, uint256 offerId, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return x.take(offerId, uint128(amount));
    }

    /// @dev Everything the exchange holds is owed to someone: user escrow plus commission.
    function assertBacked() internal view {
        assertEq(usdg.balanceOf(address(x)), x.totalEscrowed(address(usdg)) + x.accruedFees(address(usdg)), "USDG");
        assertEq(address(x).balance, x.totalEscrowed(ETH) + x.accruedFees(ETH), "ETH");
    }

    // ------------------------------------------------------------------ making

    function test_LayOfferEscrowsLiabilityBackOfferEscrowsStake() public {
        open1();
        uint256 a0 = usdg.balanceOf(alice);
        lay(alice, 0, 250, 100 * U); // laying 100 at 2.50 risks 150
        assertEq(a0 - usdg.balanceOf(alice), 150 * U);
        uint256 b0 = usdg.balanceOf(bob);
        back(bob, 0, 250, 40 * U);
        assertEq(b0 - usdg.balanceOf(bob), 40 * U);
        assertBacked();
    }

    function test_NoOffersOutsideTheBettingWindow() public {
        uint64 openTime = uint64(block.timestamp + 100);
        vm.prank(operator);
        registry.createMatch(1, 1, 2, CONFIG, RULES, keccak256(abi.encodePacked(SEED)), openTime, openTime + 300);
        vm.prank(alice);
        vm.expectRevert(OddraExchange.MarketClosed.selector);
        x.placeOffer(1, 0, LAY, 200, uint128(10 * U), address(usdg));
    }

    function test_RejectsBadOffers() public {
        open1();
        vm.startPrank(alice);
        vm.expectRevert(OddraExchange.BadOdds.selector);
        x.placeOffer(1, 0, LAY, 100, uint128(10 * U), address(usdg));
        vm.expectRevert(OddraExchange.BadSelection.selector);
        x.placeOffer(1, 30, LAY, 200, uint128(10 * U), address(usdg));
        vm.expectRevert(OddraExchange.BadAmount.selector);
        x.placeOffer(1, 0, LAY, 200, uint128(U / 2), address(usdg));
        vm.expectRevert(OddraExchange.UnsupportedAsset.selector);
        x.placeOffer(1, 0, LAY, 200, uint128(10 * U), address(0xBEEF));
        vm.expectRevert(OddraExchange.BadValue.selector);
        x.placeOffer{value: 1 ether}(1, 0, BACK, 200, 0.5 ether, ETH);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ taking and settling

    function test_BackerWinsPotMinusCommissionOnWinnings() public {
        open1();
        uint256 off = lay(alice, 0, 300, 50 * U); // alice lays home at 3.00: liability 100
        uint256 pos = take(bob, off, 50 * U); // bob backs home with 50
        OddraExchange.Position memory p = x.getPosition(pos);
        assertEq(p.backer, bob);
        assertEq(p.layer, alice);
        assertEq(p.stake, 50 * U);
        assertEq(p.liability, 100 * U);
        finish(1, 2, 1, 1); // home wins
        uint256 b0 = usdg.balanceOf(bob);
        x.claim(pos, bob);
        assertEq(usdg.balanceOf(bob) - b0, 150 * U - 2 * U); // 2% of 100 winnings
        vm.expectRevert(OddraExchange.NothingToClaim.selector);
        x.claim(pos, alice);
        vm.expectRevert(OddraExchange.NothingToClaim.selector);
        x.claim(pos, bob);
        assertEq(x.accruedFees(address(usdg)), 2 * U);
        assertBacked();
    }

    function test_LayerWinsPotMinusCommissionOnStake() public {
        open1();
        uint256 off = back(alice, 0, 400, 25 * U); // alice backs home at 4.00 with 25
        uint256 pos = take(bob, off, 25 * U); // bob lays: liability 75
        finish(1, 0, 1, 2); // away wins
        uint256 b0 = usdg.balanceOf(bob);
        vm.prank(carol); // anyone may trigger; bob receives
        x.claim(pos, bob);
        assertEq(usdg.balanceOf(bob) - b0, 100 * U - (25 * U * 2) / 100);
        assertBacked();
    }

    function test_PartialFillsAddUpAndRoundingNeverOverdrawsEscrow() public {
        open1();
        uint256 off = lay(alice, 3, 333, 10 * U + 1); // awkward numbers
        uint256 p1 = take(bob, off, 3 * U + 7);
        uint256 p2 = take(carol, off, 3 * U + 3);
        OddraExchange.Offer memory o = x.getOffer(off);
        uint256 p3 = take(bob, off, o.remaining);
        o = x.getOffer(off);
        assertEq(o.remaining, 0);
        assertEq(o.escrow, 0);
        uint256 liab = x.getPosition(p1).liability + x.getPosition(p2).liability + x.getPosition(p3).liability;
        assertEq(liab, x.liabilityFor(10 * U + 1, 333), "liabilities sum to the maker's escrow");
        assertBacked();
    }

    function test_DustPartialFillRejectedButFinalFillAllowed() public {
        open1();
        uint256 off = lay(alice, 0, 200, 2 * U);
        vm.prank(bob);
        vm.expectRevert(OddraExchange.BadAmount.selector);
        x.take(off, uint128(U / 2));
        take(bob, off, 1 * U + U / 2);
        take(carol, off, U / 2); // the last half unit is allowed
    }

    function test_NoSelfMatchNoTakeAfterKickoffNoOverfill() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(200));
        uint256 off = lay(alice, 0, 200, 10 * U);
        vm.prank(alice);
        vm.expectRevert(OddraExchange.SelfMatch.selector);
        x.take(off, uint128(5 * U));
        vm.prank(bob);
        vm.expectRevert(OddraExchange.BadAmount.selector);
        x.take(off, uint128(11 * U));
        vm.warp(kickoff);
        vm.prank(bob);
        vm.expectRevert(OddraExchange.MarketClosed.selector);
        x.take(off, uint128(5 * U));
    }

    function test_VoidRefundsBothSides() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(200));
        uint256 pos = take(bob, lay(alice, 0, 300, 10 * U), 10 * U);
        vm.warp(kickoff + registry.REVEAL_WINDOW() + 1);
        registry.voidMatch(1);
        uint256 a0 = usdg.balanceOf(alice);
        uint256 b0 = usdg.balanceOf(bob);
        uint256[] memory ids = new uint256[](1);
        ids[0] = pos;
        assertEq(x.payoutBatch(ids), 2);
        assertEq(usdg.balanceOf(alice) - a0, 20 * U);
        assertEq(usdg.balanceOf(bob) - b0, 10 * U);
        assertEq(x.accruedFees(address(usdg)), 0, "no commission on voids");
        assertBacked();
    }

    function test_NothingPaysBeforeTheResultIsFinal() public {
        open1();
        uint256 pos = take(bob, lay(alice, 0, 200, 10 * U), 10 * U);
        propose(1, 1, 0, 1); // proposed, still in the dispute window
        vm.expectRevert(OddraExchange.NothingToClaim.selector);
        x.claim(pos, bob);
        vm.warp(block.timestamp + registry.disputeWindow());
        registry.finalize(1);
        x.claim(pos, bob);
    }

    // ------------------------------------------------------------------ unmatched funds

    function test_MakerCancelsUnmatchedPart() public {
        open1();
        uint256 off = lay(alice, 0, 300, 100 * U); // escrow 200
        take(bob, off, 40 * U); // matched liability 80
        uint256 a0 = usdg.balanceOf(alice);
        vm.prank(bob);
        vm.expectRevert(OddraExchange.NotMaker.selector);
        x.cancel(off);
        vm.prank(alice);
        x.cancel(off);
        assertEq(usdg.balanceOf(alice) - a0, 120 * U);
        assertBacked();
    }

    function test_UnmatchedOffersReturnedAfterKickoff() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(200));
        uint256 o1 = lay(alice, 0, 300, 10 * U);
        uint256 o2 = back(bob, 1, 250, 7 * U);
        uint256[] memory ids = new uint256[](2);
        ids[0] = o1;
        ids[1] = o2;
        assertEq(x.reclaimBatch(ids), 0, "still open");
        vm.warp(kickoff);
        uint256 a0 = usdg.balanceOf(alice);
        uint256 b0 = usdg.balanceOf(bob);
        assertEq(x.reclaimBatch(ids), 2);
        assertEq(usdg.balanceOf(alice) - a0, 20 * U);
        assertEq(usdg.balanceOf(bob) - b0, 7 * U);
        assertEq(x.totalEscrowed(address(usdg)), 0);
    }

    // ------------------------------------------------------------------ ETH

    function test_EthOffersAndTakeMany() public {
        open1();
        vm.prank(alice);
        uint256 o1 = x.placeOffer{value: 0.2 ether}(1, 0, LAY, 300, 0.1 ether, ETH); // liability 0.2
        vm.prank(carol);
        uint256 o2 = x.placeOffer{value: 0.05 ether}(1, 0, LAY, 350, 0.02 ether, ETH);
        uint256[] memory ids = new uint256[](2);
        ids[0] = o1;
        ids[1] = o2;
        uint128[] memory amts = new uint128[](2);
        amts[0] = 0.1 ether;
        amts[1] = 0.02 ether;
        vm.prank(bob);
        uint256[] memory pos = x.takeMany{value: 0.12 ether}(ids, amts);
        finish(1, 1, 0, 1);
        uint256 b0 = bob.balance;
        x.payoutBatch(pos);
        uint256 won =
            (0.1 ether + 0.2 ether - (0.2 ether * 2) / 100) + (0.02 ether + 0.05 ether - (0.05 ether * 2) / 100);
        assertEq(bob.balance - b0, won);
        assertBacked();
    }

    function test_TakeManyRequiresExactEthValue() public {
        open1();
        vm.prank(alice);
        uint256 o1 = x.placeOffer{value: 0.1 ether}(1, 0, LAY, 200, 0.1 ether, ETH);
        uint256[] memory ids = new uint256[](1);
        ids[0] = o1;
        uint128[] memory amts = new uint128[](1);
        amts[0] = 0.1 ether;
        vm.prank(bob);
        vm.expectRevert(OddraExchange.BadValue.selector);
        x.takeMany{value: 0.2 ether}(ids, amts);
    }

    function test_FailedEthPayoutStaysClaimable() public {
        EthRefuser r = new EthRefuser();
        vm.deal(address(r), 1 ether);
        open1();
        uint256 off = r.offer{value: 0.1 ether}(x, 1, 0, 200, 0.1 ether); // r backs home with 0.1
        vm.prank(bob);
        uint256 pos = x.take{value: 0.1 ether}(off, 0.1 ether); // bob lays
        finish(1, 1, 0, 1); // home wins: r is owed
        r.setRefuse(true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = pos;
        assertEq(x.payoutBatch(ids), 0);
        assertBacked();
        r.setRefuse(false);
        x.claim(pos, address(r));
        assertEq(x.totalEscrowed(ETH), 0);
        assertBacked();
    }

    // ------------------------------------------------------------------ admin limits

    function test_TreasurerCanOnlyWithdrawCommission() public {
        open1();
        uint256 pos = take(bob, lay(alice, 0, 300, 50 * U), 50 * U);
        lay(carol, 1, 200, 500 * U); // unmatched escrow stays untouched
        finish(1, 1, 0, 1);
        x.claim(pos, bob);
        uint256 fees = x.accruedFees(address(usdg));
        vm.prank(admin);
        x.withdrawFees(address(usdg), admin);
        assertEq(usdg.balanceOf(admin), fees);
        assertEq(x.accruedFees(address(usdg)), 0);
        assertBacked();
        vm.prank(admin);
        vm.expectRevert();
        x.setCommission(600);
    }

    function test_SelfExclusionAndDailyLimitApplyToMakersAndTakers() public {
        open1();
        uint256 off = lay(alice, 0, 200, 100 * U);
        vm.prank(bob);
        x.setDailyLimit(address(usdg), uint128(30 * U));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OddraExchange.DailyLimitExceeded.selector, uint128(30 * U)));
        x.take(off, uint128(40 * U));
        vm.prank(carol);
        x.selfExclude(1 days);
        vm.prank(carol);
        vm.expectRevert();
        x.take(off, uint128(10 * U));
    }

    /// @notice Random offers and fills in both assets, any result, then every claim and reclaim: the exchange ends
    ///         holding exactly its commission, so every unit of user escrow was paid out or returned.
    function testFuzz_AllEscrowReturned(uint256 seed, uint8 h, uint8 a) public {
        h = uint8(bound(h, 0, 4));
        a = uint8(bound(a, 0, 4));
        uint8 first = h + a == 0 ? 0 : (h == 0 ? 2 : a == 0 ? 1 : uint8(1 + (seed % 2)));
        open1();
        address[3] memory who = [alice, bob, carol];
        uint256[] memory offers = new uint256[](8);
        uint256[] memory positions = new uint256[](16);
        uint256 nPos;
        for (uint256 k = 0; k < 8; k++) {
            uint256 r = uint256(keccak256(abi.encode(seed, k)));
            address maker = who[r % 3];
            bool eth = (r >> 8) % 2 == 0;
            OddraExchange.Side side = (r >> 9) % 2 == 0 ? BACK : LAY;
            uint32 odds = uint32(101 + (r >> 16) % 900);
            uint128 amount =
                eth ? uint128(0.001 ether * (1 + (r >> 32) % 20)) : uint128(U * (1 + (r >> 32) % 50) + (r >> 48) % 997);
            uint8 sel = uint8((r >> 64) % 30);
            uint256 value = eth ? (side == LAY ? x.liabilityFor(amount, odds) : amount) : 0;
            vm.prank(maker);
            offers[k] = x.placeOffer{value: value}(1, sel, side, odds, amount, eth ? ETH : address(usdg));
            // up to two takers fill parts of it
            for (uint256 j = 0; j < 2; j++) {
                OddraExchange.Offer memory o = x.getOffer(offers[k]);
                if (o.remaining == 0) break;
                address taker = who[(r >> (80 + j)) % 3];
                if (taker == maker) continue;
                uint128 amt = j == 1 ? o.remaining : o.remaining / 2;
                if (amt < x.minAmount(o.asset) && amt != o.remaining) amt = o.remaining;
                uint256 due = eth ? (side == LAY ? amt : x.liabilityFor(amt, odds)) : 0;
                vm.prank(taker);
                positions[nPos++] = x.take{value: due}(offers[k], amt);
            }
            assertBacked();
        }
        finish(1, h, a, first);
        for (uint256 k = 0; k < 8; k++) {
            if (!x.getOffer(offers[k]).closed) x.cancel(offers[k]);
        }
        uint256[] memory ids = new uint256[](nPos);
        for (uint256 i = 0; i < nPos; i++) {
            ids[i] = positions[i];
        }
        x.payoutBatch(ids);
        assertEq(x.totalEscrowed(address(usdg)), 0, "USDG escrow left");
        assertEq(x.totalEscrowed(ETH), 0, "ETH escrow left");
        assertBacked();
    }
}
