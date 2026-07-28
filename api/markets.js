/**
 * GenesisPad public market registry (same-origin).
 *
 * Clients ONLY talk to this endpoint.
 * Storage: JSONBlob mirrors with:
 *  - sequential writes + 429 backoff
 *  - POST-create fallback when PUTs are rate-limited
 *  - mirrorIds discovery inside the payload so new blobs become known
 *  - warm-instance memory as last-resort L1
 */

const SEED_MIRROR_IDS = [
  process.env.GENESIS_MARKETS_BLOB_ID,
  process.env.GENESIS_MARKETS_BLOB_ID_2,
  // Fresh primary (rotated when free-tier rate limits kill older IDs).
  "019fa916-0e91-740e-bbe3-25c05e8299c4",
  "019fa906-0ce0-7a92-a0c9-5eefc1b69f83",
  "019fa906-1003-7f56-8791-16529d818eb5",
].filter(Boolean);

const JSONBLOB = "https://jsonblob.com/api/jsonBlob";

/** @type {{ markets: any[], updatedAt: number, mirrorIds: string[] }} */
let memoryBoard = { markets: [], updatedAt: 0, mirrorIds: [...SEED_MIRROR_IDS] };

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
      // Drop ephemeral probes
      const mid = String(market.mintAddress);
      if (
        mid.startsWith("test-")
        || mid.startsWith("ta-friend-test-")
        || mid === "cooldown"
        || mid === "seed"
        || mid === "seed2"
      ) {
        continue;
      }
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

function collectMirrorIds(...sources) {
  const ids = new Set(SEED_MIRROR_IDS);
  for (const id of memoryBoard.mirrorIds || []) {
    if (id) ids.add(id);
  }
  for (const src of sources) {
    if (!src) continue;
    if (Array.isArray(src.mirrorIds)) {
      for (const id of src.mirrorIds) if (id) ids.add(String(id));
    }
    if (src.primaryId) ids.add(String(src.primaryId));
  }
  return [...ids];
}

async function readBlob(id) {
  const url = blobUrl(id);
  try {
    const response = await fetch(`${url}?t=${Date.now()}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      return { ok: false, id, error: String(response.status), markets: [], mirrorIds: [] };
    }
    const data = await response.json();
    const markets = Array.isArray(data?.markets)
      ? data.markets
      : Array.isArray(data)
        ? data
        : [];
    const mirrorIds = Array.isArray(data?.mirrorIds) ? data.mirrorIds.map(String) : [];
    if (data?.primaryId) mirrorIds.push(String(data.primaryId));
    return { ok: true, id, markets, mirrorIds, updatedAt: data?.updatedAt || 0 };
  } catch (reason) {
    return {
      ok: false,
      id,
      error: reason instanceof Error ? reason.message : "network",
      markets: [],
      mirrorIds: [],
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
    // Expired — create a replacement.
    return createBlob(payload);
  }
  if (!response.ok) {
    throw new Error(`PUT ${id.slice(0, 8)}… failed (${response.status})`);
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
  if (!response.ok) {
    throw new Error(`POST create failed (${response.status})`);
  }
  const loc = response.headers.get("location") || response.headers.get("Location") || "";
  const match = loc.match(/([0-9a-fA-F-]{36})/);
  if (!match) {
    // Some gateways return the body only.
    try {
      const data = await response.json();
      if (data?.id) return { id: String(data.id), created: true };
    } catch { /* ignore */ }
    throw new Error("POST create succeeded but no blob id returned");
  }
  return { id: match[1], created: true };
}

async function readBoard() {
  // First pass on known IDs.
  let ids = collectMirrorIds();
  let results = await Promise.all(ids.map((id) => readBlob(id)));

  // Learn additional mirror IDs from payloads and fetch those too.
  const learned = new Set(ids);
  for (const r of results) {
    for (const id of r.mirrorIds || []) learned.add(id);
  }
  const extra = [...learned].filter((id) => !ids.includes(id));
  if (extra.length) {
    const more = await Promise.all(extra.map((id) => readBlob(id)));
    results = results.concat(more);
    ids = [...learned];
  }

  const ok = results.filter((r) => r.ok);
  const markets = mergeMarkets(
    memoryBoard.markets,
    ...ok.map((r) => r.markets),
  );
  const mirrorIds = collectMirrorIds(
    memoryBoard,
    ...ok.map((r) => ({ mirrorIds: r.mirrorIds, primaryId: r.id })),
  );

  memoryBoard = {
    markets,
    updatedAt: Date.now(),
    mirrorIds,
  };

  return {
    markets,
    mirrorIds,
    okCount: ok.length,
    updatedAt: Date.now(),
    errors: results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.error}`),
  };
}

async function writeBoard(markets) {
  const mirrorIds = collectMirrorIds(memoryBoard);
  const payload = {
    markets,
    updatedAt: Date.now(),
    note: "GenesisPad public market registry",
    mirrorIds,
    primaryId: mirrorIds[0] || null,
  };

  // Always update warm memory first so this instance can serve friends immediately.
  memoryBoard = {
    markets,
    updatedAt: payload.updatedAt,
    mirrorIds,
  };

  const outcomes = [];
  let anyOk = false;

  // 1) Try PUT to every known mirror, spaced out to avoid 429 storms.
  for (const id of mirrorIds) {
    try {
      await sleep(150);
      const result = await putBlob(id, payload);
      outcomes.push({ id: result.id, ok: true, created: result.created });
      anyOk = true;
      if (result.created && !mirrorIds.includes(result.id)) {
        mirrorIds.unshift(result.id);
        payload.mirrorIds = mirrorIds;
        payload.primaryId = result.id;
        memoryBoard.mirrorIds = mirrorIds;
      }
    } catch (reason) {
      outcomes.push({
        id,
        ok: false,
        error: reason instanceof Error ? reason.message : "write failed",
      });
    }
  }

  // 2) If every PUT failed, POST a brand-new blob (often works during 429 on old IDs).
  if (!anyOk) {
    try {
      const created = await createBlob(payload);
      mirrorIds.unshift(created.id);
      payload.mirrorIds = mirrorIds;
      payload.primaryId = created.id;
      memoryBoard.mirrorIds = mirrorIds;
      // Write again so payload includes the new id.
      try {
        await putBlob(created.id, payload);
      } catch { /* create body already had markets */ }
      outcomes.push({ id: created.id, ok: true, created: true });
      anyOk = true;
    } catch (reason) {
      outcomes.push({
        id: "create",
        ok: false,
        error: reason instanceof Error ? reason.message : "create failed",
      });
    }
  }

  // Memory always has the board even if free mirrors are angry.
  memoryBoard = {
    markets,
    updatedAt: Date.now(),
    mirrorIds,
  };

  return {
    markets,
    mirrorIds,
    writeOk: anyOk,
    outcomes,
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
      const data = await readBoard();
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

      // Re-read best-effort; never drop the board we just accepted.
      let confirmed = written.markets;
      try {
        const reread = await readBoard();
        confirmed = mergeMarkets(written.markets, reread.markets);
      } catch { /* keep written */ }

      memoryBoard = {
        markets: confirmed,
        updatedAt: Date.now(),
        mirrorIds: written.mirrorIds,
      };

      res.status(200).json({
        markets: confirmed,
        updatedAt: Date.now(),
        public: true,
        mirrors: written.outcomes.filter((o) => o.ok).length,
        writeOk: written.writeOk,
        source: "api",
        // If writeOk is false, board is still served from memory on this instance;
        // clients should still treat API body as success when mint is present.
        durable: written.writeOk,
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
