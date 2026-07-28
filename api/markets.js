/**
 * GenesisPad public market registry (same-origin).
 *
 * Primary durable store: public GitHub Gist (survives free JSONBlob 429s).
 * Optional: GENESIS_GITHUB_TOKEN (gist scope) enables writes to the gist.
 * Fallback: JSONBlob mirrors + warm memory.
 *
 * Gist id: 1be3933a7f446c5279054e8113b6786a (0andadream)
 */

const GIST_ID = process.env.GENESIS_MARKETS_GIST_ID || "1be3933a7f446c5279054e8113b6786a";
const GIST_FILENAME = "markets.json";
const GIST_RAW =
  process.env.GENESIS_MARKETS_GIST_RAW
  || `https://gist.githubusercontent.com/0andadream/${GIST_ID}/raw/${GIST_FILENAME}`;

const SEED_MIRROR_IDS = [
  process.env.GENESIS_MARKETS_BLOB_ID,
  "019fa906-1003-7f56-8791-16529d818eb5",
  "019fa916-0e91-740e-bbe3-25c05e8299c4",
  "019fa906-0ce0-7a92-a0c9-5eefc1b69f83",
].filter(Boolean);

const JSONBLOB = "https://jsonblob.com/api/jsonBlob";

/** @type {{ markets: any[], updatedAt: number, mirrorIds: string[] }} */
let memoryBoard = { markets: [], updatedAt: 0, mirrorIds: [...SEED_MIRROR_IDS] };

