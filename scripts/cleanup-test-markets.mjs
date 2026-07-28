#!/usr/bin/env node
/**
 * Full clean-slate wipe of GenesisPad public market registries.
 *
 * Writes an empty board to:
 *  - /api/markets (live)
 *  - GitHub Gist (if GH_TOKEN / gh available)
 *  - JSONBlob mirrors (best-effort)
 *  - public/markets-board.json (local file)
 *  - public/stats.json (zeros)
 *
 * Does NOT touch: schema, wallet sessions, theme, on-chain state.
 *
 * Usage:
 *   node scripts/cleanup-test-markets.mjs --dry-run
 *   node scripts/cleanup-test-markets.mjs --confirm
 *   LIVE_API=https://genesispad.vercel.app node scripts/cleanup-test-markets.mjs --confirm
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const LIVE_API = process.env.LIVE_API || "https://genesispad.vercel.app";
const GIST_ID = process.env.GENESIS_MARKETS_GIST_ID || "1be3933a7f446c5279054e8113b6786a";
const BLOB_IDS = [
  "019fa906-1003-7f56-8791-16529d818eb5",
  "019fa916-0e91-740e-bbe3-25c05e8299c4",
  "019fa906-0ce0-7a92-a0c9-5eefc1b69f83",
  "019fa3f5-4529-7bc8-b2ab-7ff7b640fc70",
  "019fa8d5-e68c-74ed-8f39-20591b09abce",
];

const dryRun = process.argv.includes("--dry-run");
const confirm = process.argv.includes("--confirm");

const emptyBoard = () => ({
  markets: [],
  updatedAt: Date.now(),
  note: "GenesisPad public market registry — clean slate",
  wipedAt: new Date().toISOString(),
  // Required so /api/markets accepts an empty board (refuses accidental empties).
  forceEmpty: true,
  wipe: true,
});

const emptyStats = () => ({
  volume: 0,
  tvl: 0,
  trades: 0,
  markets: 0,
  graduated: 0,
  users: 0,
});

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "User-Agent": "genesispad-cleanup",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { ok: response.ok, status: response.status, data };
}

async function countMarkets(label, url) {
  try {
    const { ok, status, data } = await fetchJson(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
    if (!ok) return { label, status, count: null, error: true };
    const markets = Array.isArray(data?.markets)
      ? data.markets
      : Array.isArray(data)
        ? data
        : [];
    return { label, status, count: markets.length, error: false };
  } catch (reason) {
    return { label, status: 0, count: null, error: String(reason) };
  }
}

async function putJson(url, payload) {
  return fetchJson(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function ghToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GENESIS_GITHUB_TOKEN) {
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GENESIS_GITHUB_TOKEN;
  }
  try {
    return execSync("gh auth token", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function wipeGist(payload) {
  const token = ghToken();
  if (!token) {
    return { ok: false, status: 0, data: { error: "No GitHub token (gh auth token / GH_TOKEN)" } };
  }
  return fetchJson(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "genesispad-cleanup",
    },
    body: JSON.stringify({
      files: {
        "markets.json": {
          content: JSON.stringify(payload),
        },
      },
    }),
  });
}

async function main() {
  console.log("GenesisPad market cleanup");
  console.log(dryRun ? "MODE: dry-run (no writes)" : confirm ? "MODE: confirm (destructive)" : "MODE: missing flag");
  console.log("");

  if (!dryRun && !confirm) {
    console.error("Refusing to run without --dry-run or --confirm");
    process.exit(1);
  }

  console.log("=== BEFORE ===");
  const before = [];
  before.push(await countMarkets("api", `${LIVE_API}/api/markets`));
  before.push(await countMarkets(
    "gist-raw",
    `https://gist.githubusercontent.com/0andadream/${GIST_ID}/raw/markets.json`,
  ));
  for (const id of BLOB_IDS) {
    before.push(await countMarkets(`blob:${id.slice(0, 13)}`, `https://jsonblob.com/api/jsonBlob/${id}`));
  }
  for (const row of before) {
    console.log(
      `  ${row.label}: ${row.error ? `ERROR ${row.error === true ? row.status : row.error}` : `${row.count} markets`}`,
    );
  }

  const payload = emptyBoard();
  const stats = emptyStats();

  if (dryRun) {
    console.log("\nDry-run only. Would write empty board to api/gist/blobs + local files.");
    return;
  }

  console.log("\n=== WRITING EMPTY BOARD ===");

  // 1) Live API
  {
    const result = await putJson(`${LIVE_API}/api/markets`, payload);
    console.log(`  api PUT → ${result.status} ok=${result.ok} markets=${result.data?.markets?.length}`);
  }

  // 2) Gist
  {
    const result = await wipeGist(payload);
    console.log(`  gist PATCH → ${result.status} ok=${result.ok}`);
    if (!result.ok) console.log(`    ${JSON.stringify(result.data).slice(0, 200)}`);
  }

  // 3) JSONBlob mirrors
  for (const id of BLOB_IDS) {
    const url = `https://jsonblob.com/api/jsonBlob/${id}`;
    const result = await putJson(url, payload);
    console.log(`  blob ${id.slice(0, 13)} PUT → ${result.status} ok=${result.ok}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // 4) Local static files
  const boardPath = join(root, "public/markets-board.json");
  const statsPath = join(root, "public/stats.json");
  await writeFile(boardPath, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`  wrote ${boardPath}`);
  console.log(`  wrote ${statsPath}`);

  // Brief settle, then verify
  await new Promise((r) => setTimeout(r, 800));
  console.log("\n=== AFTER ===");
  const after = [];
  after.push(await countMarkets("api", `${LIVE_API}/api/markets`));
  after.push(await countMarkets(
    "gist-raw",
    `https://gist.githubusercontent.com/0andadream/${GIST_ID}/raw/markets.json`,
  ));
  for (const id of BLOB_IDS) {
    after.push(await countMarkets(`blob:${id.slice(0, 13)}`, `https://jsonblob.com/api/jsonBlob/${id}`));
  }
  let dirty = false;
  for (const row of after) {
    const line = row.error
      ? `  ${row.label}: ERROR ${row.error === true ? row.status : row.error}`
      : `  ${row.label}: ${row.count} markets`;
    console.log(line);
    if (!row.error && row.count !== 0) dirty = true;
  }

  // local file check
  const localBoard = JSON.parse(await readFile(boardPath, "utf8"));
  console.log(`  local markets-board.json: ${localBoard.markets?.length ?? "?"} markets`);
  if ((localBoard.markets?.length || 0) !== 0) dirty = true;

  if (dirty) {
    console.error("\nWARNING: some stores still report markets. Re-run or inspect manually.");
    process.exit(2);
  }
  console.log("\nClean slate verified on reachable stores.");
}

main().catch((reason) => {
  console.error(reason);
  process.exit(1);
});
