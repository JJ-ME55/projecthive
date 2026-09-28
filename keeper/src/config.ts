/**
 * Keeper configuration. Everything sensitive (the signer key) and everything launch-specific
 * (the deployed contract addresses) comes from the environment; the well-known protocol
 * addresses are defaulted here. Nothing is written back — the key is read once, at startup.
 *
 * Two chains are in play:
 *   - Robinhood Chain (id 4663): where $HIVE trades, where fees accrue in the Pons escrow, where
 *     HiveSplitter.harvest() runs, and where HiveStaking pays holders in (bridged) IMD.
 *   - Ethereum mainnet (id 1): where the identity.md seats live (Seaport/OpenSea) and where the
 *     seats earn IMD.
 */
import path from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { log, warn } from "./util.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function envAddr(name: string, fallback?: Address): Address {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback ?? ZERO; // unset launch address; guarded at the point of use
  try {
    return getAddress(raw); // validate the checksum
  } catch {
    // a bad paste must NOT crash the whole process at import (pm2 crash-loop). If there's a built-in
    // default, keep it (a malformed override shouldn't discard a known-good address); else UNSET, which
    // the per-lane readiness check / requireAddrs reports clearly before that lane runs.
    warn(`${name} is not a valid checksummed address — ${fallback ? "using the built-in default" : "treating as UNSET"}; fix the env value`);
    return fallback ?? ZERO;
  }
}

