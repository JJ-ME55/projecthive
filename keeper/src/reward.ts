/**
 * Lane 5 — reward. Deposit the IMD the seats earned (bridged to Robinhood Chain) into HiveStaking,
 * which distributes it pro-rata to $HIVE stakers by their loyalty-weighted stake. Approves once,
 * then depositReward(amount). Small amounts are held until they clear the min, so we don't burn
 * gas dripping dust.
 */
import { encodeFunctionData, maxUint256 } from "viem";
import { erc20Abi, hiveStakingAbi } from "./abi.js";
import { ADDR, POLICY, requireAddrs } from "./config.js";
import { robinhood, robinhoodSigner } from "./clients.js";
import { fmt, log } from "./util.js";

/** IMD held by the keeper on Robinhood, waiting to be handed to stakers. */
export async function pendingReward(): Promise<bigint> {
  requireAddrs(["imdRobinhood"]);
  const rh = robinhoodSigner();
  return rh.pub.readContract({ address: ADDR.imdRobinhood, abi: erc20Abi, functionName: "balanceOf", args: [rh.address] }) as Promise<bigint>;
}

export async function depositRewardOnce(): Promise<{ hash: string; amount: bigint } | null> {
  requireAddrs(["hiveStaking", "imdRobinhood"]);
  const rh = robinhoodSigner();
  const bal = await pendingReward();
  if (bal < POLICY.minRewardImdWei) {
    log(`[reward] IMD balance ${fmt(bal)} below min ${fmt(POLICY.minRewardImdWei)}; holding`);
    return null;
  }
  // approve HiveStaking to pull the IMD (once; approve max so subsequent deposits skip this)
  const allowance = (await rh.pub.readContract({ address: ADDR.imdRobinhood, abi: erc20Abi, functionName: "allowance", args: [rh.address, ADDR.hiveStaking] })) as bigint;
  if (allowance < bal) {
    log(`[reward] approving HiveStaking to pull IMD`);
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ADDR.hiveStaking, maxUint256] });
    await rh.send({ to: ADDR.imdRobinhood, data: approveData, label: "IMD.approve(HiveStaking)" }, { abi: erc20Abi });
  }
  log(`[reward] depositReward(${fmt(bal)} IMD) -> stakers`);
  const data = encodeFunctionData({ abi: hiveStakingAbi, functionName: "depositReward", args: [bal] });
  const res = await rh.send({ to: ADDR.hiveStaking, data, label: "HiveStaking.depositReward" }, { abi: hiveStakingAbi });
  log(`[reward] done: ${rh.explorerTx(res.hash)} (gas ${res.gasUsed})`);
  return { hash: res.hash, amount: bal };
}
