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

/// @notice Deploys Oddra to Robinhood Chain testnet (46630) or a local anvil (31337). Refuses every other chain:
///         real-money deployment needs an audit, a multisig admin and legal approval first.
///
/// Env: DEPLOYER_PRIVATE_KEY, OPERATOR_ADDRESS, KEEPER_ADDRESS (defaults: deployer), USDG_ADDRESS (empty = deploy the
///      test token), TREASURY_SEED_USDG (whole USDG minted into the treasury when using the test token, default 250000).
contract Deploy is Script {
    address constant ARBSYS = address(0x64);

    function run() external {
        require(block.chainid == 46630 || block.chainid == 31337, "Oddra deploys to testnet or anvil only");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);
        address keeper = vm.envOr("KEEPER_ADDRESS", deployer);
        address usdgAddr = vm.envOr("USDG_ADDRESS", address(0));
        uint256 seed = vm.envOr("TREASURY_SEED_USDG", uint256(250_000));

        vm.startBroadcast(pk);

        bool testToken = usdgAddr == address(0);
        if (testToken) usdgAddr = address(new OddraTestUSDG());
        IERC20 usdg = IERC20(usdgAddr);

        IBlockSource blocks = block.chainid == 31337 ? IBlockSource(address(new NativeBlockSource())) : IBlockSource(ARBSYS);
        OddraMatchRegistry registry = new OddraMatchRegistry(deployer, blocks);
        OddraTreasury treasury = new OddraTreasury(deployer, usdg);
        OddraRiskManager risk = new OddraRiskManager(
            deployer,
            OddraRiskManager.Limits({
                minStake: 1e6,
                maxStake: 500e6,
                maxPayout: 10_000e6,
                maxSelectionLiability: 25_000e6,
                maxMatchLiability: 50_000e6,
                minFreeReserve: 5_000e6,
                maxTotalLiabilityBps: 8_000,
                maxPayoutOfFreeBps: 1_000
            })
        );
        OddraBook book = new OddraBook(deployer, usdg, registry, treasury, risk);
        OddraFeeCollector collector = new OddraFeeCollector(deployer, usdg, treasury);

        registry.grantRole(registry.OPERATOR_ROLE(), operator);
        book.grantRole(book.OPERATOR_ROLE(), operator);
        book.grantRole(book.PAUSER_ROLE(), deployer);
        treasury.grantRole(treasury.BOOK_ROLE(), address(book));
        treasury.grantRole(treasury.TREASURER_ROLE(), deployer);
        risk.grantRole(risk.RISK_ROLE(), deployer);
        collector.grantRole(collector.KEEPER_ROLE(), keeper);

        if (testToken && seed > 0) {
            OddraTestUSDG(usdgAddr).mint(deployer, seed * 1e6);
            usdg.approve(address(treasury), seed * 1e6);
            treasury.contribute(seed * 1e6, treasury.SOURCE_HOUSE());
        }

        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeBool(k, "testToken", testToken);
        vm.serializeAddress(k, "usdg", usdgAddr);
        vm.serializeAddress(k, "registry", address(registry));
        vm.serializeAddress(k, "treasury", address(treasury));
        vm.serializeAddress(k, "risk", address(risk));
        vm.serializeAddress(k, "book", address(book));
        vm.serializeAddress(k, "feeCollector", address(collector));
        vm.serializeAddress(k, "operator", operator);
        string memory json = vm.serializeAddress(k, "admin", deployer);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));

        console2.log("usdg", usdgAddr);
        console2.log("registry", address(registry));
        console2.log("treasury", address(treasury));
        console2.log("book", address(book));
        console2.log("feeCollector", address(collector));
    }
}
