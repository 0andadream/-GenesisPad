/**
 * Same-origin public market registry for GenesisPad.
 *
 * Clients should ONLY talk to this endpoint. We merge server-side and fan out
 * to JSONBlob mirrors with retries (free jsonblob 429s easily when the browser
 * hammers multiple blobs directly).
 */

const MIRROR_URLS = [
  process.env.GENESIS_MARKETS_BLOB_URL,
  process.env.GENESIS_MARKETS_BLOB_URL_2,
  "https://jsonblob.com/api/jsonBlob/019fa906-0ce0-7a92-a0c9-5eefc1b69f83",
  "https://jsonblob.com/api/jsonBlob/019fa906-1003-7f56-8791-16529d818eb5",
].filter(Boolean);

/** Warm-instance memory so a 429 on every mirror does not erase the board mid-session. */
let memoryBoard = { markets: [], updatedAt: 0 };

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
    .slice(0, 120);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readMirror(url) {
  try {
    const response = await fetch(`${url}?t=${Date.now()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 404) {
      return { ok: false, markets: [], error: "404", url };
    }
    if (response.status === 429) {
      return { ok: false, markets: [], error: "429", url };
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

async function writeMirror(url, payload, attempt = 1) {
  const body = JSON.stringify(payload);
  let response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  });

  if (response.status === 429 && attempt < 4) {
    await sleep(350 * attempt * attempt);
    return writeMirror(url, payload, attempt + 1);
  }

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
      throw new Error(`Registry create failed (${response.status})`);
    }
    return true;
  }

  if (!response.ok) {
    throw new Error(`Registry write failed (${response.status})`);
  }
  return true;
}

async function readAllMirrors() {
  const results = await Promise.all(MIRROR_URLS.map((url) => readMirror(url)));
  const ok = results.filter((r) => r.ok);
  const markets = mergeMarkets(memoryBoard.markets, ...ok.map((r) => r.markets));
  // Keep warm memory filled with the best known board.
  if (markets.length) {
    memoryBoard = { markets, updatedAt: Date.now() };
  }
  return {
    markets,
    okCount: ok.length,
    errors: results.filter((r) => !r.ok).map((r) => `${r.url}: ${r.error}`),
    updatedAt: Date.now(),
  };
}

async function writeAllMirrors(payload) {
  // Sequential writes + spacing to avoid jsonblob 429 storms.
  const outcomes = [];
  for (const url of MIRROR_URLS) {
    try {
      await writeMirror(url, payload);
      outcomes.push({ url, ok: true });
    } catch (reason) {
      outcomes.push({
        url,
        ok: false,
        error: reason instanceof Error ? reason.message : "write failed",
      });
    }
    await sleep(120);
  }
  return outcomes;
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
        source: "api",
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
          source: "api",
        });
        return;
      }

      const markets = mergeMarkets(existing.markets, incoming);
      const payload = {
        markets,
        updatedAt: Date.now(),
        note: "GenesisPad public market registry",
      };

      // Memory is always updated so subsequent GETs on this instance see the mint
      // even if every free mirror is rate-limited.
      memoryBoard = { markets, updatedAt: payload.updatedAt };

      const writeOutcomes = await writeAllMirrors(payload);
      const writeOk = writeOutcomes.some((w) => w.ok);

      // Prefer re-read, but never drop the just-merged board if mirrors are 429'd.
      let confirmed = markets;
      let mirrors = writeOutcomes.filter((w) => w.ok).length;
      try {
        const reread = await readAllMirrors();
        confirmed = mergeMarkets(markets, reread.markets);
        mirrors = Math.max(mirrors, reread.okCount);
        memoryBoard = { markets: confirmed, updatedAt: Date.now() };
      } catch {
        confirmed = markets;
      }

      res.status(200).json({
        markets: confirmed,
        updatedAt: Date.now(),
        public: true,
        mirrors,
        writeOk,
        source: "api",
        writes: writeOutcomes,
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
