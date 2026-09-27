/**
 * Seat earnings. The seats earn IMD to the vault (the Safe that owns them). Per the security model the
 * keeper is operator-not-owner, so it does NOT move funds out of the vault — that's a Safe action. What
 * the keeper does automatically: (1) detect + report the vault's earnings (on-chain IMD balance + the
 * imd.fun earnings API), and (2) once IMD has been moved to the keeper's own Ethereum address, bridge it
 * back to Robinhood for HiveStaking. The one semi-manual hop (vault -> keeper) keeps seat custody in the
 * multisig; everything on either side of it is automated.
 */
import { type Address } from "viem";
import { erc20Abi } from "./abi.js";
import { ADDR, API, POLICY, requireAddrs } from "./config.js";
import { ethereum, ethereumSigner } from "./clients.js";
import { bridgeImdToRobinhood } from "./bridge.js";
import { fetchJson, fmt, log } from "./util.js";

export interface EarningsSnapshot {
  vaultImdWei: bigint; // IMD sitting in the vault (earned, not yet moved)
  keeperImdWei: bigint; // IMD in the keeper's Ethereum wallet (ready to bridge back)
  apiTotalImd: number | null; // lifetime earnings per the imd.fun API (display)
}

export async function readEarnings(): Promise<EarningsSnapshot> {
  requireAddrs(["imd", "seatVault"]);
  const eth = ethereum();
  const [vault, keeper] = await Promise.all([
    eth.pub.readContract({ address: ADDR.imd, abi: erc20Abi, functionName: "balanceOf", args: [ADDR.seatVault] }) as Promise<bigint>,
    ethBalanceOfKeeperImd(),
  ]);
  let apiTotal: number | null = null;
  try {
    const r = await fetchJson<any>(`${API.imdApiBase}/wallets/${ADDR.seatVault}/earnings`, { timeoutMs: 20_000 });
    const t = r.total ?? r.totalEarnings ?? r.earnings?.total;
    if (t != null) apiTotal = Number(t);
  } catch { /* API optional / best-effort */ }
  return { vaultImdWei: vault, keeperImdWei: keeper, apiTotalImd: apiTotal };
}

async function ethBalanceOfKeeperImd(): Promise<bigint> {
  if (!process.env.KEEPER_PRIVATE_KEY) return 0n;
  const eth = ethereumSigner();
  return eth.pub.readContract({ address: ADDR.imd, abi: erc20Abi, functionName: "balanceOf", args: [eth.address as Address] }) as Promise<bigint>;
}

/** If the keeper holds enough IMD on Ethereum, bridge it back to Robinhood for the reward lane. */
export async function bridgeEarningsBackOnce(): Promise<{ hashes: string[]; landed: boolean } | null> {
  requireAddrs(["imd", "imdRobinhood"]);
  const held = await ethBalanceOfKeeperImd();
  if (held < POLICY.minRewardImdWei) {
    log(`[earnings] keeper holds ${fmt(held)} IMD on Ethereum, below min ${fmt(POLICY.minRewardImdWei)}; holding`);
    return null;
  }
  log(`[earnings] bridging ${fmt(held)} IMD Ethereum -> Robinhood`);
  const r = await bridgeImdToRobinhood(held);
  return { hashes: r.hashes, landed: r.landed };
}
