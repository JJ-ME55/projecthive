// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SeatBuyer, ISeaport, BasicOrderParameters, AdditionalRecipient} from "../src/SeatBuyer.sol";

contract MockNft is ERC721 {
    constructor(string memory n) ERC721(n, n) {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}

// stand-in for Seaport: checks the payment, moves the NFT to the buyer, pays the seller + fee recipients
contract MockSeaport is ISeaport {
    function fulfillBasicOrder(BasicOrderParameters calldata p) external payable returns (bool) {
        uint256 cost = p.considerationAmount;
        for (uint256 i = 0; i < p.additionalRecipients.length; i++) cost += p.additionalRecipients[i].amount;
        require(msg.value == cost, "bad msg.value");
        IERC721(p.offerToken).transferFrom(p.offerer, msg.sender, p.offerIdentifier);
        (bool ok,) = p.offerer.call{value: p.considerationAmount}("");
        require(ok, "pay offerer");
        for (uint256 i = 0; i < p.additionalRecipients.length; i++) {
            (ok,) = p.additionalRecipients[i].recipient.call{value: p.additionalRecipients[i].amount}("");
            require(ok, "pay recip");
        }
        return true;
    }
}

contract SeatBuyerTest is Test {
    MockSeaport seaport;
    MockNft nft; // identity.md
    MockNft other; // some other collection
    SeatBuyer buyer;

    address vault = address(0x5EA7); // seat vault (EOA in the test)
    address offerer = address(0x0FFE7);
    address feeRecipient = address(0xFEE);
    uint256 constant MAX_SEAT_PRICE = 3 ether;

    function setUp() public {
        seaport = new MockSeaport();
        nft = new MockNft("identity.md");
        other = new MockNft("Other");
        // keeper == address(this) so the test drives buys directly
        buyer = new SeatBuyer(seaport, IERC721(address(nft)), vault, address(this), MAX_SEAT_PRICE);

        nft.mint(offerer, 1);
        other.mint(offerer, 1);
        vm.prank(offerer);
        nft.setApprovalForAll(address(seaport), true);
        vm.prank(offerer);
        other.setApprovalForAll(address(seaport), true);
    }

    function _order(address collection, uint256 id, uint256 price, uint256 fee)
        internal
        view
        returns (BasicOrderParameters memory p)
    {
        AdditionalRecipient[] memory recips = new AdditionalRecipient[](1);
        recips[0] = AdditionalRecipient({amount: fee, recipient: payable(feeRecipient)});
        p.considerationToken = address(0);
        p.considerationAmount = price;
        p.offerer = payable(offerer);
        p.offerToken = collection;
        p.offerIdentifier = id;
        p.offerAmount = 1;
        p.endTime = type(uint256).max;
        p.totalOriginalAdditionalRecipients = 1;
        p.additionalRecipients = recips;
    }

    function test_buysAndForwardsToVault() public {
        vm.deal(address(buyer), 2 ether);
        BasicOrderParameters memory p = _order(address(nft), 1, 1.9 ether, 0.05 ether);
        uint256 id = buyer.buySeat(p, 2 ether);
        assertEq(id, 1);
        assertEq(nft.ownerOf(1), vault, "seat forwarded to vault");
        assertEq(offerer.balance, 1.9 ether, "seller paid");
        assertEq(feeRecipient.balance, 0.05 ether, "fee paid");
        assertEq(address(buyer).balance, 0.05 ether, "spent exactly the cost");
    }

    function test_rejectsWrongCollection() public {
        vm.deal(address(buyer), 2 ether);
        BasicOrderParameters memory p = _order(address(other), 1, 1.9 ether, 0.05 ether);
        vm.expectRevert(SeatBuyer.WrongCollection.selector);
        buyer.buySeat(p, 2 ether);
    }

    function test_rejectsNonEthListing() public {
        vm.deal(address(buyer), 2 ether);
        BasicOrderParameters memory p = _order(address(nft), 1, 1.9 ether, 0);
        p.considerationToken = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48); // a USDC-priced listing
        vm.expectRevert(SeatBuyer.NotEthListing.selector);
        buyer.buySeat(p, 2 ether);
    }

    function test_capsByMaxPay() public {
        vm.deal(address(buyer), 5 ether);
        BasicOrderParameters memory p = _order(address(nft), 1, 1.9 ether, 0.05 ether); // cost 1.95
        vm.expectRevert(abi.encodeWithSelector(SeatBuyer.PriceTooHigh.selector, 1.95 ether, 1.5 ether));
        buyer.buySeat(p, 1.5 ether);
    }

    function test_capsByHardCeiling() public {
        SeatBuyer low = new SeatBuyer(seaport, IERC721(address(nft)), vault, address(this), 1 ether);
        vm.deal(address(low), 5 ether);
        BasicOrderParameters memory p = _order(address(nft), 1, 1.9 ether, 0.05 ether); // cost 1.95
        // limit = min(maxPay 5, ceiling 1) = 1 ether
        vm.expectRevert(abi.encodeWithSelector(SeatBuyer.PriceTooHigh.selector, 1.95 ether, 1 ether));
        low.buySeat(p, 5 ether);
    }

    function test_onlyKeeper() public {
        vm.deal(address(buyer), 2 ether);
        BasicOrderParameters memory p = _order(address(nft), 1, 1.9 ether, 0.05 ether);
        vm.prank(address(0xBAD));
        vm.expectRevert(SeatBuyer.NotKeeper.selector);
        buyer.buySeat(p, 2 ether);
    }

    function test_rescueEthGoesToVault() public {
        vm.deal(address(buyer), 1.2 ether);
        buyer.rescueEth();
        assertEq(vault.balance, 1.2 ether, "idle ETH returned to vault");
        assertEq(address(buyer).balance, 0);
    }
}
