/** Small shared helpers: logging, sleep, JSON persistence, formatting. */
import fs from "node:fs";
import path from "node:path";

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(new Date().toISOString(), "WARN", ...args);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic replace so a crash mid-write never truncates the ledger
}

/** Serialize bigints in a plain object to decimal strings (for JSON ledgers). */
export function toJsonSafe<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** A short, human amount from wei (e.g. 1.2345 ETH) — display only, never for math. */
export function fmt(wei: bigint, decimals = 18, places = 5): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${fracStr ? "." + fracStr : ""}`;
}

/** Retry an async op with exponential backoff. Throws the last error after `attempts`. */
export async function retry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number; label?: string } = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = Math.min(15_000, baseMs * 2 ** i) + Math.random() * 200;
      if (opts.label) warn(`${opts.label} failed (attempt ${i + 1}/${attempts}): ${String((e as Error)?.message ?? e).slice(0, 160)}; retry in ${Math.round(wait)}ms`);
      if (i < attempts - 1) await sleep(wait);
    }
  }
  throw lastErr;
}

/** Fetch JSON with a timeout; throws on non-2xx with the body snippet. */
export async function fetchJson<T = any>(url: string, opts: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`non-JSON response from ${url}: ${text.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(t);
  }
}
