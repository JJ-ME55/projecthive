/**
 * Find a real historical identity.md sale that went through Seaport via a basic-order function, and
 * dump its BasicOrderParameters to a fixture. A Foundry fork test then forks mainnet just before that
 * block and replays the *real signed order* through SeatBuyer — the final proof the fill works end to
 * end, using an order Seaport already accepted (no order construction, no signing).
 *
 * Usage: tsx scripts/find-seaport-sale.ts [lookbackBlocks] [chunk]
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, decodeFunctionData, fallback, http, getAddress, type Address, type Hex } from "viem";
import { ADDR, ETHEREUM } from "../src/config.js";
import { log } from "../src/util.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
// both Seaport basic-order entrypoints take (BasicOrderParameters); we accept either as a source of params
const BASIC_SELECTORS = new Set(["0xfb0f3ee1" /* fulfillBasicOrder */, "0x00000000" /* fulfillBasicOrder_efficient_6GL6yc */]);
const SEAPORT_16 = getAddress("0x0000000000000068F116a894984e2DB1123eB395");
const SEAPORT_15 = getAddress("0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC");

const basicOrderTuple = {
  name: "parameters", type: "tuple", components: [
    { name: "considerationToken", type: "address" }, { name: "considerationIdentifier", type: "uint256" }, { name: "considerationAmount", type: "uint256" },
    { name: "offerer", type: "address" }, { name: "zone", type: "address" }, { name: "offerToken", type: "address" },
    { name: "offerIdentifier", type: "uint256" }, { name: "offerAmount", type: "uint256" }, { name: "basicOrderType", type: "uint8" },
    { name: "startTime", type: "uint256" }, { name: "endTime", type: "uint256" }, { name: "zoneHash", type: "bytes32" }, { name: "salt", type: "uint256" },
    { name: "offererConduitKey", type: "bytes32" }, { name: "fulfillerConduitKey", type: "bytes32" }, { name: "totalOriginalAdditionalRecipients", type: "uint256" },
    { name: "additionalRecipients", type: "tuple[]", components: [{ name: "amount", type: "uint256" }, { name: "recipient", type: "address" }] }, { name: "signature", type: "bytes" },
  ],
} as const;

// Both entrypoints carry the identical BasicOrderParameters; the _efficient_ name is mined so its
// selector is 0x00000000. Declaring both with the full tuple lets decodeFunctionData handle either.
const basicOrderAbi = [
  { type: "function", name: "fulfillBasicOrder", stateMutability: "payable", outputs: [{ type: "bool" }], inputs: [basicOrderTuple] },
  { type: "function", name: "fulfillBasicOrder_efficient_6GL6yc", stateMutability: "payable", outputs: [{ type: "bool" }], inputs: [basicOrderTuple] },
] as const;

async function main() {
  const lookback = Number(process.argv[2] ?? 300_000); // ~6 weeks of mainnet
  const chunk = Number(process.argv[3] ?? 900);
  const pub = createPublicClient({ chain: undefined as any, transport: fallback(ETHEREUM.rpcUrls.map((u) => http(u, { timeout: 30_000 }))) });
  const head = Number(await pub.getBlockNumber());
  const from = head - lookback;
  log(`identity.md ${ADDR.identityMd} — scanning transfers in [${from}, ${head}] (${lookback} blocks, ${chunk}/chunk)`);

  let scanned = 0, transfers = 0, sales = 0;
  for (let a = head; a >= from; a -= chunk) {
    const b = a;
    const lo = Math.max(from, a - chunk + 1);
    let logs: any[] = [];
    try {
      const raw = await pub.getLogs({ address: ADDR.identityMd as Address, fromBlock: BigInt(lo), toBlock: BigInt(b) });
      logs = raw.filter((l: any) => l.topics?.[0] === TRANSFER_TOPIC);
    } catch {
      // some public nodes cap ranges; skip this chunk and continue
      continue;
    }
    scanned += b - lo + 1;
    transfers += logs.length;
    const txHashes = [...new Set(logs.map((l) => l.transactionHash as Hex))];
    for (const h of txHashes) {
      const tx = await pub.getTransaction({ hash: h }).catch(() => null);
      if (!tx || !tx.to) continue;
      const to = getAddress(tx.to);
      if (to !== SEAPORT_16 && to !== SEAPORT_15) continue;
      const sel = (tx.input.slice(0, 10)) as string;
      if (!BASIC_SELECTORS.has(sel)) continue;
      // decode the params
      try {
        const dec = decodeFunctionData({ abi: basicOrderAbi, data: tx.input });
        const p: any = (dec.args as any)?.[0];
        if (!p || getAddress(p.offerToken) !== ADDR.identityMd) continue;
        sales++;
        const fixture = {
          note: "real historical identity.md Seaport basic-order sale — replay on a fork of block-1",
          txHash: h,
          block: Number(tx.blockNumber),
          seaport: to,
          selector: sel,
          tokenId: p.offerIdentifier.toString(),
          seller: p.offerer,
          costWei: (p.considerationAmount + (p.additionalRecipients ?? []).reduce((s: bigint, r: any) => s + r.amount, 0n)).toString(),
          parameters: JSON.parse(JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
        };
        const out = path.join(process.cwd(), "test", "fixtures");
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, "real-order.json"), JSON.stringify(fixture, null, 2));
        log(`FOUND sale: token #${fixture.tokenId} for ${Number(BigInt(fixture.costWei)) / 1e18} ETH at block ${fixture.block} (tx ${h})`);
        log(`  wrote test/fixtures/real-order.json — fork at block ${fixture.block - 1} and replay`);
        return;
      } catch { /* not a clean basic order (efficient variant needs manual slice) */ }
    }
    if (scanned % (chunk * 20) < chunk) log(`  …scanned ${scanned} blocks, ${transfers} transfers, ${sales} basic-order sales so far`);
  }
  log(`done: ${transfers} transfers over ${scanned} blocks, no clean fulfillBasicOrder sale found (identity.md sales may use advanced orders / the efficient variant)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
