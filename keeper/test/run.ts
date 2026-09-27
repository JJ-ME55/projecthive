/**
 * Offline keeper tests — no key, no network. The important one is `seaport struct parity`: it proves our
 * BasicOrderParameters tuple is byte-identical to Seaport's canonical fulfillBasicOrder, so an OpenSea
 * order mapped by toBasicOrder() and passed to SeatBuyer.buySeat() will ABI-encode exactly as Seaport
 * expects when the contract forwards it. Everything downstream (the on-chain fill) rests on this.
 */
import { encodeFunctionData, getAddress, toFunctionSelector, type AbiFunction } from "viem";
import { seatBuyerAbi } from "../src/abi.js";
import { toBasicOrder, orderCost, validateOrder } from "../src/seats.js";
import { ADDR } from "../src/config.js";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = ""): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
function eq(a: unknown, b: unknown, name: string): void {
  ok(a === b, name, `\n       got ${a}\n       exp ${b}`);
}

// A realistic OpenSea fulfillment_data.transaction.input_data.parameters for an ETH basic order:
// seller gets 1.9 ETH, OpenSea fee 0.05 ETH, creator royalty 0.05 ETH -> total 2.0 ETH.
const IDENTITY_MD = ADDR.identityMd;
const fixtureCamel = {
  considerationToken: "0x0000000000000000000000000000000000000000",
  considerationIdentifier: "0",
  considerationAmount: "1900000000000000000",
  offerer: "0x1111111111111111111111111111111111111111",
  zone: "0x004C00500000aD104D7DBd00e3ae0A5C00560C00",
  offerToken: IDENTITY_MD,
  offerIdentifier: "742",
  offerAmount: "1",
  basicOrderType: 0,
  startTime: "1700000000",
  endTime: "1800000000",
  zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
  salt: "51951570786702011277730170004907922605686240096375603561864587076224769878035",
  offererConduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  fulfillerConduitKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
  totalOriginalAdditionalRecipients: "2",
  additionalRecipients: [
    { amount: "50000000000000000", recipient: "0x0000a26b00c1F0DF003000390027140000fAa719" }, // OpenSea fee
    { amount: "50000000000000000", recipient: "0x2222222222222222222222222222222222222222" }, // royalty
  ],
  signature: "0xabcd",
};

console.log("seaport struct parity");
{
  // Canonical Seaport fulfillBasicOrder signature (BasicOrderParameters spelled out).
  const canonical =
    "fulfillBasicOrder((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))";
  const canonicalSelector = toFunctionSelector(canonical);
  // Build the same function from OUR tuple components (as SeatBuyer.buySeat carries them).
  const buySeat = seatBuyerAbi.find((f) => (f as any).name === "buySeat") as AbiFunction;
  const ourParamsTuple = buySeat.inputs[0]; // the BasicOrderParameters tuple
  const ours: AbiFunction = { type: "function", name: "fulfillBasicOrder", stateMutability: "payable", inputs: [ourParamsTuple], outputs: [{ type: "bool" }] };
  const ourSelector = toFunctionSelector(ours);
  eq(ourSelector, canonicalSelector, "our BasicOrderParameters == Seaport canonical");
  eq(canonicalSelector, "0xfb0f3ee1", "canonical selector is the known Seaport 0xfb0f3ee1");
}

console.log("toBasicOrder mapping");
{
  const o = toBasicOrder(fixtureCamel);
  eq(o.considerationAmount, 1900000000000000000n, "considerationAmount");
  eq(o.offerIdentifier, 742n, "offerIdentifier (tokenId)");
  eq(o.offerAmount, 1n, "offerAmount");
  eq(o.additionalRecipients.length, 2, "two additional recipients");
  eq(o.additionalRecipients[0].amount, 50000000000000000n, "recipient 0 amount");
  eq(getAddress(o.offerToken), IDENTITY_MD, "offerToken is identity.md");
  ok(o.salt > 0n, "salt parsed as bigint");

  // snake_case variant (some OpenSea payloads) maps identically
  const snake: any = {
    consideration_token: fixtureCamel.considerationToken, consideration_identifier: "0", consideration_amount: fixtureCamel.considerationAmount,
    offerer: fixtureCamel.offerer, zone: fixtureCamel.zone, offer_token: IDENTITY_MD, offer_identifier: "742", offer_amount: "1",
    basic_order_type: 0, start_time: "1700000000", end_time: "1800000000", zone_hash: fixtureCamel.zoneHash, salt: "123",
    offerer_conduit_key: fixtureCamel.offererConduitKey, fulfiller_conduit_key: fixtureCamel.fulfillerConduitKey,
    total_original_additional_recipients: "2", additional_recipients: fixtureCamel.additionalRecipients, signature: "0x",
  };
  const o2 = toBasicOrder(snake);
  eq(o2.considerationAmount, 1900000000000000000n, "snake_case considerationAmount");
  eq(o2.offerIdentifier, 742n, "snake_case tokenId");
}

console.log("orderCost + validateOrder");
{
  const o = toBasicOrder(fixtureCamel);
  eq(orderCost(o), 2000000000000000000n, "cost = 1.9 + 0.05 + 0.05 = 2.0 ETH");

  const under = validateOrder(o, 2500000000000000000n); // cap 2.5 > cost 2.0
  ok(under.ok && under.cost === 2000000000000000000n, "passes under cap");

  const over = validateOrder(o, 1500000000000000000n); // cap 1.5 < cost 2.0
  ok(!over.ok, "rejected over cap");

  const wrongColl = toBasicOrder({ ...fixtureCamel, offerToken: "0x9999999999999999999999999999999999999999" });
  ok(!validateOrder(wrongColl, 2500000000000000000n).ok, "rejected wrong collection");

  const erc20listing = toBasicOrder({ ...fixtureCamel, considerationToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" });
  ok(!validateOrder(erc20listing, 2500000000000000000n).ok, "rejected non-ETH listing");
}

console.log("buySeat encodes");
{
  const o = toBasicOrder(fixtureCamel);
  const data = encodeFunctionData({ abi: seatBuyerAbi, functionName: "buySeat", args: [o as any, 2500000000000000000n] });
  ok(data.startsWith("0x") && data.length > 200, "buySeat calldata encodes");
  eq(data.slice(0, 10), toFunctionSelector(seatBuyerAbi.find((f) => (f as any).name === "buySeat") as AbiFunction), "buySeat selector matches");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