function envList(name: string, fallback: string[]): string[] {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function envBig(name: string, fallback: bigint): bigint {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  return BigInt(raw);
}

function envNum(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  return raw ? Number(raw) : fallback;
}

// ---------------------------------------------------------------- chains
export const ROBINHOOD = {
  chainId: envNum("ROBINHOOD_CHAIN_ID", 4663),
  name: "Robinhood Chain",
  rpcUrls: envList("ROBINHOOD_RPC_URLS", ["https://rpc.mainnet.chain.robinhood.com", "https://rpc.ordofi.network"]),
  explorer: process.env.ROBINHOOD_EXPLORER ?? "https://robinhoodchain.blockscout.com",
} as const;

export const ETHEREUM = {
  chainId: envNum("ETHEREUM_CHAIN_ID", 1),
  name: "Ethereum",
  rpcUrls: envList("ETHEREUM_RPC_URLS", ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com", "https://rpc.ankr.com/eth"]),
  explorer: process.env.ETHEREUM_EXPLORER ?? "https://etherscan.io",
} as const;

// ---------------------------------------------------------------- addresses
export const ADDR = {
  // Robinhood side ------------------------------------------------
  /** Pons v2 fee escrow — creator ETH fees accrue here (claimed on-chain by HiveSplitter.harvest()). */
  ponsEscrow: envAddr("PONS_ESCROW", getAddress("0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e")),
  /** HiveSplitter — the $HIVE creator-fee recipient; harvest() claims + splits. Deployed pre-launch. */
  hiveSplitter: envAddr("HIVE_SPLITTER"),
  /** HiveStaking — holders stake $HIVE, earn IMD. Deployed post-launch. */
  hiveStaking: envAddr("HIVE_STAKING"),
  /** Seat treasury on Robinhood — the SEAT_BPS share of harvest() lands here as ETH, ready to bridge. */
  seatTreasuryRobinhood: envAddr("SEAT_TREASURY"),
  /** Bridged IMD on Robinhood Chain — what HiveStaking pays out. Set once the bridge route is known. */
  imdRobinhood: envAddr("IMD_ROBINHOOD"),

  // Ethereum side -------------------------------------------------
  /** identity.md seat collection (ERC-721). */
  identityMd: envAddr("IDENTITY_MD", getAddress("0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D")),
  /** $IMD token on Ethereum. */
  imd: envAddr("IMD", getAddress("0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7")),
  /** Seaport 1.6. */
  seaport: envAddr("SEAPORT", getAddress("0x0000000000000068F116a894984e2DB1123eB395")),
  /** SeatBuyer — our capped, collection-checked Seaport auto-buyer. Deployed on Ethereum. */
  seatBuyer: envAddr("SEAT_BUYER"),
  /** Seat vault (the Safe) on Ethereum — where bought seats live and earn. */
  seatVault: envAddr("SEAT_VAULT"),
} as const;

// ---------------------------------------------------------------- policy / thresholds
export const POLICY = {
  /** Don't bridge until at least this much ETH has pooled in the seat treasury (avoids dust bridge fees). */
  minBridgeEthWei: envBig("MIN_BRIDGE_ETH_WEI", 400000000000000000n), // 0.4 ETH default
  /** Native ETH the keeper keeps on Robinhood for gas (never bridged). */
  gasReserveWei: envBig("GAS_RESERVE_WEI", 10000000000000000n), // 0.01 ETH default
  /** Hard ceiling the keeper will pay for a seat (wei). MUST be <= the SeatBuyer's immutable maxSeatPrice. */
  maxSeatPriceWei: envBig("MAX_SEAT_PRICE_WEI", 2500000000000000000n), // 2.5 ETH default
  /** Only buy a seat if, after buying, ops still covers every seat for this many months (the spend rule). */
  runwayMonths: envNum("RUNWAY_MONTHS", 3),
  /** Don't deposit a staking reward smaller than this much IMD (wei) — batch tiny amounts. */
  minRewardImdWei: envBig("MIN_REWARD_IMD_WEI", 1000000000000000000n), // 1 IMD default
  /** Main loop interval. */
  pollMs: envNum("POLL_MS", 300000), // 5 min
  /** Per-transaction gas multiplier (applied to the estimate). */
  gasMultBps: envNum("GAS_MULT_BPS", 13000), // 1.3x
  /** Slippage tolerance on a bridge quote, in bps. */
  bridgeSlippageBps: envNum("BRIDGE_SLIPPAGE_BPS", 100), // 1%
  /** Abort a same-asset bridge if the destination would receive less than input × (1 - this), in bps.
   *  Backstops a hostile/misquoted Relay response: a same-asset bridge should never lose this much. */
  maxBridgeLossBps: envNum("MAX_BRIDGE_LOSS_BPS", 500), // 5%
  /** Max native ETH value the keeper will attach to an ERC-20 (IMD) bridge's origin txs (a bridge fee). */
  maxErc20BridgeNativeWei: envBig("MAX_ERC20_BRIDGE_NATIVE_WEI", 20000000000000000n), // 0.02 ETH
} as const;

// ---------------------------------------------------------------- integrations
export const API = {
  /** OpenSea API v2 key — needed to read listings + fulfillment data for identity.md. */
  openseaKey: (process.env.OPENSEA_API_KEY ?? "").trim(),
  openseaBase: process.env.OPENSEA_BASE ?? "https://api.opensea.io",
  /** identity.md earnings API (per-wallet earnings for the seat vault). */
  imdApiBase: process.env.IMD_API_BASE ?? "https://api.imd.fun",
  /** Relay bridge REST. /chains is public; /quote enforces an API key (x-api-key) on some routes. */
  relayBase: process.env.RELAY_BASE ?? "https://api.relay.link",
  relayKey: (process.env.RELAY_API_KEY ?? "").trim(),
} as const;

/** The signer. Read once; never logged, never persisted. */
export function signerKey(): Hex {
  const raw = (process.env.KEEPER_PRIVATE_KEY ?? "").trim();
  if (!raw) throw new Error("KEEPER_PRIVATE_KEY is not set (required to send transactions)");
  const key = (raw.startsWith("0x") ? raw : "0x" + raw) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("KEEPER_PRIVATE_KEY is not a 32-byte hex private key");
  return key;
}

export const PATHS = {
  data: process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
  ledger: path.join(process.env.DATA_DIR ?? path.join(process.cwd(), "data"), "ledger.json"),
} as const;

/** Which addresses must be set before a given lane can run (so we fail loudly, not silently). */
export function requireAddrs(names: (keyof typeof ADDR)[]): void {
  const missing = names.filter((n) => ADDR[n] === ZERO);
  if (missing.length) throw new Error(`missing required address(es): ${missing.join(", ")} — set them in the environment`);
}

export function printConfig(): void {
  log("Robinhood:", ROBINHOOD.chainId, ROBINHOOD.rpcUrls.join(", "));
  log("Ethereum :", ETHEREUM.chainId, ETHEREUM.rpcUrls.join(", "));
  log("addresses:");
  for (const [k, v] of Object.entries(ADDR)) log(`  ${k.padEnd(22)} ${v}${v === ZERO ? "  (UNSET)" : ""}`);
  log("policy   :", JSON.stringify(POLICY, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  log("opensea key:", API.openseaKey ? "set" : "UNSET", "| imd api:", API.imdApiBase, "| relay:", API.relayBase);
}
