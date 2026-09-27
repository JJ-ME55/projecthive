/**
 * Per-chain client: a viem public client (over a rotating fallback of the configured RPCs) and,
 * when a key is supplied, a signer that sends one transaction and waits for its receipt with the
 * same lost-response recovery the payout engine uses — the tx is signed locally, its hash is known
 * before broadcast, and a dropped HTTP response is recovered by polling for that hash instead of
 * blindly re-sending (which would double-spend the nonce).
 */
import {
  createPublicClient, createWalletClient, decodeErrorResult, defineChain, fallback, formatEther, http,
  keccak256, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { POLICY } from "./config.js";
import { log, sleep } from "./util.js";

export class TxRevertedError extends Error {
  constructor(message: string, public readonly reason: string | null, public readonly receipt: TransactionReceipt | null) {
    super(message);
  }
}

export interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
  gas?: bigint; // if omitted, estimated (with the policy multiplier)
  label: string;
}

/** Decode a revert reason from any nested viem error against the given ABI (falls back to Error(string)). */
export function revertReason(err: unknown, abi?: Abi): string {
  let data: Hex | undefined;
  let cur: any = err;
  const seen = new Set<unknown>();
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const d = cur.data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) { data = d as Hex; break; }
    if (d && typeof d === "object" && typeof d.data === "string" && d.data.startsWith("0x")) { data = d.data as Hex; break; }
    cur = cur.cause;
  }
  if (data && abi) {
    try {
      const dec = decodeErrorResult({ abi, data });
      return `${dec.errorName}(${(dec.args ?? []).map(String).join(", ")})`;
    } catch { /* not in this ABI */ }
  }
  if (data?.startsWith("0x08c379a0")) {
    try {
      const dec = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], data });
      return `Error(${String(dec.args?.[0])})`;
    } catch { /* fallthrough */ }
  }
  return String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).split("\n")[0].slice(0, 200);
}

export class ChainClient {
  readonly chainId: number;
  readonly name: string;
  readonly explorer: string;
  readonly chain: ReturnType<typeof defineChain>;
  readonly pub: PublicClient;
  readonly account?: PrivateKeyAccount;
  readonly wallet?: WalletClient;

