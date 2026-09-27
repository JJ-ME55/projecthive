/**
 * The keeper loop. Each tick walks the flywheel, one lane at a time, isolating failures so a hiccup in
 * one lane never stalls the others:
 *
 *   1. harvest   — HiveSplitter.harvest() on Robinhood (claim Pons ETH fees + split, on-chain)
 *   2. bridge    — pool ETH from the seat-treasury float and bridge it Robinhood -> Ethereum (to SeatBuyer)
 *   3. buy       — SeatBuyer.buySeat() fills the cheapest identity.md listing (capped, collection-checked)
 *   4. earnings  — bridge seat-earned IMD (once the Safe has moved it to the keeper) Ethereum -> Robinhood
 *   5. reward    — HiveStaking.depositReward() hands the IMD to stakers pro-rata
 *
 * Custody: the seat-treasury float on Robinhood is the keeper's own hot wallet — only ever a cycle's worth
 * of ETH, and the SeatBuyer can only ever turn it into an identity.md seat in the Safe-owned vault. The
 * seats themselves and any reserve live in the Safe, which the keeper cannot touch.
 */
import { formatEther } from "viem";
import { ADDR, POLICY, printConfig } from "./config.js";
import { robinhoodSigner } from "./clients.js";
import { harvestOnce } from "./harvest.js";
import { bridgeEthToEthereum } from "./bridge.js";
import { buyCheapestSeat, seatCount } from "./seats.js";
import { bridgeEarningsBackOnce, readEarnings } from "./earnings.js";
import { depositRewardOnce } from "./reward.js";
import * as ledger from "./ledger.js";
import { fmt, log, sleep, warn } from "./util.js";

/** Run one lane, catching + recording any error so the loop continues. Returns true if it did work. */
async function lane(l: ledger.Ledger, name: ledger.LedgerEvent["lane"], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 240);
    warn(`[${name}] error: ${msg}`);
    ledger.record(l, { lane: name, detail: `error: ${msg}` });
  }
}

export async function tick(l: ledger.Ledger): Promise<void> {
  // 1. harvest
  await lane(l, "harvest", async () => {
    const h = await harvestOnce();
    if (h) {
      ledger.addHarvested(l, h.harvested);
      ledger.record(l, { lane: "harvest", detail: `claimed + split ${fmt(h.harvested)} ETH`, hashes: [h.hash], amountWei: h.harvested.toString() });
    }
  });

  // 2. bridge ETH RH -> Ethereum (the treasury float is the keeper's own RH balance, less a gas reserve)
  await lane(l, "bridge-eth", async () => {
    const rh = robinhoodSigner();
    const bal = await rh.ethBalance();
    const bridgeable = bal > POLICY.gasReserveWei ? bal - POLICY.gasReserveWei : 0n;
    if (bridgeable < POLICY.minBridgeEthWei) {
      log(`[bridge-eth] float ${fmt(bridgeable)} ETH below min ${fmt(POLICY.minBridgeEthWei)}; holding`);
      return;
    }
    const r = await bridgeEthToEthereum(bridgeable);
    ledger.record(l, { lane: "bridge-eth", detail: `bridged ${fmt(bridgeable)} ETH RH->ETH (landed=${r.landed})`, hashes: r.hashes, amountWei: bridgeable.toString() });
  });

  // 3. buy the cheapest fillable seat with whatever the SeatBuyer now holds
  await lane(l, "buy-seat", async () => {
    const bought = await buyCheapestSeat();
    if (bought) {
      ledger.addSeat(l, bought.tokenId, bought.cost, bought.hash);
      ledger.record(l, { lane: "buy-seat", detail: `bought seat #${bought.tokenId} for ${fmt(bought.cost)} ETH`, hashes: [bought.hash], amountWei: bought.cost.toString() });
    }
  });

  // 4. bridge seat-earned IMD back (only what the Safe has already moved to the keeper)
  await lane(l, "bridge-imd", async () => {
    const r = await bridgeEarningsBackOnce();
    if (r) ledger.record(l, { lane: "bridge-imd", detail: `bridged IMD ETH->RH (landed=${r.landed})`, hashes: r.hashes });
  });

  // 5. hand the IMD to stakers
  await lane(l, "reward", async () => {
    const d = await depositRewardOnce();
    if (d) {
      ledger.addRewarded(l, d.amount);
      ledger.record(l, { lane: "reward", detail: `deposited ${fmt(d.amount)} IMD to stakers`, hashes: [d.hash], amountWei: d.amount.toString() });
    }
  });
}

/** One-shot status line for logs / the dashboard. */
export async function status(): Promise<void> {
  try {
    const rh = robinhoodSigner();
    const [rhBal, seats, earn] = await Promise.all([rh.ethBalance().catch(() => 0n), seatCount().catch(() => 0n), readEarnings().catch(() => null)]);
    log(`[status] RH float ${fmt(rhBal)} ETH | seats owned ${seats}${earn ? ` | vault IMD ${fmt(earn.vaultImdWei)} | keeper IMD(eth) ${fmt(earn.keeperImdWei)}` : ""}`);
  } catch (e) {
    warn(`[status] ${String((e as Error).message).slice(0, 120)}`);
  }
}

export async function main(): Promise<void> {
  log("hive-keeper starting");
  printConfig();
  const l = ledger.load();
  for (;;) {
    const t0 = Date.now();
    await status();
    await tick(l);
    const took = Date.now() - t0;
    const wait = Math.max(0, POLICY.pollMs - took);
    log(`[loop] tick done in ${Math.round(took / 1000)}s; next in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

// run when invoked directly (npm run keeper)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("keeper.ts")) {
  main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
