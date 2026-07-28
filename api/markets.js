/**
 * GenesisPad public market registry (same-origin).
 *
 * No GitHub login required.
 * Server merges all publishes, keeps warm memory, and fans out to JSONBlob
 * mirrors (with retries). Optional GENESIS_GITHUB_TOKEN still upgrades Gist
 * durability in the background, but is not required for public launches.
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
  "019fa3f5-4529-7bc8-b2ab-7ff7b640fc70",
  "019fa8d5-e68c-74ed-8f39-20591b09abce",
].filter(Boolean);

const JSONBLOB = "https://jsonblob.com/api/jsonBlob";

/** @type {{ markets: any[], updatedAt: number }} */
let memoryBoard = { markets: [], updatedAt: 0 };

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
  if (!response.ok) throw new Error(`GET ${response.status}`);
  return response.json();
}

async function readGist() {
  try {
    const data = await readJson(GIST_RAW);
    const markets = Array.isArray(data?.markets) ? data.markets : [];
    return { ok: true, markets };
  } catch (reason) {
    return {
      ok: false,
      markets: [],
      error: reason instanceof Error ? reason.message : "gist read failed",
    };
  }
}

async function writeGist(markets) {
  const token = githubToken();
  if (!token) return { ok: false, error: "no-token" };
  const payload = {
    markets,
    updatedAt: Date.now(),
    note: "GenesisPad public market registry",
  };
  const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "genesispad-registry",
    },
    body: JSON.stringify({
      files: {
        [GIST_FILENAME]: { content: JSON.stringify(payload) },
      },
    }),
  });
  if (!response.ok) {
    return { ok: false, error: `gist ${response.status}` };
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
  if (response.status === 429 && attempt < 5) {
    await sleep(400 * attempt * attempt);
    return putBlob(id, payload, attempt + 1);
  }
  if (response.status === 404) {
    return createBlob(payload);
  }
  if (!response.ok) {
    throw new Error(`blob PUT ${response.status}`);
  }
  return { id, created: false };
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
  if (response.status === 429 && attempt < 5) {
    await sleep(500 * attempt * attempt);
    return createBlob(payload, attempt + 1);
  }
  if (!response.ok) throw new Error(`blob POST ${response.status}`);
  const loc = response.headers.get("location") || response.headers.get("Location") || "";
  const match = loc.match(/([0-9a-fA-F-]{36})/);
  if (!match) throw new Error("blob POST missing id");
  return { id: match[1], created: true };
}

async function readBoard() {
  const [gist, ...blobs] = await Promise.all([
    readGist(),
    ...SEED_MIRROR_IDS.map((id) => readBlob(id)),
  ]);

  const durableOk = gist.ok || blobs.some((b) => b.ok);
  const durableMarkets = mergeMarkets(
    gist.ok ? gist.markets : [],
    ...blobs.filter((b) => b.ok).map((b) => b.markets),
  );

  // If durable stores are reachable and empty, trust that over stale warm memory
  // (otherwise a wiped board keeps reappearing on old serverless instances).
  if (durableOk && durableMarkets.length === 0) {
    memoryBoard = { markets: [], updatedAt: Date.now() };
    return {
      markets: [],
      updatedAt: Date.now(),
      gistOk: gist.ok,
      blobOk: blobs.filter((b) => b.ok).length,
    };
  }

  const markets = mergeMarkets(memoryBoard.markets, durableMarkets);
  memoryBoard = { markets, updatedAt: Date.now() };

  return {
    markets,
    updatedAt: Date.now(),
    gistOk: gist.ok,
    blobOk: blobs.filter((b) => b.ok).length,
  };
}

async function writeBoard(markets) {
  // Always keep warm memory so this instance serves the new mint immediately.
  memoryBoard = { markets, updatedAt: Date.now() };

  const payload = {
    markets,
    updatedAt: Date.now(),
    note: "GenesisPad public market registry",
  };

  const outcomes = [];

  // Optional Gist upgrade (only if server token is configured).
  const gistResult = await writeGist(markets);
  outcomes.push({ store: "gist", ok: gistResult.ok, error: gistResult.error || null });

  // JSONBlob mirrors — best effort, sequential to reduce 429s.
  let anyBlobOk = false;
  for (const id of SEED_MIRROR_IDS) {
    try {
      await sleep(100);
      await putBlob(id, payload);
      outcomes.push({ store: `blob:${id.slice(0, 8)}`, ok: true });
      anyBlobOk = true;
    } catch (reason) {
      outcomes.push({
        store: `blob:${id.slice(0, 8)}`,
        ok: false,
        error: reason instanceof Error ? reason.message : "blob write failed",
      });
    }
  }

  if (!anyBlobOk && !gistResult.ok) {
    try {
      const created = await createBlob(payload);
      outcomes.push({ store: `blob-create:${created.id.slice(0, 8)}`, ok: true });
      anyBlobOk = true;
    } catch (reason) {
      outcomes.push({
        store: "blob-create",
        ok: false,
        error: reason instanceof Error ? reason.message : "create failed",
      });
    }
  }

  // Public publish is accepted if we returned a merged board with the mint.
  // Memory always has it; mirrors/gist are best-effort durability.
  return {
    markets,
    updatedAt: Date.now(),
    writeOk: true,
    durable: gistResult.ok || anyBlobOk,
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
        source: "api",
      });
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string"
        ? JSON.parse(req.body || "{}")
        : (req.body || {});
      const incoming = Array.isArray(body.markets) ? body.markets : [];
      const forceEmpty = Boolean(body.forceEmpty || body.wipe);
      const existing = await readBoard();

      // Refuse accidental empty publishes, but allow explicit launch clean-slate wipes.
      if (!incoming.length && existing.markets.length && !forceEmpty) {
        res.status(200).json({
          markets: existing.markets,
          updatedAt: existing.updatedAt,
          public: true,
          refusedEmpty: true,
          source: "api",
        });
        return;
      }

      const markets = forceEmpty && !incoming.length
        ? []
        : mergeMarkets(existing.markets, incoming);
      const written = await writeBoard(markets);

      // After an explicit wipe, do not re-merge stale durable/memory into the response.
      let confirmed = written.markets;
      if (!forceEmpty || incoming.length) {
        try {
          const reread = await readBoard();
          confirmed = mergeMarkets(written.markets, reread.markets);
          memoryBoard = { markets: confirmed, updatedAt: Date.now() };
        } catch {
          confirmed = written.markets;
        }
      } else {
        memoryBoard = { markets: [], updatedAt: Date.now() };
        confirmed = [];
      }

      res.status(200).json({
        markets: confirmed,
        updatedAt: Date.now(),
        public: true,
        mirrors: written.outcomes.filter((o) => o.ok).length,
        writeOk: true,
        durable: written.durable,
        wiped: Boolean(forceEmpty && !incoming.length),
        source: "api",
        writes: written.outcomes,
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
