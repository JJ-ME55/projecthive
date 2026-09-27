// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {HiveSplitter} from "../src/HiveSplitter.sol";
import {HiveStaking} from "../src/HiveStaking.sol";
import {SeatBuyer, ISeaport} from "../src/SeatBuyer.sol";

/**
 * @notice HiveSplitter — the $HIVE creator-fee wallet on Pons v2 (Robinhood Chain). Deploy this FIRST,
 *         before the token launch, and set its address as the creator-fee recipient in the Pons form.
 *
 *   SEAT_TREASURY=0x.. OPS=0x.. TEAM=0x.. \
 *   forge script script/DeployHive.s.sol:DeployHiveSplitter --rpc-url robinhood --broadcast \
 *       --account <keystore> --sender <deployer> --slow
 *
 * PONS_ESCROW defaults to the known Robinhood-Chain fee escrow; harvest() claims ETH from it.
 */
contract DeployHiveSplitter is Script {
    address constant PONS_ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e; // Pons v2 fee escrow

    function run() external returns (HiveSplitter splitter) {
        address seat = vm.envAddress("SEAT_TREASURY"); // Safe that accumulates ETH to buy seats
        address ops = vm.envAddress("OPS");
        address team = vm.envAddress("TEAM");
        address escrow = vm.envOr("PONS_ESCROW", PONS_ESCROW);
        console2.log("chainId       :", block.chainid);
        console2.log("seatTreasury  :", seat);
        console2.log("ops           :", ops);
        console2.log("team          :", team);
        console2.log("ponsEscrow    :", escrow);

        vm.startBroadcast();
        splitter = new HiveSplitter(seat, ops, team, escrow);
        vm.stopBroadcast();

        require(splitter.seatTreasury() == seat, "seat mismatch");
        console2.log("HiveSplitter  :", address(splitter));
        console2.log(">> use this as the $HIVE creator-fee wallet when you launch on Pons v2");
        console2.log(">> anyone can call harvest() to claim escrow fees + split them, fully on-chain");
    }
}

/**
 * @notice HiveStaking — holders stake $HIVE, earn IMD. Deploy AFTER the Pons launch (needs the $HIVE
 *         token address) on Robinhood Chain. IMD_TOKEN is the bridged IMD on Robinhood Chain.
 *
 *   HIVE_TOKEN=0x.. IMD_TOKEN=0x.. \
 *   forge script script/DeployHive.s.sol:DeployHiveStaking --rpc-url robinhood --broadcast ...
 */
contract DeployHiveStaking is Script {
    function run() external returns (HiveStaking staking) {
        address hive = vm.envAddress("HIVE_TOKEN");
        address imd = vm.envAddress("IMD_TOKEN");
        console2.log("chainId    :", block.chainid);
        console2.log("stakeToken :", hive);
        console2.log("rewardToken:", imd);

        vm.startBroadcast();
        staking = new HiveStaking(IERC20(hive), IERC20(imd));
        vm.stopBroadcast();

        require(address(staking.stakeToken()) == hive, "stake mismatch");
        console2.log("HiveStaking:", address(staking));
    }
}

/**
 * @notice SeatBuyer — auto-buys identity.md seats via Seaport on ETHEREUM. Seaport 1.6 and the
 *         identity.md collection default to their mainnet addresses; set the rest.
 *
 *   SEAT_VAULT=0x.. KEEPER=0x.. MAX_SEAT_PRICE=<wei> \
 *   [SEAPORT=0x.. IDENTITY_MD=0x..] \
 *   forge script script/DeployHive.s.sol:DeploySeatBuyer --rpc-url <eth> --broadcast ...
 */
contract DeploySeatBuyer is Script {
    address constant SEAPORT_16 = 0x0000000000000068F116a894984e2DB1123eB395; // Seaport 1.6
    address constant IDENTITY_MD = 0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D; // identity.md NFT

    function run() external returns (SeatBuyer buyer) {
        address seaport = vm.envOr("SEAPORT", SEAPORT_16);
        address idmd = vm.envOr("IDENTITY_MD", IDENTITY_MD);
        address vault = vm.envAddress("SEAT_VAULT"); // where bought seats + rescued ETH go (the Safe)
        address keeper = vm.envAddress("KEEPER"); // the operator that triggers buys
        uint256 cap = vm.envUint("MAX_SEAT_PRICE"); // hard ceiling per seat, in wei

        console2.log("chainId     :", block.chainid);
        console2.log("seaport     :", seaport);
        console2.log("identityMd  :", idmd);
        console2.log("seatVault   :", vault);
        console2.log("keeper      :", keeper);
        console2.log("maxSeatPrice:", cap);

        vm.startBroadcast();
        buyer = new SeatBuyer(ISeaport(seaport), IERC721(idmd), vault, keeper, cap);
        vm.stopBroadcast();

        require(buyer.seatVault() == vault, "vault mismatch");
        console2.log("SeatBuyer   :", address(buyer));
    }
}