  constructor(cfg: { chainId: number; name: string; rpcUrls: string[]; explorer: string; nativeSymbol?: string }, privateKey?: Hex) {
    this.chainId = cfg.chainId;
    this.name = cfg.name;
    this.explorer = cfg.explorer;
    this.chain = defineChain({
      id: cfg.chainId,
      name: cfg.name,
      nativeCurrency: { name: cfg.nativeSymbol ?? "Ether", symbol: cfg.nativeSymbol ?? "ETH", decimals: 18 },
      rpcUrls: { default: { http: cfg.rpcUrls } },
    });
    const transport = fallback(cfg.rpcUrls.map((u) => http(u, { timeout: 30_000, retryCount: 3 })), { rank: false });
    this.pub = createPublicClient({ chain: this.chain, transport, pollingInterval: 2_000 }) as unknown as PublicClient;
    if (privateKey) {
      this.account = privateKeyToAccount(privateKey);
      this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport }) as unknown as WalletClient;
    }
  }

  get address(): Address {
    if (!this.account) throw new Error(`${this.name}: no signer configured`);
    return this.account.address;
  }

  ethBalance(addr?: Address): Promise<bigint> {
    return this.pub.getBalance({ address: addr ?? this.address });
  }

  explorerTx(hash: Hex): string {
    return `${this.explorer}/tx/${hash}`;
  }

  /** EIP-1559 fees with headroom (falls back to legacy gasPrice on chains without a base fee). */
  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const [block, gasPrice] = await Promise.all([this.pub.getBlock({ blockTag: "latest" }), this.pub.getGasPrice()]);
    let tip = 0n;
    try {
      tip = await this.pub.estimateMaxPriorityFeePerGas();
    } catch { tip = 0n; }
    const base = block.baseFeePerGas ?? gasPrice;
    const maxFeePerGas = base * 2n + tip > gasPrice * 2n ? base * 2n + tip : gasPrice * 2n;
    return { maxFeePerGas, maxPriorityFeePerGas: tip };
  }

  private async gasFor(call: Call): Promise<bigint> {
    if (call.gas) return call.gas;
    const est = await this.pub.estimateGas({ account: this.address, to: call.to, data: call.data, value: call.value ?? 0n });
    return (est * BigInt(POLICY.gasMultBps)) / 10_000n;
  }

  /**
   * Sign + broadcast one call and wait for its receipt. A reverted receipt throws TxRevertedError
   * (with the decoded reason if `abi` is given). On a lost broadcast response the pre-computed hash
   * is polled rather than re-sent.
   */
  async send(call: Call, opts: { abi?: Abi; timeoutMs?: number } = {}): Promise<{ hash: Hex; receipt: TransactionReceipt; gasUsed: bigint }> {
    if (!this.wallet || !this.account) throw new Error(`${this.name}: no signer configured`);
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const [fees, gas, nonce] = await Promise.all([
      this.fees(),
      this.gasFor(call),
      this.pub.getTransactionCount({ address: this.address, blockTag: "pending" }),
    ]);
    const maxCost = gas * fees.maxFeePerGas + (call.value ?? 0n);
    const bal = await this.ethBalance();
    if (bal < maxCost) throw new Error(`${this.name}: insufficient native balance for ${call.label}: have ${formatEther(bal)}, need up to ${formatEther(maxCost)}`);

    const serialized = await this.wallet.signTransaction({
      account: this.account,
      chain: this.chain,
      to: call.to,
      data: call.data,
      value: call.value ?? 0n,
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      type: "eip1559",
      chainId: this.chainId,
    } as any);
    const hash = keccak256(serialized);
    log(`[${this.name}] ${call.label}: nonce ${nonce}, gas ${gas}, value ${formatEther(call.value ?? 0n)}, hash ${hash}`);

    let broadcastErr: string | null = null;
    try {
      await this.pub.sendRawTransaction({ serializedTransaction: serialized });
    } catch (e) {
      // "already known" / "nonce too low" means an earlier attempt landed: fall through to the receipt poll
      broadcastErr = String((e as any)?.shortMessage ?? (e as Error).message ?? e);
      log(`[${this.name}] broadcast note for ${hash}: ${broadcastErr.slice(0, 140)} -> polling for receipt`);
    }
    const receipt = await this.waitReceipt(hash, timeoutMs);
    if (!receipt) throw new Error(`${this.name}: no receipt for ${hash} after ${timeoutMs}ms (${call.label})${broadcastErr ? `; broadcast error: ${broadcastErr.slice(0, 120)}` : ""}`);
    if (receipt.status !== "success") {
      const reason = await this.simulateRevert(call, receipt.blockNumber, opts.abi);
      throw new TxRevertedError(`${call.label} reverted in ${hash}${reason ? `: ${reason}` : ""}`, reason, receipt);
    }
    return { hash, receipt, gasUsed: receipt.gasUsed };
  }

  private async waitReceipt(hash: Hex, timeoutMs: number): Promise<TransactionReceipt | null> {
    const t0 = Date.now();
    let delay = 750;
    for (;;) {
      try {
        const r = await this.pub.getTransactionReceipt({ hash });
        if (r) return r;
      } catch { /* not mined yet */ }
      if (Date.now() - t0 > timeoutMs) return null;
      await sleep(delay);
      delay = Math.min(4_000, delay * 1.4);
    }
  }

  private async simulateRevert(call: Call, block: bigint, abi?: Abi): Promise<string | null> {
    try {
      await this.pub.call({ account: this.address, to: call.to, data: call.data, value: call.value ?? 0n, blockNumber: block });
      return null;
    } catch (e) {
      return revertReason(e, abi);
    }
  }
}
