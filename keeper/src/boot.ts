/**
 * Startup guards. Two things that turn "the vps isn't working, no idea why" into an instant answer:
 *   1. a single-instance PID lock — never two keepers racing the same nonce (F4);
 *   2. a per-lane readiness table — prints RPC health, gas balances, and exactly which lanes are
 *      ready vs. what each is still waiting on, so a misconfigured launch is obvious in seconds.
 */
import fs from "node:fs";
import path from "node:path";
import { ADDR, API, ETHEREUM, PATHS, POLICY, ROBINHOOD } from "./config.js";
import { robinhood, ethereum, robinhoodSigner, ethereumSigner } from "./clients.js";
import { log, warn } from "./util.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const fmtE = (w: bigint): string => (Number(w) / 1e18).toFixed(4);
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Acquire an exclusive PID lock; refuse to start if another LIVE keeper already holds it. */
export function acquireLock(): void {
  const lockPath = path.join(PATHS.data, "keeper.lock");
  fs.mkdirSync(PATHS.data, { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx"); // O_EXCL — fails if the file exists
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    const held = Number((fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : "").trim() || "0");
    if (held && held !== process.pid && isAlive(held)) {
      throw new Error(`another keeper is already running (pid ${held}, lock ${lockPath}) — refusing to start a second instance`);
    }
    warn(`[boot] reclaiming stale lock from dead pid ${held || "?"}`);
    fs.writeFileSync(lockPath, String(process.pid));
  }
  const release = () => { try { fs.unlinkSync(lockPath); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(0); });
  process.on("SIGTERM", () => { release(); process.exit(0); });
  log(`[boot] single-instance lock held (pid ${process.pid})`);
}

/** Probe both chains and print which lanes are ready. Never throws — informational only. */
export async function readiness(): Promise<void> {
  log("[boot] readiness:");
  const rhOk = await robinhood().pub.getBlockNumber().then(() => true).catch(() => false);
  const ethOk = await ethereum().pub.getBlockNumber().then(() => true).catch(() => false);
  log(`  rpc   robinhood(${ROBINHOOD.chainId}): ${rhOk ? "OK" : "UNREACHABLE"} | ethereum(${ETHEREUM.chainId}): ${ethOk ? "OK" : "UNREACHABLE"}`);

  let rhGas = 0n, ethGas = 0n;
  try { rhGas = await robinhoodSigner().ethBalance(); } catch {}
  try { ethGas = await ethereumSigner().ethBalance(); } catch {}
  log(`  gas   RH ${fmtE(rhGas)} ETH | ETH-eoa ${fmtE(ethGas)} ETH${ethGas < POLICY.gasReserveWei ? "  <- LOW: buy/reward lanes pay gas from this Ethereum EOA" : ""}`);

  const set = (a: string) => !!a && a !== ZERO;
  const row = (name: string, ready: boolean, needs: string) => log(`  lane  ${name.padEnd(11)} ${ready ? "READY  " : "waiting"}${ready ? "" : "  needs: " + needs}`);
  row("harvest", set(ADDR.hiveSplitter) && rhOk, "HIVE_SPLITTER + RH rpc");
  row("bridge-eth", set(ADDR.seatBuyer), "SEAT_BUYER (+ live Relay route)");
  row("buy-seat", set(ADDR.seatBuyer) && set(ADDR.seatVault) && !!API.openseaKey, "SEAT_BUYER, SEAT_VAULT, OPENSEA_API_KEY, OPENSEA_COLLECTION");
  row("bridge-imd", set(ADDR.imdRobinhood) && set(ADDR.seatVault), "IMD_ROBINHOOD, SEAT_VAULT");
  row("reward", set(ADDR.hiveStaking) && set(ADDR.imdRobinhood), "HIVE_STAKING, IMD_ROBINHOOD");
  log("  (a 'waiting' lane is skipped safely each tick until its prerequisites are set — harvest is the only one needed at launch)");
}
