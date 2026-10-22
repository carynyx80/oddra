// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OddraBook} from "../src/OddraBook.sol";
import {OddraFeeCollector} from "../src/OddraFeeCollector.sol";
import {OddraMatchRegistry, NativeBlockSource, IBlockSource} from "../src/OddraMatchRegistry.sol";
import {OddraRiskManager} from "../src/OddraRiskManager.sol";
import {OddraTreasury} from "../src/OddraTreasury.sol";
import {OddraTestUSDG} from "../src/testnet/OddraTestUSDG.sol";
import {ForkTestBlockSource} from "../src/testnet/ForkTestBlockSource.sol";

/// @notice Deploys Oddra to Robinhood Chain mainnet (4663), testnet (46630) or a local anvil (31337).
///
/// Env:
///   DEPLOYER_PRIVATE_KEY           deployer; becomes admin unless ADMIN_ADDRESS is set (use a multisig on mainnet)
///   ADMIN_ADDRESS                  holder of every admin role (default: deployer)
///   OPERATOR_ADDRESS / KEEPER_ADDRESS  worker keys (default: deployer)
///   ARBITER_ADDRESS                rules on disputed results; required on mainnet and must differ from the operator
///   USDG_ADDRESS                   empty on testnet/anvil = deploy the no-value test token. On mainnet it must be
///                                  Paxos USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 (checked).
///   TREASURY_SEED_USDG             whole test USDG minted into the treasury (test token only, default 250000)
///   TREASURY_SEED_ETH_WEI          ETH the deployer contributes to the treasury's ETH book (default 0)
///   BLOCK_SOURCE=native|fork       block.number/blockhash, or a test-only deterministic source, instead of ArbSys
///                                  (local and mainnet-fork tests only; refused on mainnet)
///   MAINNET_FORK=true              apply every mainnet rule on a local fork of mainnet (tests only)
contract Deploy is Script {
    address constant ARBSYS = address(0x64);
    address constant MAINNET_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 constant MAINNET = 4663;

    struct Cfg {
        uint256 pk;
        address deployer;
        address admin;
        address operator;
        address keeper;
        address arbiter;
        address usdg;
        bool testToken;
        uint256 seedUsdg;
        uint256 seedEth;
    }

    function run() external {
        require(block.chainid == MAINNET || block.chainid == 46630 || block.chainid == 31337, "unsupported chain");
        Cfg memory c = _config();

        vm.startBroadcast(c.pk);
        if (c.testToken) c.usdg = address(new OddraTestUSDG());
        IERC20 usdg = IERC20(c.usdg);

        string memory bs = vm.envOr("BLOCK_SOURCE", string(""));
        IBlockSource blocks;
        if (keccak256(bytes(bs)) == keccak256("fork")) {
            blocks = IBlockSource(address(new ForkTestBlockSource()));
        } else if (block.chainid == 31337 || keccak256(bytes(bs)) == keccak256("native")) {
            blocks = IBlockSource(address(new NativeBlockSource()));
        } else {
            blocks = IBlockSource(ARBSYS);
        }
        require(block.chainid != MAINNET || address(blocks) == ARBSYS, "mainnet must use ArbSys");

        // the deployer administers during setup, then hands every admin role to ADMIN_ADDRESS
        OddraMatchRegistry registry = new OddraMatchRegistry(c.deployer, blocks);
        OddraTreasury treasury = new OddraTreasury(c.deployer, usdg);
        OddraRiskManager risk = new OddraRiskManager(c.deployer, _assets(c.usdg), _limits(_mainnet()));
        OddraBook book = new OddraBook(c.deployer, usdg, registry, treasury, risk);
        OddraFeeCollector collector = new OddraFeeCollector(c.deployer, usdg, treasury);

        registry.grantRole(registry.OPERATOR_ROLE(), c.operator);
        registry.grantRole(registry.ARBITER_ROLE(), c.arbiter);
        registry.setDisputeParams(10 minutes, 0.005 ether, address(treasury));
        book.grantRole(book.OPERATOR_ROLE(), c.operator);
        book.grantRole(book.PAUSER_ROLE(), c.admin);
        treasury.grantRole(treasury.BOOK_ROLE(), address(book));
        treasury.grantRole(treasury.TREASURER_ROLE(), c.admin);
        risk.grantRole(risk.RISK_ROLE(), c.admin);
        collector.grantRole(collector.KEEPER_ROLE(), c.keeper);

        if (c.testToken && c.seedUsdg > 0) {
            OddraTestUSDG(c.usdg).mint(c.deployer, c.seedUsdg * 1e6);
            usdg.approve(address(treasury), c.seedUsdg * 1e6);
            treasury.contribute(c.usdg, c.seedUsdg * 1e6, treasury.SOURCE_HOUSE());
        }
        if (c.seedEth > 0) treasury.contribute{value: c.seedEth}(address(0), c.seedEth, treasury.SOURCE_HOUSE());

        if (c.admin != c.deployer) {
            // AccessControlDefaultAdminRules: the new admin accepts after the 1-day delay
            registry.beginDefaultAdminTransfer(c.admin);
            treasury.beginDefaultAdminTransfer(c.admin);
            risk.beginDefaultAdminTransfer(c.admin);
            book.beginDefaultAdminTransfer(c.admin);
            collector.beginDefaultAdminTransfer(c.admin);
        }
        vm.stopBroadcast();

        _write(c, registry, treasury, risk, book, collector);
    }

    function _config() internal view returns (Cfg memory c) {
        c.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.deployer = vm.addr(c.pk);
        c.admin = vm.envOr("ADMIN_ADDRESS", c.deployer);
        c.operator = vm.envOr("OPERATOR_ADDRESS", c.deployer);
        c.keeper = vm.envOr("KEEPER_ADDRESS", c.deployer);
        c.arbiter = vm.envOr("ARBITER_ADDRESS", c.deployer);
        c.usdg = vm.envOr("USDG_ADDRESS", address(0));
        c.testToken = c.usdg == address(0);
        c.seedUsdg = vm.envOr("TREASURY_SEED_USDG", uint256(250_000));
        c.seedEth = vm.envOr("TREASURY_SEED_ETH_WEI", uint256(0));
        if (_mainnet()) {
            require(c.usdg == MAINNET_USDG, "mainnet must use Paxos USDG");
            require(c.arbiter != c.operator, "arbiter must differ from operator");
        }
    }

    function _mainnet() internal view returns (bool) {
        return block.chainid == MAINNET || vm.envOr("MAINNET_FORK", false);
    }

    function _assets(address usdg) internal pure returns (address[] memory a) {
        a = new address[](2);
        a[0] = usdg;
        a[1] = address(0);
    }

    /// @dev Launch limits. Mainnet starts small; raise them with RiskManager.setLimits as liquidity grows.
    function _limits(bool mainnet) internal pure returns (OddraRiskManager.Limits[] memory l) {
        l = new OddraRiskManager.Limits[](2);
        l[0] = mainnet
            ? OddraRiskManager.Limits({
                minStake: 1e6,
                maxStake: 100e6,
                maxPayout: 2_000e6,
                maxSelectionLiability: 5_000e6,
                maxMatchLiability: 10_000e6,
                minFreeReserve: 500e6,
                maxTotalLiabilityBps: 8_000,
                maxPayoutOfFreeBps: 1_000
            })
            : OddraRiskManager.Limits({
                minStake: 1e6,
                maxStake: 500e6,
                maxPayout: 10_000e6,
                maxSelectionLiability: 25_000e6,
                maxMatchLiability: 50_000e6,
                minFreeReserve: 5_000e6,
                maxTotalLiabilityBps: 8_000,
                maxPayoutOfFreeBps: 1_000
            });
        l[1] = mainnet
            ? OddraRiskManager.Limits({
                minStake: 0.0003 ether,
                maxStake: 0.03 ether,
                maxPayout: 0.6 ether,
                maxSelectionLiability: 1.5 ether,
                maxMatchLiability: 3 ether,
                minFreeReserve: 0.15 ether,
                maxTotalLiabilityBps: 8_000,
                maxPayoutOfFreeBps: 1_000
            })
            : OddraRiskManager.Limits({
                minStake: 0.00001 ether,
                maxStake: 0.01 ether,
                maxPayout: 0.2 ether,
                maxSelectionLiability: 0.5 ether,
                maxMatchLiability: 1 ether,
                minFreeReserve: 0.001 ether,
                maxTotalLiabilityBps: 8_000,
                maxPayoutOfFreeBps: 2_000
            });
    }

    function _write(
        Cfg memory c,
        OddraMatchRegistry registry,
        OddraTreasury treasury,
        OddraRiskManager risk,
        OddraBook book,
        OddraFeeCollector collector
    ) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeBool(k, "testToken", c.testToken);
        vm.serializeAddress(k, "usdg", c.usdg);
        vm.serializeAddress(k, "registry", address(registry));
        vm.serializeAddress(k, "treasury", address(treasury));
        vm.serializeAddress(k, "risk", address(risk));
        vm.serializeAddress(k, "book", address(book));
        vm.serializeAddress(k, "feeCollector", address(collector));
        vm.serializeAddress(k, "operator", c.operator);
        vm.serializeAddress(k, "arbiter", c.arbiter);
        string memory json = vm.serializeAddress(k, "admin", c.admin);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("usdg", c.usdg);
        console2.log("registry", address(registry));
        console2.log("treasury", address(treasury));
        console2.log("book", address(book));
        console2.log("feeCollector", address(collector));
    }
}
