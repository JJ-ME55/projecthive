/**
 * Lane 1 — harvest. Call HiveSplitter.harvest() on Robinhood Chain: it claims the $HIVE creator
 * fees from the Pons escrow (native ETH) and splits them seat/ops/team on-chain. Permissionless —
 * the keeper only pays gas; the money never passes through the keeper's wallet.
 */
import { encodeFunctionData, type Address } from "viem";
import { hiveSplitterAbi, ponsEscrowAbi } from "./abi.js";
import { ADDR, requireAddrs } from "./config.js";
import { robinhood, robinhoodSigner } from "./clients.js";
import { fmt, log } from "./util.js";

/** ETH waiting to be harvested = escrow balance credited to the splitter + anything already in the splitter. */
export async function pendingHarvest(): Promise<{ escrow: bigint; splitter: bigint; total: bigint }> {
  requireAddrs(["hiveSplitter"]);
  const rh = robinhood();
  const [escrow, splitter] = await Promise.all([
    rh.pub.readContract({ address: ADDR.ponsEscrow, abi: ponsEscrowAbi, functionName: "balanceOf", args: [ADDR.hiveSplitter] }) as Promise<bigint>,
    rh.ethBalance(ADDR.hiveSplitter as Address),
  ]);
  return { escrow, splitter, total: escrow + splitter };
}

export async function harvestOnce(): Promise<{ hash: string; harvested: bigint } | null> {
  const before = await pendingHarvest();
  if (before.total === 0n) {
    log("[harvest] nothing to harvest (escrow + splitter both empty)");
    return null;
  }
  log(`[harvest] escrow ${fmt(before.escrow)} ETH + splitter ${fmt(before.splitter)} ETH pending -> harvest()`);
  const rh = robinhoodSigner();
  const data = encodeFunctionData({ abi: hiveSplitterAbi, functionName: "harvest" });
  const res = await rh.send({ to: ADDR.hiveSplitter, data, label: "HiveSplitter.harvest" }, { abi: hiveSplitterAbi });
  log(`[harvest] done: ${rh.explorerTx(res.hash)} (gas ${res.gasUsed})`);
  return { hash: res.hash, harvested: before.total };
}
