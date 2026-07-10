// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {CovaDollarYield} from "../src/examples/cova/CovaDollarYield.sol";
import {CovaProjectRegistry} from "../src/examples/cova/CovaProjectRegistry.sol";
import {CovaPointsVotingModule} from "../src/examples/cova/CovaPointsVotingModule.sol";
import {CovaArtFundStrategy} from "../src/examples/cova/CovaArtFundStrategy.sol";
import {OnePersonOneVotePower} from "../src/examples/cova/OnePersonOneVotePower.sol";

/// @notice One-off deploy of the COVA custom MODULES — not a wired system. The
///         printed addresses are pasted into the creation wizard's "Custom
///         modules" fields; the canonical CrowdStakeDeployer then deploys the
///         distribution manager (+ cycle module) around them and wires
///         everything it owns. Two modules are deliberately left UNinitialized
///         (their initializers take the distribution manager the wizard
///         creates) — the wizard's success screen walks through the follow-ups,
///         also printed below.
///
/// @dev Run manually (no CI target):
///        PRIVATE_KEY=... forge script script/DeployCovaModules.s.sol \
///          --rpc-url "$RPC_URL" --broadcast --slow -vvvv
///      Env (all optional):
///        ASSET        deposit stablecoin/wrapped-native (default Gnosis WXDAI)
///        YIELD_VAULT  ERC-4626 vault over ASSET          (default Gnosis sDAI)
///        COORDINATOR  cooperative coordinator/owner      (default broadcaster)
///        TOKEN_NAME / TOKEN_SYMBOL                       (default COVA USD / cUSD)
contract DeployCovaModules is Script {
    // Gnosis defaults: CovaDollarYield requires VAULT.asset() == ASSET (WXDAI -> sDAI).
    address constant DEFAULT_ASSET = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI
    address constant DEFAULT_YIELD_VAULT = 0xaf204776c7245bF4147c2612BF6e5972Ee483701; // sDAI

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address broadcaster = vm.addr(pk);
        address asset = vm.envOr("ASSET", DEFAULT_ASSET);
        address yieldVault = vm.envOr("YIELD_VAULT", DEFAULT_YIELD_VAULT);
        address coordinator = vm.envOr("COORDINATOR", broadcaster);
        string memory tokenName = vm.envOr("TOKEN_NAME", string("COVA USD"));
        string memory tokenSymbol = vm.envOr("TOKEN_SYMBOL", string("cUSD"));

        vm.startBroadcast(pk);

        // Membership (one member = one vote); constructor-configured, used as-is.
        OnePersonOneVotePower power = new OnePersonOneVotePower(coordinator);

        // Initializable modules ship as impl + minimal clone: the impls run
        // _disableInitializers() in their constructors, so a direct `new` could
        // never be initialized — the clone's storage is fresh and can be.
        address registry = Clones.clone(address(new CovaProjectRegistry()));
        CovaProjectRegistry(registry).initialize(coordinator);

        address token = Clones.clone(address(new CovaDollarYield(asset, yieldVault)));
        CovaDollarYield(payable(token)).initialize(tokenName, tokenSymbol, coordinator);

        // Deliberately NOT initialized here — both initializers take the
        // distribution manager the creation wizard deploys.
        address votingModule = Clones.clone(address(new CovaPointsVotingModule()));
        address strategy = Clones.clone(address(new CovaArtFundStrategy()));

        vm.stopBroadcast();

        console.log("== COVA modules (paste into the wizard's Custom modules fields) ==");
        console.log("Recipient registry:       %s", registry);
        console.log("Token:                    %s", token);
        console.log("Voting module:            %s  (UNinitialized)", votingModule);
        console.log("Distribution strategy:    %s  (UNinitialized)", strategy);
        console.log("Voting power strategy[0]: %s", address(power));
        console.log("");
        console.log("Coordinator: %s | asset %s | vault %s", coordinator, asset, yieldVault);
        console.log("");
        console.log("== After the wizard deploy (DM = new distribution manager) ==");
        console.log("1. cast send %s 'setYieldClaimer(address)' $DM", token);
        console.log(
            "2. cast send %s 'initialize(address,address,address,uint256)' %s $DM %s 5", strategy, token, coordinator
        );
        console.log(
            "3. cast send %s 'initialize(address[],address,address)' [%s] $DM %s",
            votingModule,
            address(power),
            coordinator
        );
        console.log("   (cycle module is canonical -> already wired by the deployer)");
    }
}