function githubToken() {
  return (
    process.env.GENESIS_GITHUB_TOKEN
    || process.env.GITHUB_TOKEN
    || process.env.GH_TOKEN
    || ""
  ).trim();
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

function score(market) {
  return Number(market?.updatedAt || market?.createdAt || 0);
}

function isProbeMint(mid) {
  const id = String(mid || "");
  return (
    !id
    || id.startsWith("test-")
    || id.startsWith("ta-friend-test-")
    || id.startsWith("taDurableProbe")
    || id.startsWith("taVIS")
    || id === "cooldown"
    || id === "seed"
    || id === "seed2"
    || id === "test-mint-visibility"
  );
}

function mergeMarkets(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const market of list || []) {
      if (!market?.mintAddress || isProbeMint(market.mintAddress)) continue;
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

function blobUrl(id) {
  return `${JSONBLOB}/${id}`;
}

async function readJson(url) {
  const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
    headers: { Accept: "application/json", "User-Agent": "genesispad-registry" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GET ${response.status} ${url}`);
  }
  return response.json();
}

async function readGist() {
  try {
    // Prefer API (always latest) when token present; raw otherwise.
    const token = githubToken();
    if (token) {
      const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "genesispad-registry",
        },
        cache: "no-store",
      });
      if (response.ok) {
        const gist = await response.json();
        const file = gist.files?.[GIST_FILENAME];
        if (file?.content) {
          const data = JSON.parse(file.content);
          const markets = Array.isArray(data?.markets) ? data.markets : [];
          return { ok: true, markets, source: "gist-api" };
        }
        if (file?.raw_url) {
          const data = await readJson(file.raw_url);
          const markets = Array.isArray(data?.markets) ? data.markets : [];
          return { ok: true, markets, source: "gist-raw" };
        }
      }
    }
    const data = await readJson(GIST_RAW);
    const markets = Array.isArray(data?.markets) ? data.markets : [];
    return { ok: true, markets, source: "gist-raw" };
  } catch (reason) {
    return {
      ok: false,
      markets: [],
      error: reason instanceof Error ? reason.message : "gist read failed",
      source: "gist",
    };
  }
}

async function writeGist(markets) {
  const token = githubToken();
  if (!token) {
    return { ok: false, error: "GENESIS_GITHUB_TOKEN not set" };
  }
  const payload = {
    markets,
    updatedAt: Date.now(),
    note: "GenesisPad public market registry",
  };
  const body = JSON.stringify({
    files: {
      [GIST_FILENAME]: {
        content: JSON.stringify(payload),
      },
    },
  });
  const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "genesispad-registry",
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, error: `gist ${response.status} ${text.slice(0, 120)}` };
  }
  return { ok: true };
}

async function readBlob(id) {
  try {
    const data = await readJson(blobUrl(id));
    const markets = Array.isArray(data?.markets)
      ? data.markets
      : Array.isArray(data)
        ? data
        : [];
    return { ok: true, id, markets };
  } catch (reason) {
    return {
      ok: false,
      id,
      markets: [],
      error: reason instanceof Error ? reason.message : "blob read failed",
    };
  }
}

async function putBlob(id, payload, attempt = 1) {
  const response = await fetch(blobUrl(id), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 429 && attempt < 4) {
    await sleep(500 * attempt * attempt);
    return putBlob(id, payload, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`blob PUT ${response.status}`);
  }
  return true;
}

async function createBlob(payload, attempt = 1) {
  const response = await fetch(JSONBLOB, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.status === 429 && attempt < 4) {
    await sleep(600 * attempt * attempt);
    return createBlob(payload, attempt + 1);
  }
  if (!response.ok) throw new Error(`blob POST ${response.status}`);
  const loc = response.headers.get("location") || response.headers.get("Location") || "";
  const match = loc.match(/([0-9a-fA-F-]{36})/);
  if (!match) throw new Error("blob POST missing id");
  return match[1];
}

async function readBoard() {
  const [gist, ...blobs] = await Promise.all([
    readGist(),
    ...SEED_MIRROR_IDS.map((id) => readBlob(id)),
  ]);

  const markets = mergeMarkets(
    memoryBoard.markets,
    gist.ok ? gist.markets : [],
    ...blobs.filter((b) => b.ok).map((b) => b.markets),
  );

  memoryBoard = {
    markets,
    updatedAt: Date.now(),
    mirrorIds: [...SEED_MIRROR_IDS],
  };

  return {
    markets,
    updatedAt: Date.now(),
    gistOk: gist.ok,
    blobOk: blobs.filter((b) => b.ok).length,
    source: gist.ok ? gist.source : "mirrors",
  };
}

async function writeBoard(markets) {
  memoryBoard = {
    markets,
    updatedAt: Date.now(),
    mirrorIds: [...SEED_MIRROR_IDS],
  };

  const payload = {
    markets,
    updatedAt: Date.now(),
    note: "GenesisPad public market registry",
    mirrorIds: SEED_MIRROR_IDS,
  };

  const outcomes = [];

  // 1) Durable primary: GitHub Gist
  const gistResult = await writeGist(markets);
  outcomes.push({
    store: "gist",
    ok: gistResult.ok,
    error: gistResult.error || null,
  });

  // 2) Best-effort JSONBlob fan-out (may 429)
  for (const id of SEED_MIRROR_IDS) {
    try {
      await sleep(120);
      await putBlob(id, payload);
      outcomes.push({ store: `blob:${id.slice(0, 8)}`, ok: true });
    } catch (reason) {
      outcomes.push({
        store: `blob:${id.slice(0, 8)}`,
        ok: false,
        error: reason instanceof Error ? reason.message : "blob write failed",
      });
    }
  }

  if (!outcomes.some((o) => o.ok)) {
    try {
      const id = await createBlob(payload);
      outcomes.push({ store: `blob-create:${id.slice(0, 8)}`, ok: true });
    } catch (reason) {
      outcomes.push({
        store: "blob-create",
        ok: false,
        error: reason instanceof Error ? reason.message : "create failed",
      });
    }
  }

  const writeOk = outcomes.some((o) => o.ok);
  // Gist success is enough to call the board durable for friends worldwide.
  const durable = outcomes.some((o) => o.store === "gist" && o.ok) || writeOk;

  return {
    markets,
    updatedAt: Date.now(),
    writeOk,
    durable,
    outcomes,
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
      const data = await readBoard();
      res.status(200).json({
        markets: data.markets,
        updatedAt: data.updatedAt,
        public: true,
        mirrors: (data.gistOk ? 1 : 0) + data.blobOk,
        source: data.source,
        gist: data.gistOk,
      });
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});
      const incoming = Array.isArray(body.markets) ? body.markets : [];
      const existing = await readBoard();

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
      const written = await writeBoard(markets);

      // Confirm from durable gist/mirrors when possible.
      let confirmed = written.markets;
      try {
        const reread = await readBoard();
        confirmed = mergeMarkets(written.markets, reread.markets);
      } catch { /* keep written */ }

      memoryBoard = {
        markets: confirmed,
        updatedAt: Date.now(),
        mirrorIds: [...SEED_MIRROR_IDS],
      };

      res.status(200).json({
        markets: confirmed,
        updatedAt: Date.now(),
        public: true,
        mirrors: written.outcomes.filter((o) => o.ok).length,
        writeOk: written.writeOk,
        durable: written.durable,
        source: "api",
        writes: written.outcomes,
        tokenConfigured: Boolean(githubToken()),
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
