/**
 * Lane 3 — buy a seat. Read the cheapest live identity.md listings off OpenSea, pull the fulfillment
 * data for the cheapest one that is a *basic* Seaport order (our SeatBuyer fills fulfillBasicOrder;
 * OpenSea returns advanced orders for some listings, which we skip), map it field-for-field to the
 * BasicOrderParameters struct, and call SeatBuyer.buySeat behind its on-chain collection-check and
 * price-cap. The keeper never holds the seat: the contract forwards it to the vault.
 *
 * Needs OPENSEA_API_KEY at launch (listings + fulfillment are key-gated). `toBasicOrder` is pure and
 * unit-tested against a real fixture, so the risky part (struct mapping) is proven without a key.
 */
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { erc721Abi, seatBuyerAbi, type SeaportBasicOrder } from "./abi.js";
import { ADDR, API, POLICY, requireAddrs } from "./config.js";
import { ethereum, ethereumSigner } from "./clients.js";
import { fetchJson, fmt, log, warn } from "./util.js";

const NATIVE = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

export interface Listing {
  orderHash: Hex;
  protocolAddress: Address;
  priceWei: bigint; // OpenSea's current price (for sorting/display)
  chain: string;
}

function osHeaders(): Record<string, string> {
  if (!API.openseaKey) throw new Error("OPENSEA_API_KEY is not set (required to read listings + fulfillment)");
  return { "x-api-key": API.openseaKey, accept: "application/json" };
}

/** Cheapest live listings for the identity.md collection, ascending by price. Needs the collection slug. */
export async function cheapestListings(limit = 10): Promise<Listing[]> {
  const slug = (process.env.OPENSEA_COLLECTION ?? "").trim();
  if (!slug) throw new Error("OPENSEA_COLLECTION (the identity.md collection slug) is not set");
  const r = await fetchJson<any>(`${API.openseaBase}/api/v2/listings/collection/${slug}/best?limit=${limit}`, { headers: osHeaders(), timeoutMs: 30_000 });
  const out: Listing[] = [];
  for (const l of r.listings ?? []) {
    const price = l.price?.current ?? {};
    out.push({
      orderHash: (l.order_hash ?? l.protocol_data?.parameters?.orderHash) as Hex,
      protocolAddress: getAddress(l.protocol_address ?? ADDR.seaport),
      priceWei: BigInt(price.value ?? "0"),
      chain: l.chain ?? "ethereum",
    });
  }
  return out.filter((l) => l.orderHash).sort((a, b) => (a.priceWei < b.priceWei ? -1 : a.priceWei > b.priceWei ? 1 : 0));
}

