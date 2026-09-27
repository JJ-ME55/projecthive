/** Durable keeper state: what's been harvested, bridged, bought and paid out, so a restart resumes cleanly. */
import { PATHS } from "./config.js";
import { readJson, toJsonSafe, writeJson } from "./util.js";

export interface LedgerEvent {
  ts: string;
  lane: "harvest" | "bridge-eth" | "buy-seat" | "bridge-imd" | "reward" | "note";
  detail: string;
  hashes?: string[];
  amountWei?: string;
}

export interface Ledger {
  updated: string;
  seatsBought: { tokenId: string; costWei: string; hash: string; ts: string }[];
  totalHarvestedWei: string;
  totalRewardedWei: string;
  events: LedgerEvent[];
}

const EMPTY: Ledger = { updated: "", seatsBought: [], totalHarvestedWei: "0", totalRewardedWei: "0", events: [] };

export function load(): Ledger {
  return readJson<Ledger>(PATHS.ledger, EMPTY);
}

export function save(l: Ledger): void {
  l.updated = new Date().toISOString();
  writeJson(PATHS.ledger, toJsonSafe(l));
}

export function record(l: Ledger, ev: Omit<LedgerEvent, "ts">): void {
  l.events.unshift({ ts: new Date().toISOString(), ...ev });
  if (l.events.length > 500) l.events.length = 500;
  save(l);
}

export function addSeat(l: Ledger, tokenId: bigint, costWei: bigint, hash: string): void {
  l.seatsBought.unshift({ tokenId: tokenId.toString(), costWei: costWei.toString(), hash, ts: new Date().toISOString() });
  save(l);
}

export function addHarvested(l: Ledger, wei: bigint): void {
  l.totalHarvestedWei = (BigInt(l.totalHarvestedWei) + wei).toString();
  save(l);
}

export function addRewarded(l: Ledger, wei: bigint): void {
  l.totalRewardedWei = (BigInt(l.totalRewardedWei) + wei).toString();
  save(l);
}
