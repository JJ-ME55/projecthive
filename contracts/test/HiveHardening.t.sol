// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {HiveStaking} from "../src/HiveStaking.sol";
import {HiveSplitter} from "../src/HiveSplitter.sol";
import {SeatBuyer, ISeaport} from "../src/SeatBuyer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// plain 18-dec ERC20
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MCK") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// fee-on-transfer ERC20: skims 1% to a sink on every wallet-to-wallet transfer
contract FeeToken is ERC20 {
    address constant SINK = 0x000000000000000000000000000000000000dEaD;
    constructor() ERC20("Fee", "FEE") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, SINK, fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract Reverter {
    receive() external payable { revert("no eth"); }
}

/// Regression tests for the pre-launch hardening pass (audit findings M-2, M-4, L-1, L-3).
contract HiveHardeningTest is Test {
    address alice = address(0xA11CE);
    address whale = address(0x00A1E);

    // ---- M-4: depositReward credits the ACTUAL received amount, so a fee-on-transfer reward token
    //          can never make the contract record more IMD liability than it holds (stays solvent) ----
    function test_M4_depositReward_creditsReceived_staysSolvent() public {
        MockERC20 hive = new MockERC20();
        FeeToken imd = new FeeToken();
        HiveStaking st = new HiveStaking(IERC20(address(hive)), IERC20(address(imd)));

        hive.mint(alice, 1000e18);
        vm.startPrank(alice);
        hive.approve(address(st), type(uint256).max);
        st.stake(1000e18);
        vm.stopPrank();

        imd.mint(address(this), 100e18);
        imd.approve(address(st), type(uint256).max);
        st.depositReward(100e18); // contract receives ~99 after the 1% skim

        uint256 held = imd.balanceOf(address(st));
        assertLe(st.pending(alice), held, "credited <= held: no phantom liability");

        vm.prank(alice);
        st.claim(); // must not revert — contract is solvent for what it credited
        assertEq(imd.balanceOf(address(st)), 0, "fully drained, was solvent");
    }

    // ---- L-3: a deposit too small to move accRewardPerWeight against the current weight is CARRIED
    //          forward, not silently burned ----
    function test_L3_tinyDeposit_carriesNotBurns() public {
        MockERC20 hive = new MockERC20();
        MockERC20 imd = new MockERC20();
        HiveStaking st = new HiveStaking(IERC20(address(hive)), IERC20(address(imd)));

        hive.mint(whale, 1e27);
        vm.startPrank(whale);
        hive.approve(address(st), type(uint256).max);
        st.stake(1e27); // weight ~1e27
        vm.stopPrank();

        imd.mint(address(this), 2e18);
        imd.approve(address(st), type(uint256).max);
        st.depositReward(1); // (1 * 1e18) / 1e27 = 0 -> must carry, not burn

        assertEq(st.rewardCarry(), 1, "1 wei carried");
        assertEq(st.accRewardPerWeight(), 0, "acc unchanged");

        // a subsequent real deposit rolls the carry in and distributes both
        st.depositReward(1e18);
        assertEq(st.rewardCarry(), 0, "carry consumed once distributable");
        assertGt(st.accRewardPerWeight(), 0, "distributed");
    }

    // ---- M-2: awareness — a HiveSplitter recipient that reverts on receive() bricks ALL payouts.
    //          This is why the live splitter's seat/ops/team must be EOAs (they are). ----
    function test_M2_revertingRecipient_bricksSplitter() public {
        Reverter bad = new Reverter();
        HiveSplitter sp = new HiveSplitter(address(bad), address(0x0B5), address(0x7EA1), address(0));
        vm.deal(address(sp), 1 ether);
        vm.expectRevert(HiveSplitter.SendFailed.selector);
        sp.distribute();
    }

    // ---- L-1: rescueEth is restricted to the keeper or the vault (can't be front-run to grief a buy) ----
    function test_L1_rescueEth_restrictedToKeeperOrVault() public {
        address vault = address(0xBEEF);
        address keeper = address(0x6EE9);
        SeatBuyer sb = new SeatBuyer(ISeaport(address(0x5EA7)), IERC721(address(0x1D)), vault, keeper, 2.5 ether);
        vm.deal(address(sb), 1 ether);

        vm.prank(address(0xBAD));
        vm.expectRevert(SeatBuyer.NotKeeper.selector);
        sb.rescueEth();

        vm.prank(keeper);
        sb.rescueEth();
        assertEq(vault.balance, 1 ether, "rescued to the fixed vault");
    }
}