/** OpenSea's ready-to-send fulfillment for one listing. We only accept the fulfillBasicOrder family. */
export async function fulfillment(listing: Listing, fulfiller: Address): Promise<{ fn: string; to: Address; value: bigint; params: any } | null> {
  const body = {
    listing: { hash: listing.orderHash, chain: listing.chain, protocol_address: listing.protocolAddress },
    fulfiller: { address: fulfiller },
  };
  const r = await fetchJson<any>(`${API.openseaBase}/api/v2/listings/fulfillment_data`, {
    method: "POST",
    headers: { ...osHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  const tx = r.fulfillment_data?.transaction;
  if (!tx) return null;
  const fn = String(tx.function ?? "");
  const params = tx.input_data?.parameters ?? tx.input_data?.[0] ?? tx.input_data;
  if (!fn.startsWith("fulfillBasicOrder")) {
    warn(`[seats] listing ${listing.orderHash.slice(0, 10)}… is a ${fn.split("(")[0]} order, not basic — skipping (SeatBuyer fills basic orders only)`);
    return null;
  }
  return { fn, to: getAddress(tx.to), value: BigInt(tx.value ?? "0"), params };
}

/** Map OpenSea's Seaport parameters (camel or snake case) into our strict BasicOrderParameters. Pure. */
export function toBasicOrder(p: any): SeaportBasicOrder {
  const g = (a: string, b: string) => p[a] ?? p[b];
  const recips = (g("additionalRecipients", "additional_recipients") ?? []) as any[];
  return {
    considerationToken: getAddress(g("considerationToken", "consideration_token")),
    considerationIdentifier: BigInt(g("considerationIdentifier", "consideration_identifier") ?? "0"),
    considerationAmount: BigInt(g("considerationAmount", "consideration_amount")),
    offerer: getAddress(g("offerer", "offerer")),
    zone: getAddress(g("zone", "zone")),
    offerToken: getAddress(g("offerToken", "offer_token")),
    offerIdentifier: BigInt(g("offerIdentifier", "offer_identifier")),
    offerAmount: BigInt(g("offerAmount", "offer_amount")),
    basicOrderType: Number(g("basicOrderType", "basic_order_type")),
    startTime: BigInt(g("startTime", "start_time")),
    endTime: BigInt(g("endTime", "end_time")),
    zoneHash: (g("zoneHash", "zone_hash") ?? ZERO32) as Hex,
    salt: BigInt(g("salt", "salt")),
    offererConduitKey: (g("offererConduitKey", "offerer_conduit_key") ?? ZERO32) as Hex,
    fulfillerConduitKey: (g("fulfillerConduitKey", "fulfiller_conduit_key") ?? ZERO32) as Hex,
    totalOriginalAdditionalRecipients: BigInt(g("totalOriginalAdditionalRecipients", "total_original_additional_recipients") ?? recips.length),
    additionalRecipients: recips.map((r) => ({ amount: BigInt(r.amount), recipient: getAddress(r.recipient) })),
    signature: (p.signature ?? "0x") as Hex,
  };
}

/** Total ETH a mapped order costs = seller consideration + every additional recipient (fees/royalties). */
export function orderCost(o: SeaportBasicOrder): bigint {
  return o.additionalRecipients.reduce((s, r) => s + r.amount, o.considerationAmount);
}

/** Validate an order is a single-ETH identity.md buy we're allowed to fill, and return its cost. */
export function validateOrder(o: SeaportBasicOrder, maxPayWei: bigint): { ok: true; cost: bigint } | { ok: false; reason: string } {
  if (getAddress(o.offerToken) !== ADDR.identityMd) return { ok: false, reason: `wrong collection ${o.offerToken}` };
  if (getAddress(o.considerationToken) !== getAddress(NATIVE)) return { ok: false, reason: "not an ETH listing" };
  if (o.offerAmount !== 1n) return { ok: false, reason: "not a single NFT" };
  const cost = orderCost(o);
  const limit = maxPayWei < POLICY.maxSeatPriceWei ? maxPayWei : POLICY.maxSeatPriceWei;
  if (cost > limit) return { ok: false, reason: `cost ${fmt(cost)} > limit ${fmt(limit)}` };
  return { ok: true, cost };
}

/**
 * Buy the cheapest fillable seat, up to `maxPayWei` (defaults to the policy cap). Returns null when
 * nothing qualifies (no basic-order listing under the cap). The SeatBuyer must already hold enough
 * bridged ETH; this only triggers the fill.
 */
export async function buyCheapestSeat(maxPayWei = POLICY.maxSeatPriceWei): Promise<{ hash: string; tokenId: bigint; cost: bigint } | null> {
  requireAddrs(["seatBuyer", "identityMd", "seatVault"]);
  const eth = ethereumSigner();
  const listings = await cheapestListings(15);
  if (!listings.length) {
    log("[seats] no live listings");
    return null;
  }
  log(`[seats] ${listings.length} listings, cheapest ~${fmt(listings[0].priceWei)} ETH`);
  for (const listing of listings) {
    // the fulfiller is the SeatBuyer contract — it's the msg.sender to Seaport
    const f = await fulfillment(listing, ADDR.seatBuyer).catch((e) => {
      warn(`[seats] fulfillment fetch failed for ${listing.orderHash.slice(0, 10)}…: ${String((e as Error).message).slice(0, 120)}`);
      return null;
    });
    if (!f) continue;
    const order = toBasicOrder(f.params);
    const v = validateOrder(order, maxPayWei);
    if (!v.ok) {
      warn(`[seats] skip ${listing.orderHash.slice(0, 10)}…: ${v.reason}`);
      continue;
    }
    // ensure the SeatBuyer is funded for this exact cost
    const bal = await eth.ethBalance(ADDR.seatBuyer);
    if (bal < v.cost) {
      log(`[seats] cheapest fillable seat costs ${fmt(v.cost)} ETH but SeatBuyer holds ${fmt(bal)} — need to bridge more`);
      return null;
    }
    log(`[seats] buying seat #${order.offerIdentifier} for ${fmt(v.cost)} ETH from ${order.offerer}`);
    const data = encodeFunctionData({ abi: seatBuyerAbi, functionName: "buySeat", args: [order as any, maxPayWei] });
    const res = await eth.send({ to: ADDR.seatBuyer, data, label: `SeatBuyer.buySeat #${order.offerIdentifier}` }, { abi: seatBuyerAbi });
    log(`[seats] bought: ${eth.explorerTx(res.hash)} (gas ${res.gasUsed})`);
    return { hash: res.hash, tokenId: order.offerIdentifier, cost: v.cost };
  }
  log("[seats] no basic-order listing under the cap this pass");
  return null;
}

/** Seats currently held by the vault (the on-chain seat count). */
export async function seatCount(): Promise<bigint> {
  requireAddrs(["identityMd", "seatVault"]);
  return ethereum().pub.readContract({ address: ADDR.identityMd, abi: erc721Abi, functionName: "balanceOf", args: [ADDR.seatVault] }) as Promise<bigint>;
}

// ---------------------------------------------------------------- CLI (needs a key; validates listings)
export async function listingsCli(): Promise<void> {
  const ls = await cheapestListings(10);
  log(`${ls.length} identity.md listings:`);
  for (const l of ls) log(`  ${fmt(l.priceWei)} ETH  ${l.orderHash}`);
}
