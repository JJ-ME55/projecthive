/**
 * Lanes 2 & 4 — the cross-chain bridge. Seats live on Ethereum; fees accrue on Robinhood Chain.
 * Both legs move the *same* asset (ETH one way, IMD the other), so this is a same-asset bridge,
 * not a swap. We use Relay (https://relay.link): a quote returns ready-to-send transactions for the
 * origin chain, and a requestId to poll until the funds land on the destination.
 *
 * OPEN AT LAUNCH: confirm Relay supports Robinhood Chain (id 4663). `relayChains()` / the `quote`
 * CLI answer that against the live API. If Relay doesn't cover 4663, this file is the only thing
 * that changes — swap the adapter for the canonical Arbitrum-Orbit bridge (slower) or Across.
 */
import { type Address, type Hex } from "viem";
import { API, POLICY } from "./config.js";
import { fetchJson, fmt, log, sleep, warn } from "./util.js";

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

/** Relay request headers — includes the API key when one is configured (higher limits / gated routes). */
function relayHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (json) h["content-type"] = "application/json";
  if (API.relayKey) h["x-api-key"] = API.relayKey;
  return h;
}

export interface BridgeQuote {
  requestId?: string;
  steps: { to: Address; data: Hex; value: bigint; chainId: number }[];
  expectedOutWei: bigint;
  feeWei: bigint;
  raw: any;
}

/** The chains Relay currently supports (id + name). Used to verify Robinhood Chain is routable. */
export async function relayChains(): Promise<{ id: number; name: string }[]> {
  const r = await fetchJson<any>(`${API.relayBase}/chains`, { headers: relayHeaders(), timeoutMs: 20_000 });
  const chains = (r.chains ?? r ?? []) as any[];
  return chains.map((c) => ({ id: Number(c.id ?? c.chainId), name: String(c.name ?? c.displayName ?? "") }));
}

export async function assertRouteSupported(originChainId: number, destChainId: number): Promise<void> {
  const chains = await relayChains();
  const ids = new Set(chains.map((c) => c.id));
  const missing = [originChainId, destChainId].filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`Relay does not list chain(s) ${missing.join(", ")} — bridge route unsupported (see relayChains())`);
}

/**
 * Ask Relay for a same-asset transfer quote. `user` and `recipient` are usually the keeper on the
 * origin and the destination address (SeatBuyer for ETH, the keeper for IMD). Amounts in wei.
 */
export async function quoteBridge(args: {
  originChainId: number;
  destChainId: number;
  originCurrency: Address;
  destCurrency: Address;
  amountWei: bigint;
  user: Address;
  recipient: Address;
}): Promise<BridgeQuote> {
  const body = {
    user: args.user,
    recipient: args.recipient,
    originChainId: args.originChainId,
    destinationChainId: args.destChainId,
    originCurrency: args.originCurrency,
    destinationCurrency: args.destCurrency,
    amount: args.amountWei.toString(),
    tradeType: "EXACT_INPUT",
    referrer: "hive-keeper",
  };
  const r = await fetchJson<any>(`${API.relayBase}/quote`, {
    method: "POST",
    headers: relayHeaders(true),
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });

  // Relay returns steps[].items[].data as the transactions to send on the origin chain.
  const steps: BridgeQuote["steps"] = [];
  for (const step of r.steps ?? []) {
    for (const item of step.items ?? []) {
      const d = item.data ?? {};
      if (d.to && d.data) steps.push({ to: d.to as Address, data: d.data as Hex, value: BigInt(d.value ?? "0"), chainId: Number(d.chainId ?? args.originChainId) });
    }
  }
  const details = r.details ?? {};
  const expectedOutWei = BigInt(details.currencyOut?.amount ?? details.currencyOut?.amountRaw ?? "0");
  const feeWei = BigInt(details.totalImpact?.amount ?? r.fees?.relayer?.amount ?? "0");
  const requestId = r.steps?.[0]?.requestId ?? r.requestId ?? details.requestId;
  if (!steps.length) throw new Error(`Relay quote returned no executable steps: ${JSON.stringify(r).slice(0, 300)}`);
  return { requestId, steps, expectedOutWei, feeWei, raw: r };
}

/** Poll Relay for the status of a bridge request until it settles (or times out). */
export async function waitBridge(requestId: string, timeoutMs = 20 * 60_000): Promise<"success" | "failure" | "timeout"> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetchJson<any>(`${API.relayBase}/intents/status?requestId=${requestId}`, { headers: relayHeaders(), timeoutMs: 20_000 });
      const status = String(r.status ?? "").toLowerCase();
      if (status === "success" || status === "filled" || status === "complete") return "success";
      if (status === "failure" || status === "refund" || status === "expired") return "failure";
      log(`[bridge] request ${requestId.slice(0, 10)}… status=${status || "pending"}`);
    } catch (e) {
      warn(`[bridge] status poll error: ${String((e as Error).message).slice(0, 120)}`);
    }
    await sleep(15_000);
  }
  return "timeout";
}

/** Apply the slippage floor to a quoted output (what we'll accept as landed). */
export function minAcceptable(expectedOutWei: bigint): bigint {
  return (expectedOutWei * BigInt(10_000 - POLICY.bridgeSlippageBps)) / 10_000n;
}

