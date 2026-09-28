// Live identity.md floor from OpenSea. Set OPENSEA_API_KEY (and optionally OPENSEA_COLLECTION,
// default "identitymd") in the Vercel project env. Returns { ok, floorEth }. The site falls back to
// a static figure when this isn't configured yet, so it's safe to deploy before the key exists.
export default async function handler(req, res) {
  const key = process.env.OPENSEA_API_KEY;
  const slug = process.env.OPENSEA_COLLECTION || "identitymd";
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=600");
  if (!key) {
    res.status(200).json({ ok: false, reason: "no OPENSEA_API_KEY" });
    return;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000); // never hang to the function limit
    const r = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, {
      headers: { "x-api-key": key, accept: "application/json" },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!r.ok) {
      res.status(200).json({ ok: false, reason: `opensea ${r.status}` });
      return;
    }
    const j = await r.json();
    const floorEth = j?.total?.floor_price ?? null;
    res.status(200).json({ ok: floorEth != null, floorEth });
  } catch (e) {
    res.status(200).json({ ok: false, reason: "floor unavailable" });
  }
}
