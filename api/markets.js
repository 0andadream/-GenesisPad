/**
 * Public Genesis market registry.
 * Proxies a shared JSONBlob so every visitor sees the same launches and can trade.
 * Merge is last-write-wins per mintAddress (by updatedAt/createdAt).
 */

const DEFAULT_BLOB =
  process.env.GENESIS_MARKETS_BLOB_URL ||
  "https://jsonblob.com/api/jsonBlob/019fa3f5-4529-7bc8-b2ab-7ff7b640fc70";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function mergeMarkets(a = [], b = []) {
  const map = new Map();
  for (const market of [...a, ...b]) {
    if (!market?.mintAddress) continue;
    const prev = map.get(market.mintAddress);
    const score = (m) => Number(m.updatedAt || m.createdAt || 0);
    if (!prev || score(market) >= score(prev)) map.set(market.mintAddress, market);
  }
  return [...map.values()]
    .sort((x, y) => Number(y.createdAt || 0) - Number(x.createdAt || 0))
    .slice(0, 100);
}

async function readBlob(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (response.status === 404) return { markets: [], updatedAt: 0, blobUrl: url };
  if (!response.ok) throw new Error(`Registry read failed (${response.status})`);
  const data = await response.json();
  return {
    markets: Array.isArray(data.markets) ? data.markets : [],
    updatedAt: data.updatedAt || 0,
    blobUrl: url,
  };
}

async function writeBlob(url, payload) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 404) {
    const created = await fetch("https://jsonblob.com/api/jsonBlob", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!created.ok) throw new Error(`Registry create failed (${created.status})`);
    const location = created.headers.get("location");
    return {
      ...payload,
      blobUrl: location
        ? new URL(location, "https://jsonblob.com").toString()
        : url,
    };
  }
  if (!response.ok) throw new Error(`Registry write failed (${response.status})`);
  return { ...payload, blobUrl: url };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "GET") {
      const data = await readBlob(DEFAULT_BLOB);
      res.status(200).json({
        markets: data.markets,
        updatedAt: data.updatedAt || Date.now(),
        public: true,
      });
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const incoming = Array.isArray(body.markets) ? body.markets : [];
      const existing = await readBlob(DEFAULT_BLOB);
      const markets = mergeMarkets(existing.markets, incoming);
      const payload = { markets, updatedAt: Date.now() };
      await writeBlob(DEFAULT_BLOB, payload);
      res.status(200).json({ ...payload, public: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (reason) {
    res.status(500).json({
      error: reason instanceof Error ? reason.message : "Registry error",
    });
  }
};
