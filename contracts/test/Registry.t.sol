// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OddraMarkets} from "../src/OddraMarkets.sol";
import {OddraMatchRegistry} from "../src/OddraMatchRegistry.sol";
import {Base} from "./Base.t.sol";

contract RegistryTest is Base {
    function test_FullLifecycleAndFinalSeed() public {
        openMatch(1, flatOdds(200));
        finish(1, 2, 1, 1);
        OddraMatchRegistry.Match memory m = registry.getMatch(1);
        assertEq(uint8(m.status), uint8(OddraMatchRegistry.Status.Settled));
        assertEq(m.serverSeed, SEED);
        assertEq(m.finalSeed, keccak256(abi.encodePacked(SEED, m.entropy, uint256(1))));
        assertTrue(m.entropy != bytes32(0));
        assertEq(m.homeGoals, 2);
        assertEq(m.awayGoals, 1);
    }

    function test_CannotCommitAfterBettingOpened() public {
        vm.prank(operator);
        vm.expectRevert(OddraMatchRegistry.BadSchedule.selector);
        registry.createMatch(
            1,
            1,
            2,
            CONFIG,
            RULES,
            keccak256(abi.encodePacked(SEED)),
            uint64(block.timestamp - 1),
            uint64(block.timestamp + 300)
        );
    }

    function test_OnlyOperatorCreates() public {
        vm.expectRevert();
        registry.createMatch(
            1,
            1,
            2,
            CONFIG,
            RULES,
            keccak256(abi.encodePacked(SEED)),
            uint64(block.timestamp + 1),
            uint64(block.timestamp + 301)
        );
    }

    function test_NoDuplicateMatch() public {
        openMatch(1, flatOdds(200));
        vm.prank(operator);
        vm.expectRevert(OddraMatchRegistry.AlreadyExists.selector);
        registry.createMatch(
            1,
            3,
            4,
            CONFIG,
            RULES,
            keccak256(abi.encodePacked(SEED)),
            uint64(block.timestamp + 1),
            uint64(block.timestamp + 301)
        );
    }

    function test_LockOnlyAfterKickoff() public {
        openMatch(1, flatOdds(200));
        vm.expectRevert(OddraMatchRegistry.TooEarly.selector);
        registry.lock(1);
    }

    function test_RevealRejectsWrongSeed() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(200));
        vm.warp(kickoff);
        registry.lock(1);
        vm.roll(block.number + 10);
        vm.prank(operator);
        vm.expectRevert(OddraMatchRegistry.SeedMismatch.selector);
        registry.reveal(1, keccak256("a different seed"));
    }

    function test_RevealWaitsForEntropyBlock() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(200));
        vm.warp(kickoff);
        registry.lock(1);
        vm.prank(operator);
        vm.expectRevert(OddraMatchRegistry.TooEarly.selector);
        registry.reveal(1, SEED);
    }

    function test_ProposeOnlyAfterFullTimeAndOnce() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(200));
        vm.warp(kickoff);
        registry.lock(1);
        vm.roll(block.number + 10);
        vm.prank(operator);
        registry.reveal(1, SEED);
        vm.prank(operator);
        vm.expectRevert(OddraMatchRegistry.TooEarly.selector);
        registry.proposeResult(1, 1, 0, 1, keccak256("r"));
        vm.warp(kickoff + 900);
        vm.prank(operator);
        vm.expectRevert(OddraMarkets.InvalidResult.selector);
        registry.proposeResult(1, 1, 0, 2, keccak256("r"));
        vm.prank(operator);
        registry.proposeResult(1, 1, 0, 1, keccak256("r"));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(OddraMatchRegistry.BadStatus.selector, OddraMatchRegistry.Status.Proposed)
        );
        registry.proposeResult(1, 0, 1, 2, keccak256("r2"));
    }

    function test_AnyoneVoidsAfterMissedReveal() public {
        (, uint64 kickoff) = openMatch(1, flatOdds(200));
        vm.expectRevert();
        registry.voidMatch(1);
        vm.warp(kickoff + registry.REVEAL_WINDOW() + 1);
        vm.prank(bob);
        registry.voidMatch(1);
        assertEq(uint8(registry.status(1)), uint8(OddraMatchRegistry.Status.Voided));
    }

    function test_OperatorCannotVoidOnceBettingOpened() public {
        openMatch(1, flatOdds(200));
        vm.prank(operator);
        vm.expectRevert();
        registry.voidMatch(1);
    }
}
