/**
 * GenesisPad public market registry (same-origin).
 *
 * No GitHub login required.
 * Server merges all publishes, keeps warm memory, and fans out to JSONBlob
 * mirrors (with retries). Optional GENESIS_GITHUB_TOKEN still upgrades Gist
 * durability in the background, but is not required for public launches.
 *
 * Friend visibility depends on durable mirrors — never treat a successful
 * publish as complete unless at least one durable store accepts the write.
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
  "019fa8d5-e68c-74ed-8f39-20591b09abce",
].filter(Boolean);

const JSONBLOB = "https://jsonblob.com/api/jsonBlob";

/** @type {{ markets: any[], updatedAt: number, wipedAt: number }} */
let memoryBoard = { markets: [], updatedAt: 0, wipedAt: 0 };

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

/** Accept epoch ms or ISO strings from older wipe payloads. */
function parseTime(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(String(value));
  return Number.isFinite(asDate) ? asDate : 0;
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

/**
 * Deep-merge two market records for the same mint.
 * Critical: never drop bonding-curve privateKeyHex / tokenAccount when a
 * newer partial update (chart-only) overwrites a complete launch record —
 * without the key, buys/sells fail with "no bonding curve".
 */
function mergeTwoMarkets(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const newer = score(next) >= score(prev) ? next : prev;
  const older = newer === next ? prev : next;
  const curveA = prev.curve || null;
  const curveB = next.curve || null;
  let curve = null;
  if (curveA || curveB) {
    const pick = (curveA?.privateKeyHex ? curveA : null)
      || (curveB?.privateKeyHex ? curveB : null)
      || curveA
      || curveB;
    const other = pick === curveA ? curveB : curveA;
    curve = {
      ...(other || {}),
      ...(pick || {}),
      privateKeyHex: curveA?.privateKeyHex || curveB?.privateKeyHex || pick?.privateKeyHex,
      tokenAccount: curveA?.tokenAccount || curveB?.tokenAccount || pick?.tokenAccount,
      address: curveA?.address || curveB?.address || pick?.address,
      virtualThru: pick?.virtualThru ?? other?.virtualThru,
      virtualToken: pick?.virtualToken ?? other?.virtualToken,
      realThru: (() => {
        try {
          const a = BigInt(curveA?.realThru || "0");
          const b = BigInt(curveB?.realThru || "0");
          return (a >= b ? curveA?.realThru : curveB?.realThru) ?? pick?.realThru;
        } catch {
          return pick?.realThru ?? other?.realThru;
        }
      })(),
      realToken: (() => {
        try {
          const a = BigInt(curveA?.realToken || "0");
          const b = BigInt(curveB?.realToken || "0");
          return (a >= b ? curveA?.realToken : curveB?.realToken) ?? pick?.realToken;
        } catch {
          return pick?.realToken ?? other?.realToken;
        }
      })(),
      graduationTargetThru: pick?.graduationTargetThru || other?.graduationTargetThru,
      tradeFeeBps: pick?.tradeFeeBps ?? other?.tradeFeeBps,
    };
  }
  return {
    ...older,
    ...newer,
    createdAt: older.createdAt || newer.createdAt,
    updatedAt: Math.max(score(prev), score(next)),
    image: newer.image || older.image || "",
    curve,
    graduated: Boolean(prev.graduated || next.graduated),
    liquidity: prev.liquidity || next.liquidity || false,
    chart: Array.isArray(newer.chart) && newer.chart.length
      ? newer.chart
      : (Array.isArray(older.chart) ? older.chart : []),
  };
}

function mergeMarkets(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const market of list || []) {
      if (!market?.mintAddress || isProbeMint(market.mintAddress)) continue;
      const prev = map.get(market.mintAddress);
      map.set(market.mintAddress, prev ? mergeTwoMarkets(prev, market) : market);
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

function boardPayload(markets, { wipe = false } = {}) {
  const now = Date.now();
  return {
    markets,
    updatedAt: now,
    note: wipe
      ? "GenesisPad public market registry — clean slate"
      : "GenesisPad public market registry",
    // Always write explicit booleans so a lagging wipe flag cannot stick.
    wipe: Boolean(wipe),
    forceEmpty: Boolean(wipe),
    wipedAt: wipe ? now : 0,
  };
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
    return {
      ok: true,
      markets,
      wipe: Boolean(data?.wipe || data?.forceEmpty),
      updatedAt: parseTime(data?.updatedAt),
      wipedAt: parseTime(data?.wipedAt || data?.updatedAt),
    };
  } catch (reason) {
    return {
      ok: false,
      markets: [],
      wipe: false,
      updatedAt: 0,
      wipedAt: 0,
      error: reason instanceof Error ? reason.message : "gist read failed",
    };
  }
}

async function writeGist(payload) {
  const token = githubToken();
  if (!token) return { ok: false, error: "no-token" };
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
    return {
      ok: true,
      id,
      markets,
      wipe: Boolean(data?.wipe || data?.forceEmpty),
      updatedAt: parseTime(data?.updatedAt),
      wipedAt: parseTime(data?.wipedAt || data?.updatedAt),
    };
  } catch (reason) {
    return {
      ok: false,
      id,
      markets: [],
      wipe: false,
      updatedAt: 0,
      wipedAt: 0,
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
  // JSONBlob free tier 429s easily — back off hard so publishes stick.
  if (response.status === 429 && attempt < 8) {
    await sleep(600 * attempt * attempt);
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

/**
 * Read durable stores.
 *
 * Clean-slate wipe drops deleted tokens, but must NOT erase a just-published
 * market when mirrors still lag on the old wipe payload (that caused tokens
 * to flash on Explore then vanish).
 */
async function readBoard() {
  const [gist, ...blobs] = await Promise.all([
    readGist(),
    ...SEED_MIRROR_IDS.map((id) => readBlob(id)),
  ]);

  const durableSources = [
    gist.ok ? gist : null,
    ...blobs.filter((b) => b.ok),
  ].filter(Boolean);

  const durableOk = durableSources.length > 0;
  const blobSources = blobs.filter((b) => b.ok);

  // Newest explicit wipe from blob mirrors only (gist often cannot be cleared).
  let newestWipeAt = 0;
  let wipeVotes = 0;
  for (const s of blobSources) {
    const empty = !s.markets || mergeMarkets(s.markets).length === 0;
    if (s.wipe && empty) {
      wipeVotes += 1;
      newestWipeAt = Math.max(
        newestWipeAt,
        parseTime(s.wipedAt || s.updatedAt),
      );
    }
  }
  // Need consensus (or sole reachable mirror) so one lagging wipe blob cannot
  // erase a fresh publish that already landed on other mirrors / memory.
  const wipeConsensus = wipeVotes > 0 && wipeVotes >= Math.ceil(Math.max(blobSources.length, 1) / 2);
  if (!wipeConsensus) newestWipeAt = 0;

  // Non-empty durable markets. Prefer post-wipe sources; also accept any
  // non-empty blob that is not itself an empty wipe (publish cleared wipe).
  const postWipeLists = [];
  for (const s of durableSources) {
    const live = mergeMarkets(s.markets);
    if (!live.length) continue;
    const ts = parseTime(s.updatedAt || s.wipedAt);
    if (newestWipeAt && ts && ts <= newestWipeAt && s.wipe) continue;
    // Non-empty board without wipe flag always counts (new publish).
    if (s.wipe && newestWipeAt && ts <= newestWipeAt) continue;
    postWipeLists.push(live);
  }

  const durableMarkets = mergeMarkets(...postWipeLists);
  const durableUpdatedAt = Math.max(
    0,
    ...durableSources.map((s) => parseTime(s.updatedAt)),
  );

  // Memory markets newer than wipe (just published on this instance).
  let memoryMarkets = memoryBoard.markets || [];
  if (newestWipeAt > 0) {
    memoryMarkets = memoryMarkets.filter(
      (m) => parseTime(m?.updatedAt || m?.createdAt) > newestWipeAt,
    );
  }

  // True clean slate: wipe consensus, no durable markets, no fresh memory.
  if (newestWipeAt > 0 && durableMarkets.length === 0 && memoryMarkets.length === 0) {
    memoryBoard = {
      markets: [],
      updatedAt: Math.max(newestWipeAt, Date.now()),
      wipedAt: newestWipeAt,
    };
    return {
      markets: [],
      updatedAt: memoryBoard.updatedAt,
      gistOk: gist.ok,
      blobOk: blobSources.length,
      durable: true,
      wiped: true,
    };
  }

  const markets = mergeMarkets(memoryMarkets, durableMarkets);
  memoryBoard = {
    markets,
    updatedAt: Math.max(memoryBoard.updatedAt || 0, durableUpdatedAt, Date.now()),
    // Keep wipe watermark only when board is still empty after it.
    wipedAt: markets.length ? 0 : (newestWipeAt || memoryBoard.wipedAt || 0),
  };

  return {
    markets,
    updatedAt: memoryBoard.updatedAt,
    gistOk: gist.ok,
    blobOk: blobSources.length,
    durable: durableOk,
    wiped: false,
  };
}

async function writeBoard(markets, { wipe = false } = {}) {
  const now = Date.now();
  memoryBoard = {
    markets,
    updatedAt: now,
    wipedAt: wipe ? now : memoryBoard.wipedAt || 0,
  };

  const payload = boardPayload(markets, { wipe });
  const outcomes = [];

  // Optional Gist upgrade (only if server token is configured).
  const gistResult = await writeGist(payload);
  outcomes.push({ store: "gist", ok: gistResult.ok, error: gistResult.error || null });

  // JSONBlob mirrors — sequential to avoid free-tier 429 storms that leave
  // partial boards (tokens flash then vanish when some mirrors lag).
  const blobResults = [];
  for (let index = 0; index < SEED_MIRROR_IDS.length; index += 1) {
    const id = SEED_MIRROR_IDS[index];
    if (index > 0) await sleep(350);
    try {
      await putBlob(id, payload);
      blobResults.push({ store: `blob:${id.slice(0, 8)}`, ok: true });
    } catch (reason) {
      try {
        await sleep(800 + 400 * index);
        await putBlob(id, payload);
        blobResults.push({ store: `blob:${id.slice(0, 8)}`, ok: true, retried: true });
      } catch (retryReason) {
        blobResults.push({
          store: `blob:${id.slice(0, 8)}`,
          ok: false,
          error: retryReason instanceof Error
            ? retryReason.message
            : reason instanceof Error ? reason.message : "blob write failed",
        });
      }
    }
  }
  outcomes.push(...blobResults);
  let anyBlobOk = blobResults.some((r) => r.ok);

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

  const durable = gistResult.ok || anyBlobOk;
  return {
    markets,
    updatedAt: now,
    writeOk: true,
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
        durable: Boolean(data.durable),
        wiped: Boolean(data.wiped),
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
          durable: true,
          source: "api",
        });
        return;
      }

      const markets = forceEmpty && !incoming.length
        ? []
        : mergeMarkets(existing.markets, incoming);
      const written = await writeBoard(markets, { wipe: forceEmpty && !incoming.length });

      // After an explicit wipe, do not re-merge stale durable/memory into the response.
      let confirmed = written.markets;
      if (!forceEmpty || incoming.length) {
        try {
          // Prefer durable re-read so friends hitting other instances see the same board.
          const reread = await readBoard();
          confirmed = mergeMarkets(written.markets, reread.markets);
          memoryBoard = {
            markets: confirmed,
            updatedAt: Date.now(),
            wipedAt: memoryBoard.wipedAt || 0,
          };
        } catch {
          confirmed = written.markets;
        }
      } else {
        memoryBoard = { markets: [], updatedAt: Date.now(), wipedAt: Date.now() };
        confirmed = [];
      }

      // Publish is only "durable" when mirrors accepted the write. Clients that
      // requireMint should retry when durable is false.
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