/** Send every step tx of a quote on the origin chain (in order) and return their hashes. */
export async function executeBridge(quote: BridgeQuote): Promise<{ hashes: string[]; requestId?: string }> {
  const { robinhood, ethereum } = await import("./clients.js");
  const hashes: string[] = [];
  for (const [i, step] of quote.steps.entries()) {
    // pick the signer for the step's chain (Relay always sends the origin-chain txs)
    const chain = step.chainId === ROBINHOOD_ID() ? robinhood() : step.chainId === ETHEREUM_ID() ? ethereum() : null;
    if (!chain) throw new Error(`bridge step ${i} targets unknown chain ${step.chainId}`);
    if (!chain.wallet) throw new Error(`no signer for chain ${step.chainId}`);
    const res = await chain.send({ to: step.to, data: step.data, value: step.value, label: `bridge step ${i + 1}/${quote.steps.length}` });
    hashes.push(res.hash);
    log(`[bridge] step ${i + 1} sent: ${chain.explorerTx(res.hash)}`);
  }
  return { hashes, requestId: quote.requestId };
}

function ROBINHOOD_ID(): number {
  return Number(process.env.ROBINHOOD_CHAIN_ID ?? 4663);
}
function ETHEREUM_ID(): number {
  return Number(process.env.ETHEREUM_CHAIN_ID ?? 1);
}

/** Bridge ETH from Robinhood Chain to the SeatBuyer on Ethereum (lane 2). Blocks until it lands. */
export async function bridgeEthToEthereum(amountWei: bigint): Promise<{ hashes: string[]; expectedOutWei: bigint; landed: boolean }> {
  const { robinhoodSigner } = await import("./clients.js");
  const { ADDR, ROBINHOOD, ETHEREUM } = await import("./config.js");
  const keeper = robinhoodSigner().address;
  const recipient = ADDR.seatBuyer; // ETH lands directly in the buyer, ready to fill a listing
  const quote = await quoteBridge({ originChainId: ROBINHOOD.chainId, destChainId: ETHEREUM.chainId, originCurrency: NATIVE, destCurrency: NATIVE, amountWei, user: keeper, recipient });
  log(`[bridge] ${fmt(amountWei)} ETH RH -> ~${fmt(quote.expectedOutWei)} ETH on Ethereum -> SeatBuyer`);
  const sent = await executeBridge(quote);
  const status = sent.requestId ? await waitBridge(sent.requestId) : "timeout";
  return { hashes: sent.hashes, expectedOutWei: quote.expectedOutWei, landed: status === "success" };
}

/** Bridge IMD the keeper holds on Ethereum back to the keeper on Robinhood Chain (lane 4). */
export async function bridgeImdToRobinhood(amountWei: bigint): Promise<{ hashes: string[]; expectedOutWei: bigint; landed: boolean }> {
  const { ethereumSigner } = await import("./clients.js");
  const { ADDR, ROBINHOOD, ETHEREUM } = await import("./config.js");
  const keeperEth = ethereumSigner().address;
  const quote = await quoteBridge({ originChainId: ETHEREUM.chainId, destChainId: ROBINHOOD.chainId, originCurrency: ADDR.imd, destCurrency: ADDR.imdRobinhood, amountWei, user: keeperEth, recipient: keeperEth });
  log(`[bridge] ${fmt(amountWei)} IMD Ethereum -> ~${fmt(quote.expectedOutWei)} IMD on RH -> keeper`);
  const sent = await executeBridge(quote);
  const status = sent.requestId ? await waitBridge(sent.requestId) : "timeout";
  return { hashes: sent.hashes, expectedOutWei: quote.expectedOutWei, landed: status === "success" };
}

// ---------------------------------------------------------------- CLI (read-only; validates the live API)
export async function quoteCli(): Promise<void> {
  const { ROBINHOOD, ETHEREUM, ADDR } = await import("./config.js");
  log("Relay: checking supported chains…");
  const chains = await relayChains();
  const rh = chains.find((c) => c.id === ROBINHOOD.chainId);
  const eth = chains.find((c) => c.id === ETHEREUM.chainId);
  log(`  Ethereum (${ETHEREUM.chainId}): ${eth ? "supported (" + eth.name + ")" : "NOT LISTED"}`);
  log(`  Robinhood (${ROBINHOOD.chainId}): ${rh ? "supported (" + rh.name + ")" : "NOT LISTED — bridge route needs a different adapter"}`);
  if (!rh || !eth) {
    log(`Relay lists ${chains.length} chains; a same-asset ETH bridge to/from Robinhood Chain via Relay is only possible if both are listed.`);
    return;
  }
  const probe = process.env.PROBE_ADDR as Address | undefined;
  if (!probe) {
    log("Set PROBE_ADDR=0x… to fetch a live 0.5 ETH RH→ETH quote.");
    return;
  }
  const q = await quoteBridge({
    originChainId: ROBINHOOD.chainId,
    destChainId: ETHEREUM.chainId,
    originCurrency: NATIVE,
    destCurrency: NATIVE,
    amountWei: 500000000000000000n,
    user: probe,
    recipient: ADDR.seatBuyer !== NATIVE ? ADDR.seatBuyer : probe,
  });
  log(`Quote: 0.5 ETH RH -> ~${fmt(q.expectedOutWei)} ETH on Ethereum (fee ~${fmt(q.feeWei)}), ${q.steps.length} tx step(s), requestId ${q.requestId ?? "n/a"}`);
}

export { NATIVE };
