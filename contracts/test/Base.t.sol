// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OddraBook} from "../src/OddraBook.sol";
import {OddraFeeCollector} from "../src/OddraFeeCollector.sol";
import {OddraMatchRegistry, NativeBlockSource, IBlockSource} from "../src/OddraMatchRegistry.sol";
import {OddraRiskManager} from "../src/OddraRiskManager.sol";
import {OddraTreasury} from "../src/OddraTreasury.sol";

/// @dev 6-decimal token whose transfers to a blocked address fail, to exercise failed payouts.
contract MockUSDG is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Mock USDG", "mUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}

abstract contract Base is Test {
    uint256 internal constant U = 1e6; // one USDG

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockUSDG internal usdg;
    OddraMatchRegistry internal registry;
    OddraTreasury internal treasury;
    OddraRiskManager internal risk;
    OddraBook internal book;
    OddraFeeCollector internal collector;

    bytes32 internal constant SEED = keccak256("server seed");
    bytes32 internal constant CONFIG = keccak256("config");
    bytes32 internal constant RULES = keccak256("oddra-sim/1.0.0");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        usdg = new MockUSDG();
        registry = new OddraMatchRegistry(admin, IBlockSource(address(new NativeBlockSource())));
        treasury = new OddraTreasury(admin, IERC20(address(usdg)));
        risk = new OddraRiskManager(admin, defaultLimits());
        book = new OddraBook(admin, IERC20(address(usdg)), registry, treasury, risk);
        collector = new OddraFeeCollector(admin, IERC20(address(usdg)), treasury);

        vm.startPrank(admin);
        registry.grantRole(registry.OPERATOR_ROLE(), operator);
        book.grantRole(book.OPERATOR_ROLE(), operator);
        book.grantRole(book.PAUSER_ROLE(), admin);
        treasury.grantRole(treasury.BOOK_ROLE(), address(book));
        treasury.grantRole(treasury.TREASURER_ROLE(), admin);
        risk.grantRole(risk.RISK_ROLE(), admin);
        collector.grantRole(collector.KEEPER_ROLE(), keeper);
        vm.stopPrank();

        // house liquidity
        usdg.mint(admin, 100_000 * U);
        vm.startPrank(admin);
        usdg.approve(address(treasury), type(uint256).max);
        treasury.contribute(100_000 * U, treasury.SOURCE_HOUSE());
        vm.stopPrank();

        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            usdg.mint(who, 10_000 * U);
            vm.prank(who);
            usdg.approve(address(book), type(uint256).max);
        }
    }

    function defaultLimits() internal pure returns (OddraRiskManager.Limits memory) {
        return OddraRiskManager.Limits({
            minStake: uint128(1 * U),
            maxStake: uint128(500 * U),
            maxPayout: uint128(20_000 * U),
            maxSelectionLiability: uint128(50_000 * U),
            maxMatchLiability: uint128(60_000 * U),
            minFreeReserve: uint128(1_000 * U),
            maxTotalLiabilityBps: 9_000,
            maxPayoutOfFreeBps: 5_000
        });
    }

    function flatOdds(uint32 o) internal pure returns (uint32[30] memory a) {
        for (uint256 i = 0; i < 30; i++) a[i] = o;
    }

    /// @dev Creates match `id` opening now (+1s) with a 300s window, and publishes odds.
    function openMatch(uint256 id, uint32[30] memory o) internal returns (uint64 openTime, uint64 kickoff) {
        openTime = uint64(block.timestamp + 1);
        kickoff = openTime + 300;
        vm.prank(operator);
        registry.createMatch(id, 1, 2, CONFIG, RULES, keccak256(abi.encodePacked(SEED)), openTime, kickoff);
        vm.prank(operator);
        book.publishOdds(id, o);
        vm.warp(openTime);
    }

    function bet(address who, uint256 id, uint8 sel, uint256 stake) internal returns (uint256) {
        vm.prank(who);
        return book.placeBet(id, sel, uint128(stake), 0);
    }

    /// @dev Locks, reveals and settles match `id` with the given result.
    function finish(uint256 id, uint8 h, uint8 a, uint8 first) internal {
        OddraMatchRegistry.Match memory m = registry.getMatch(id);
        vm.warp(m.kickoff);
        registry.lock(id);
        vm.roll(block.number + registry.ENTROPY_DELAY() + 1);
        vm.setBlockhash(registry.getMatch(id).entropyBlock, keccak256(abi.encode("entropy", id)));
        vm.prank(operator);
        registry.reveal(id, SEED);
        vm.warp(m.kickoff + registry.LIVE_DURATION());
        vm.prank(operator);
        registry.settle(id, h, a, first, keccak256("result"));
    }

    /// @dev Solvency: the treasury always holds at least everything it has reserved.
    function assertSolvent() internal view {
        assertGe(usdg.balanceOf(address(treasury)), treasury.totalReserved(), "treasury insolvent");
    }
}
