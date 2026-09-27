/** Minimal ABIs for the contracts the keeper touches. Kept hand-written so the keeper has no build step. */

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const erc721Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

/** Pons v2 fee escrow — native ETH path only (what an ETH-paired launch uses). */
export const ponsEscrowAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "recipient", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const hiveSplitterAbi = [
  { type: "function", name: "harvest", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "distribute", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "escrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "seatTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "event", name: "Distributed", inputs: [{ name: "seat", type: "uint256", indexed: false }, { name: "ops", type: "uint256", indexed: false }, { name: "team", type: "uint256", indexed: false }] },
] as const;

export const hiveStakingAbi = [
  { type: "function", name: "depositReward", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "rewardToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "totalWeight", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalStaked", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/** Seaport BasicOrderParameters, field-for-field with SeatBuyer.sol so an OpenSea order passes straight through. */
const basicOrderParameters = {
  name: "p",
  type: "tuple",
  components: [
    { name: "considerationToken", type: "address" },
    { name: "considerationIdentifier", type: "uint256" },
    { name: "considerationAmount", type: "uint256" },
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offerToken", type: "address" },
    { name: "offerIdentifier", type: "uint256" },
    { name: "offerAmount", type: "uint256" },
    { name: "basicOrderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "offererConduitKey", type: "bytes32" },
    { name: "fulfillerConduitKey", type: "bytes32" },
    { name: "totalOriginalAdditionalRecipients", type: "uint256" },
    { name: "additionalRecipients", type: "tuple[]", components: [{ name: "amount", type: "uint256" }, { name: "recipient", type: "address" }] },
    { name: "signature", type: "bytes" },
  ],
} as const;

export const seatBuyerAbi = [
  { type: "function", name: "buySeat", stateMutability: "nonpayable", inputs: [basicOrderParameters, { name: "maxPay", type: "uint256" }], outputs: [{ name: "tokenId", type: "uint256" }] },
  { type: "function", name: "orderCost", stateMutability: "pure", inputs: [basicOrderParameters], outputs: [{ name: "cost", type: "uint256" }] },
  { type: "function", name: "rescueEth", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "maxSeatPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "seatVault", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "identityMd", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "event", name: "SeatBought", inputs: [{ name: "tokenId", type: "uint256", indexed: true }, { name: "offerer", type: "address", indexed: true }, { name: "totalCost", type: "uint256", indexed: false }] },
] as const;

/** The Seaport BasicOrderParameters shape as a TS type the buy module builds. */
export interface SeaportAdditionalRecipient {
  amount: bigint;
  recipient: `0x${string}`;
}
export interface SeaportBasicOrder {
  considerationToken: `0x${string}`;
  considerationIdentifier: bigint;
  considerationAmount: bigint;
  offerer: `0x${string}`;
  zone: `0x${string}`;
  offerToken: `0x${string}`;
  offerIdentifier: bigint;
  offerAmount: bigint;
  basicOrderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: `0x${string}`;
  salt: bigint;
  offererConduitKey: `0x${string}`;
  fulfillerConduitKey: `0x${string}`;
  totalOriginalAdditionalRecipients: bigint;
  additionalRecipients: SeaportAdditionalRecipient[];
  signature: `0x${string}`;
}
