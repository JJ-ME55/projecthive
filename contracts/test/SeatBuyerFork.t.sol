// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SeatBuyer, ISeaport, BasicOrderParameters, AdditionalRecipient} from "../src/SeatBuyer.sol";

/**
 * The final proof: fork Ethereum mainnet at the block *before* a real identity.md sale, and replay that
 * real, seller-signed Seaport order through our SeatBuyer. If the seat lands in the vault, the whole
 * buy path — struct layout, ETH accounting, collection-check, price-cap, and the Seaport call — is
 * proven against production Seaport, not a mock.
 *
 * Fixture: test/fixtures/real-order.json (token #488, 2.35 ETH, tx 0xb7919f6d…, block 26061335).
 * Run:  ETH_FORK_RPC=https://eth.drpc.org forge test --match-contract SeatBuyerFork -vv
 *   (needs an Ethereum *archive* RPC; eth.drpc.org serves this block keyless. publicnode/ankr gate
 *    archive behind a token/key.) Without ETH_FORK_RPC set, the test skips, so the offline suite
 *    stays green. Verified PASS 2026-09-26: seat #488 forwarded to the vault, all parties paid.
 */
contract SeatBuyerForkTest is Test {
    address constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395; // Seaport 1.6
    address constant IDENTITY_MD = 0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D;
    uint256 constant SALE_BLOCK = 26061335; // the real fill; we fork at SALE_BLOCK - 1

    address vault = makeAddr("seatVault");
    address keeper = makeAddr("keeper");
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return; // skip: no fork RPC configured
        vm.createSelectFork(rpc, SALE_BLOCK - 1);
        forked = true;
    }

    function test_fillsRealIdentityMdOrder() public {
        if (!forked) {
            emit log("SKIP: set ETH_FORK_RPC to an Ethereum archive RPC to run the fork replay");
            return;
        }

        BasicOrderParameters memory p = _loadOrder();
        uint256 cost = p.considerationAmount;
        for (uint256 i; i < p.additionalRecipients.length; i++) cost += p.additionalRecipients[i].amount;

        // the order is only fillable inside its time window; warp just past its start
        vm.warp(p.startTime + 1);

        SeatBuyer buyer = new SeatBuyer(ISeaport(SEAPORT), IERC721(IDENTITY_MD), vault, keeper, 3 ether);
        vm.deal(address(buyer), cost); // bridged treasury ETH lands in the buyer

        // pre-conditions: the seller still owns the seat, the vault owns nothing
        assertEq(IERC721(IDENTITY_MD).ownerOf(p.offerIdentifier), p.offerer, "seller owns seat pre-fill");
        assertEq(IERC721(IDENTITY_MD).balanceOf(vault), 0, "vault empty pre-fill");
        uint256 sellerBefore = p.offerer.balance;
        uint256 feeRecip = p.additionalRecipients[0].recipient.balance;

        // fill it, exactly as the keeper would
        vm.prank(keeper);
        uint256 tokenId = buyer.buySeat(p, 3 ether);

        // the seat is now in the vault, and everyone was paid from the buyer's ETH
        assertEq(tokenId, p.offerIdentifier, "returned tokenId");
        assertEq(IERC721(IDENTITY_MD).ownerOf(p.offerIdentifier), vault, "seat forwarded to vault");
        assertEq(p.offerer.balance, sellerBefore + p.considerationAmount, "seller paid consideration");
        assertEq(p.additionalRecipients[0].recipient.balance, feeRecip + p.additionalRecipients[0].amount, "fee recipient paid");
        assertEq(address(buyer).balance, 0, "buyer spent exactly the cost");
        emit log_named_uint("filled real identity.md seat #", tokenId);
        emit log_named_uint("total cost (wei)", cost);
    }

    /// Build the struct field-by-field from the fixture (avoids the alphabetical-tuple-decode gotcha).
    function _loadOrder() internal view returns (BasicOrderParameters memory p) {
        string memory j = vm.readFile("test/fixtures/real-order.json");
        p.considerationToken = vm.parseJsonAddress(j, ".parameters.considerationToken");
        p.considerationIdentifier = vm.parseJsonUint(j, ".parameters.considerationIdentifier");
        p.considerationAmount = vm.parseJsonUint(j, ".parameters.considerationAmount");
        p.offerer = payable(vm.parseJsonAddress(j, ".parameters.offerer"));
        p.zone = vm.parseJsonAddress(j, ".parameters.zone");
        p.offerToken = vm.parseJsonAddress(j, ".parameters.offerToken");
        p.offerIdentifier = vm.parseJsonUint(j, ".parameters.offerIdentifier");
        p.offerAmount = vm.parseJsonUint(j, ".parameters.offerAmount");
        p.basicOrderType = uint8(vm.parseJsonUint(j, ".parameters.basicOrderType"));
        p.startTime = vm.parseJsonUint(j, ".parameters.startTime");
        p.endTime = vm.parseJsonUint(j, ".parameters.endTime");
        p.zoneHash = vm.parseJsonBytes32(j, ".parameters.zoneHash");
        p.salt = vm.parseJsonUint(j, ".parameters.salt");
        p.offererConduitKey = vm.parseJsonBytes32(j, ".parameters.offererConduitKey");
        p.fulfillerConduitKey = vm.parseJsonBytes32(j, ".parameters.fulfillerConduitKey");
        p.totalOriginalAdditionalRecipients = vm.parseJsonUint(j, ".parameters.totalOriginalAdditionalRecipients");
        uint256 n = p.totalOriginalAdditionalRecipients;
        p.additionalRecipients = new AdditionalRecipient[](n);
        for (uint256 i; i < n; i++) {
            string memory base = string.concat(".parameters.additionalRecipients[", vm.toString(i), "]");
            p.additionalRecipients[i].amount = vm.parseJsonUint(j, string.concat(base, ".amount"));
            p.additionalRecipients[i].recipient = payable(vm.parseJsonAddress(j, string.concat(base, ".recipient")));
        }
        p.signature = vm.parseJsonBytes(j, ".parameters.signature");
    }
}
