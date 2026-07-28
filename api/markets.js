/**
 * Same-origin public market registry for GenesisPad.
 * Proxies/merges durable JSONBlob mirrors so every visitor shares one board.
 * Server-side merge prevents one client from wiping another's launches.
 */

const MIRROR_URLS = [
  process.env.GENESIS_MARKETS_BLOB_URL,
  process.env.GENESIS_MARKETS_BLOB_URL_2,
  "https://jsonblob.com/api/jsonBlob/019fa906-0ce0-7a92-a0c9-5eefc1b69f83",
  "https://jsonblob.com/api/jsonBlob/019fa906-1003-7f56-8791-16529d818eb5",
  "https://jsonblob.com/api/jsonBlob/019fa3f5-4529-7bc8-b2ab-7ff7b640fc70",
  "https://jsonblob.com/api/jsonBlob/019fa8d5-e68c-74ed-8f39-20591b09abce",
].filter(Boolean);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

function score(market) {
  return Number(market?.updatedAt || market?.createdAt || 0);
}

function mergeMarkets(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const market of list || []) {
      if (!market?.mintAddress) continue;
      const prev = map.get(market.mintAddress);
      if (!prev || score(market) >= score(prev)) {
        map.set(market.mintAddress, market);
      }
    }
  }
  return [...map.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 100);
}

async function readMirror(url) {
  try {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404) {
      return { ok: false, markets: [], error: "404", url };
    }
    if (!response.ok) {
      return { ok: false, markets: [], error: `HTTP ${response.status}`, url };
    }
    const data = await response.json();
    const markets = Array.isArray(data?.markets)
      ? data.markets
      : Array.isArray(data)
        ? data
        : [];
    return { ok: true, markets, url };
  } catch (reason) {
    return {
      ok: false,
      markets: [],
      error: reason instanceof Error ? reason.message : "network",
      url,
    };
  }
}

async function writeMirror(url, payload) {
  const body = JSON.stringify(payload);
  let response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  });

  // Free JSONBlob boards expire; recreate when missing.
  if (response.status === 404 && url.includes("jsonblob.com")) {
    response = await fetch("https://jsonblob.com/api/jsonBlob", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`Registry create failed (${response.status}) for ${url}`);
    }
    return true;
  }

  if (!response.ok) {
    throw new Error(`Registry write failed (${response.status}) for ${url}`);
  }
  return true;
}

async function readAllMirrors() {
  const results = await Promise.all(MIRROR_URLS.map((url) => readMirror(url)));
  const ok = results.filter((r) => r.ok);
  const markets = mergeMarkets(...ok.map((r) => r.markets));
  return {
    markets,
    okCount: ok.length,
    results,
    updatedAt: Date.now(),
  };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "GET") {
      const data = await readAllMirrors();
      res.status(200).json({
        markets: data.markets,
        updatedAt: data.updatedAt,
        public: true,
        mirrors: data.okCount,
      });
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});
      const incoming = Array.isArray(body.markets) ? body.markets : [];
      const existing = await readAllMirrors();
      // Never allow an empty publish to wipe a non-empty board.
      if (!incoming.length && existing.markets.length) {
        res.status(200).json({
          markets: existing.markets,
          updatedAt: existing.updatedAt,
          public: true,
          refusedEmpty: true,
        });
        return;
      }
      const markets = mergeMarkets(existing.markets, incoming);
      const payload = {
        markets,
        updatedAt: Date.now(),
        note: "GenesisPad public market registry",
      };

      const writes = await Promise.allSettled(
        MIRROR_URLS.map((url) => writeMirror(url, payload)),
      );
      const writeOk = writes.some((w) => w.status === "fulfilled");
      if (!writeOk) {
        const reason = writes.find((w) => w.status === "rejected")?.reason;
        throw (reason instanceof Error
          ? reason
          : new Error("All registry mirrors failed to write."));
      }

      // Re-read and return authoritative public set.
      const confirmed = await readAllMirrors();
      res.status(200).json({
        markets: confirmed.markets,
        updatedAt: confirmed.updatedAt,
        public: true,
        mirrors: confirmed.okCount,
      });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (reason) {
    res.status(500).json({
      error: reason instanceof Error ? reason.message : "Registry error",
    });
  }
};
