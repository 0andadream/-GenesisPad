import { AccountView, ConsensusStatus, Pubkey, createThruClient } from "@thru/sdk";
import {
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferInstruction,
  deriveMintAddress,
  deriveTokenAccountAddress,
  parseTokenAccountData,
} from "@thru/programs/token";
import {
  AMM_LP_DECIMALS,
  createAddLiquidityInstruction,
  createInitPoolInstruction,
  createSwapInstruction,
  deriveAmmPoolAddresses,
} from "@thru/programs/amm";

/** Explore board state — sort / age / search are live. */
let marketSort = "recent";
let marketAge = "all";
let marketQuery = "";
let registryLiveAt = 0;
let registrySyncing = false;
/** Wrap page: "wrap" | "unwrap" — hoisted so balance refresh always sees it. */
let wrapSide = "wrap";
/** Assets available to send from the wallet (native, wTHRU, held mints). */
let walletSendAssets = [];

const THEME_KEY = "genesis-theme";

function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = next === "dark" ? "#121211" : "#eeeeec";
  document.querySelectorAll("[data-theme-icon]").forEach((el) => {
    el.textContent = next === "dark" ? "☀" : "☾";
  });
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    const toLight = next === "dark";
    btn.setAttribute("aria-label", toLight ? "Switch to light mode" : "Switch to dark mode");
    btn.title = toLight ? "Light mode" : "Dark mode";
  });
}

function initTheme() {
  applyTheme(getPreferredTheme());
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      applyTheme(current === "dark" ? "light" : "dark");
    });
  });
}

initTheme();

document.querySelectorAll("[role='tablist'] button").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.filter) {
      marketSort = button.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.filter === marketSort);
      });
      renderMarkets();
      return;
    }
    if (button.dataset.age) {
      marketAge = button.dataset.age;
      document.querySelectorAll("[data-age]").forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.age === marketAge);
      });
      renderMarkets();
      return;
    }
    // Generic tablists (wrap side, trade side, chart intervals, etc.)
    button.parentElement.querySelectorAll("button").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
  });
});

const search = document.querySelector("[data-search]");
search?.addEventListener("input", () => {
  marketQuery = search.value.trim();
  renderMarkets();
});

const connectButtons = [...document.querySelectorAll("[data-wallet-open]")];
const createButton = document.querySelector("[data-create]");
const createStatus = document.querySelector("[data-create-status]");
const walletModal = document.querySelector("[data-wallet-modal]");
const entryView = document.querySelector("[data-wallet-entry]");
const walletViews = [...document.querySelectorAll("[data-view]")];
const client = createThruClient({
  baseUrl: "https://rpc.alphanet.thru.org",
  transportOptions: { useBinaryFormat: true, defaultTimeoutMs: 30000 },
});
const FAUCET_VAULT = "taxoImN8fTEOxXYnvgC6JZ0lN0n0qvZERwz_vlOjX3MkIn";
const CHAIN_ID = 1;
// Alphanet faucet program max is 10_000 base units per withdraw (0.00001 THRU).
const FAUCET_AMOUNT = 10_000n;
const FAUCET_CLAIMS_PER_CLICK = 25;
const TOKEN_PROGRAM = "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq";
const WTHRU_PROGRAM = "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcH";
const WTHRU_MINT = "tacdgTUGud8OgzN5HnVVv4u3x82UBe8ciZAtjOLJZE_SNg";
const WTHRU_VAULT = "tavBundQnIZaeuFuzQyydWytISqLWedn49iLRXsBj085lN";
const GENESIS_TREASURY = "taiaYuGAgf-2J9upK3T_SqH4f6Q7eqtABqw3MjsS7ZR6rK";
const GENESIS_AMM_PROGRAM =
  "tahM1VfE9ZRxbFaNTk179HY6lR1j8zyutW2CkD2YQxoCLt";
const NATIVE_THRU_DECIMALS = 9;
const WTHRU_DECIMALS = 8;
const CREATOR_FEE_BPS = 21;
const PROTOCOL_FEE_BPS = 9;
const PRICE_TOKENS_PER_THRU = 500n;
// Native THRU transfers use the all-zero system program.
const EOA_PROGRAM = new Uint8Array(32);
// Opening a new fee-payer account (state-proof create) uses the EOA program at 0x…03.
// Using zeros here is why curve vault open failed with VM -765 / code 1.
const EOA_CREATE_PROGRAM = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 3 : 0));
const FAUCET_PROGRAM = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 250 : 0);
const AMM_MINIMUM_LIQUIDITY = 1000n;
// Bonding curve (alphanet scale).
// Virtual THRU sets the starting price; 80% of supply sits on the curve.
const CURVE_VIRTUAL_THRU = 50_000_000n; // 0.05 THRU virtual reserve
const CURVE_TOKEN_BPS = 8000n; // 80% of minted supply on the curve
const CURVE_TRADE_FEE_BPS = 100n; // 1% fee on buys/sells
// Graduate after this much real THRU is bought into the curve (faucet-friendly).
const GRADUATION_REAL_THRU = 2_000_000n; // 0.002 THRU raised
const CURVE_GAS_FUND = 50_000n; // native dust so the curve account can pay fees
// Native EOA transfers charge this fee in the transaction header (must leave headroom).
const NATIVE_TRANSFER_FEE = 1n;
let connectedAccount = null;
let generatedAccount = null;
const WALLET_SESSION_KEY = "genesis-thru-wallet-session";
// Bumped when deleted test boards reappeared from old localStorage + mirrors.
const MARKETS_KEY = "genesis-markets-v4";
// Public board: same-origin API is primary; JSONBlob mirrors are the durable
// backup so friends always share the same launches without GitHub login.
// Serverless memory alone is not enough — cold instances must hit mirrors.
const MARKET_REGISTRY_API = "/api/markets";
const MARKET_BLOB_IDS = [
  "019fa906-1003-7f56-8791-16529d818eb5",
  "019fa916-0e91-740e-bbe3-25c05e8299c4",
  "019fa906-0ce0-7a92-a0c9-5eefc1b69f83",
  "019fa8d5-e68c-74ed-8f39-20591b09abce",
];
const MARKET_BLOB_URLS = MARKET_BLOB_IDS.map(
  (id) => `https://jsonblob.com/api/jsonBlob/${id}`,
);
const MARKET_GIST_RAW =
  "https://gist.githubusercontent.com/0andadream/1be3933a7f446c5279054e8113b6786a/raw/markets.json";
const MARKET_REGISTRY_URLS = [MARKET_REGISTRY_API, ...MARKET_BLOB_URLS];
const MARKET_REGISTRY_URL = MARKET_REGISTRY_API;
/** Abort slow registry calls so one hung request cannot block the UI. */
const REGISTRY_FETCH_TIMEOUT_MS = 12000;
/** First paint poll cadence; backs off when the board is quiet. */
const REGISTRY_POLL_FAST_MS = 2500;
const REGISTRY_POLL_SLOW_MS = 10000;
/** While a trade modal is open, poll this often so candles/tape/% feel live. */
const TRADE_LIVE_POLL_MS = 1000;
const TOKEN_IMAGE_MAX_DIM = 256;
const TOKEN_IMAGE_MAX_CHARS = 80_000;
let pendingTokenImage = null;
/** Last successful public board snapshot (for UI). */
let lastPublicBoard = { ok: false, count: 0, error: "" };

function compactAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Connected";
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  const normalized = value.trim().replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Enter a valid 64-character hexadecimal private key.");
  }
  return Uint8Array.from({ length: 32 }, (_, index) => parseInt(normalized.slice(index * 2, index * 2 + 2), 16));
}

function setWalletState(label) {
  connectButtons.forEach((button) => { button.textContent = label; });
}

function showWalletView(name) {
  entryView.hidden = Boolean(name);
  walletViews.forEach((view) => { view.hidden = view.dataset.view !== name; });
}

function openWallet() {
  walletModal.hidden = false;
  document.body.classList.add("modal-open");
  showWalletView(connectedAccount ? "account" : null);
  if (connectedAccount) refreshBalance();
}

function closeWallet() {
  walletModal.hidden = true;
  document.body.classList.remove("modal-open");
}

async function createWallet() {
  const pair = await client.keys.generateKeyPair();
  generatedAccount = {
    address: pair.address,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    createdAt: Date.now(),
  };
  document.querySelector("[data-generated-key]").value = bytesToHex(pair.privateKey);
  document.querySelector("[data-backup-check]").checked = false;
  document.querySelector("[data-use-generated]").disabled = true;
  showWalletView("create");
}

async function importWallet() {
  const error = document.querySelector("[data-import-error]");
  error.textContent = "";
  try {
    const privateKey = hexToBytes(document.querySelector("[data-import-key]").value);
    const publicKey = await client.keys.fromPrivateKey(privateKey);
    activateAccount({
      address: Pubkey.from(publicKey).toThruFmt(),
      publicKey,
      privateKey,
      createdAt: Date.now(),
    });
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : "That key could not be imported.";
  }
}

function activateAccount(account) {
  connectedAccount = account;
  generatedAccount = null;
  try {
    sessionStorage.setItem(WALLET_SESSION_KEY, JSON.stringify({
      privateKey: bytesToHex(account.privateKey),
      createdAt: account.createdAt,
    }));
  } catch {
    // The wallet still works when browser storage is unavailable.
  }
  setWalletState(compactAddress(account.address));
  document.querySelector("[data-account-address]").textContent = account.address;
  document.querySelector("[data-explorer]").href = `https://scan.thru.org/address/${account.address}`;
  if (createButton) createButton.textContent = "Deploy token on Thru";
  if (createStatus) createStatus.textContent = "Thru wallet connected locally. The private key remains only in this browser tab.";
  showWalletView("account");
  refreshBalance();
}

async function restoreWalletSession() {
  let stored;
  try {
    stored = sessionStorage.getItem(WALLET_SESSION_KEY);
  } catch {
    return;
  }
  if (!stored) return;
  try {
    const session = JSON.parse(stored);
    const privateKey = hexToBytes(session.privateKey);
    const publicKey = await client.keys.fromPrivateKey(privateKey);
    activateAccount({
      address: Pubkey.from(publicKey).toThruFmt(),
      publicKey,
      privateKey,
      createdAt: Number(session.createdAt) || Date.now(),
    });
  } catch {
    try { sessionStorage.removeItem(WALLET_SESSION_KEY); } catch { /* Storage is unavailable. */ }
  }
}

async function getAccountSnapshot(address = connectedAccount.address) {
  try {
    const account = await client.accounts.get(address, { view: AccountView.META_ONLY });
    return {
      exists: true,
      balance: BigInt(account.meta?.balance ?? 0),
      nonce: BigInt(account.meta?.nonce ?? 0),
    };
  } catch (reason) {
    const message = String(reason?.message || reason).toLowerCase();
    if (message.includes("not_found") || message.includes("not found") || message.includes("code 5")) {
      return { exists: false, balance: 0n, nonce: 0n };
    }
    throw reason;
  }
}

async function getWthruTokenAccount(createIfMissing = false) {
  if (!connectedAccount) throw new Error("Connect a Thru wallet first.");
  if (createIfMissing) {
    return ensureTokenAccount(connectedAccount.address, WTHRU_MINT);
  }
  return deriveTokenAccountAddress(
    client,
    connectedAccount.address,
    WTHRU_MINT,
    TOKEN_PROGRAM,
  );
}

async function readWthruBalance() {
  if (!connectedAccount) return 0n;
  try {
    const account = await getWthruTokenAccount(false);
    if (!(await getAccountSnapshot(account.address)).exists) return 0n;
    return await readTokenAmount(account.address);
  } catch {
    return 0n;
  }
}

async function loadHeldMarketTokens() {
  if (!connectedAccount) return [];
  const markets = readMarkets().filter((m) => m?.mintAddress && m?.ticker);
  const rows = [];
  const scan = markets.slice(0, 40);
  await Promise.all(scan.map(async (market) => {
    try {
      const tokenAccount = deriveTokenAccountAddress(
        client,
        connectedAccount.address,
        market.mintAddress,
        TOKEN_PROGRAM,
      );
      if (!(await getAccountSnapshot(tokenAccount.address)).exists) return;
      const raw = await readTokenAmount(tokenAccount.address);
      if (raw <= 0n) return;
      const decimals = Number(market.decimals ?? 6);
      rows.push({
        market,
        name: market.name || market.ticker,
        ticker: market.ticker,
        mint: market.mintAddress,
        decimals,
        amount: formatUnits(raw, decimals),
        raw,
      });
    } catch {
      /* skip unreadable mints */
    }
  }));
  rows.sort((a, b) => (a.raw === b.raw ? 0 : a.raw > b.raw ? -1 : 1));
  return rows;
}

async function rebuildWalletSendAssets() {
  const assets = [
    {
      id: "thru",
      kind: "native",
      ticker: "THRU",
      name: "Native THRU",
      decimals: NATIVE_THRU_DECIMALS,
      mint: null,
    },
    {
      id: "wthru",
      kind: "token",
      ticker: "wTHRU",
      name: "Wrapped THRU",
      decimals: NATIVE_THRU_DECIMALS,
      mint: WTHRU_MINT,
    },
  ];
  if (connectedAccount) {
    const held = await loadHeldMarketTokens();
    for (const row of held) {
      assets.push({
        id: `mint:${row.mint}`,
        kind: "token",
        ticker: row.ticker,
        name: row.name,
        decimals: row.decimals,
        mint: row.mint,
        market: row.market,
        raw: row.raw,
      });
    }
  }
  walletSendAssets = assets;
  return assets;
}

function getSelectedSendAsset() {
  const select = document.querySelector("[data-send-asset]");
  const id = select?.value || "thru";
  return walletSendAssets.find((a) => a.id === id) || walletSendAssets[0] || {
    id: "thru",
    kind: "native",
    ticker: "THRU",
    name: "Native THRU",
    decimals: NATIVE_THRU_DECIMALS,
    mint: null,
  };
}

function populateSendAssetSelect(assets = walletSendAssets) {
  const select = document.querySelector("[data-send-asset]");
  if (!select) return;
  const previous = select.value || "thru";
  select.innerHTML = assets.map((asset) => {
    const label = asset.kind === "native"
      ? `${asset.ticker} (native)`
      : asset.id === "wthru"
        ? "wTHRU"
        : `${asset.ticker} · ${asset.name}`;
    return `<option value="${asset.id}">${label}</option>`;
  }).join("");
  if (assets.some((a) => a.id === previous)) select.value = previous;
  else select.value = "thru";
}

async function readSendAssetBalance(asset) {
  if (!connectedAccount || !asset) return 0n;
  if (asset.kind === "native") {
    const snapshot = await getAccountSnapshot();
    return snapshot.balance || 0n;
  }
  if (asset.id === "wthru" || asset.mint === WTHRU_MINT) {
    return readWthruBalance();
  }
  if (asset.raw != null) return asset.raw;
  if (!asset.mint) return 0n;
  try {
    const tokenAccount = deriveTokenAccountAddress(
      client,
      connectedAccount.address,
      asset.mint,
      TOKEN_PROGRAM,
    );
    if (!(await getAccountSnapshot(tokenAccount.address)).exists) return 0n;
    return await readTokenAmount(tokenAccount.address);
  } catch {
    return 0n;
  }
}

async function refreshSendAvailable() {
  const availableEl = document.querySelector("[data-send-available]");
  const labelEl = document.querySelector("[data-send-balance-label]");
  const amountLabel = document.querySelector("[data-send-amount-label]");
  if (!availableEl) return;
  const asset = getSelectedSendAsset();
  if (labelEl) labelEl.textContent = `Available ${asset.ticker}`;
  if (amountLabel) amountLabel.textContent = `Amount in ${asset.ticker}`;
  if (!connectedAccount) {
    availableEl.textContent = "Connect wallet";
    return;
  }
  availableEl.textContent = "Loading…";
  try {
    const raw = await readSendAssetBalance(asset);
    availableEl.textContent = `${formatUnits(raw, asset.decimals)} ${asset.ticker}`;
  } catch {
    availableEl.textContent = "Unavailable";
  }
}

function renderReceiveAssets(heldRows = []) {
  const host = document.querySelector("[data-receive-assets]");
  const receiveAddress = document.querySelector("[data-receive-address]");
  if (receiveAddress) {
    receiveAddress.textContent = connectedAccount?.address || "—";
  }
  if (!host) return;
  if (!connectedAccount) {
    host.innerHTML = `<div class="wallet-token-empty">Connect wallet to see receivable assets.</div>`;
    return;
  }
  const items = [
    { ticker: "THRU", name: "Native THRU", note: "Sent as native balance" },
    { ticker: "wTHRU", name: "Wrapped THRU", note: "Token mint on Thru" },
    ...heldRows.map((row) => ({
      ticker: row.ticker,
      name: row.name,
      note: compactAddress(row.mint),
    })),
  ];
  // Dedupe by ticker for display (wTHRU + held markets)
  const seen = new Set();
  const unique = items.filter((item) => {
    const key = item.ticker;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  host.innerHTML = unique.map((item) => `
    <article class="receive-asset-row">
      <div>
        <strong>${item.ticker}</strong>
        <small>${item.name}</small>
      </div>
      <small>${item.note}</small>
    </article>
  `).join("");
}

async function refreshWalletTokenHoldings() {
  const host = document.querySelector("[data-wallet-tokens]");
  if (!connectedAccount) {
    walletSendAssets = [];
    populateSendAssetSelect([
      { id: "thru", kind: "native", ticker: "THRU", name: "Native THRU", decimals: NATIVE_THRU_DECIMALS, mint: null },
      { id: "wthru", kind: "token", ticker: "wTHRU", name: "Wrapped THRU", decimals: NATIVE_THRU_DECIMALS, mint: WTHRU_MINT },
    ]);
    if (host) host.innerHTML = `<div class="wallet-token-empty">Connect a wallet to see token balances.</div>`;
    renderReceiveAssets([]);
    refreshSendAvailable().catch(() => {});
    return;
  }

  if (host) host.innerHTML = `<div class="wallet-token-empty">Loading token balances…</div>`;
  const held = await loadHeldMarketTokens();
  await rebuildWalletSendAssets();
  populateSendAssetSelect(walletSendAssets);
  renderReceiveAssets(held);
  refreshSendAvailable().catch(() => {});

  if (!host) return;
  if (!held.length) {
    host.innerHTML = `<div class="wallet-token-empty">No Genesis tokens held yet. Buy on a curve to see balances here.</div>`;
    return;
  }

  host.innerHTML = held.map((row) => `
    <article class="wallet-token-row">
      <div class="wallet-token-meta">
        ${marketImageHtml(row.market || row, "wallet-token-avatar")}
        <div>
          <strong>${row.ticker}</strong>
          <small>${row.name}</small>
        </div>
      </div>
      <div class="wallet-token-amount">
        <strong>${row.amount}</strong>
        <small title="${row.mint}">${compactAddress(row.mint)}</small>
      </div>
    </article>
  `).join("");
}

async function refreshWrapAvailable() {
  const availableEls = [...document.querySelectorAll("[data-wrap-available]")];
  const labelEls = [...document.querySelectorAll("[data-wrap-balance-label]")];
  if (!availableEls.length) return;

  const side = wrapSide === "unwrap" ? "unwrap" : "wrap";
  labelEls.forEach((el) => {
    el.textContent = side === "wrap" ? "Your THRU balance" : "Your wTHRU balance";
  });

  if (!connectedAccount) {
    availableEls.forEach((el) => { el.textContent = "Connect wallet"; });
    return;
  }

  availableEls.forEach((el) => { el.textContent = "Loading…"; });
  try {
    if (side === "wrap") {
      const snapshot = await getAccountSnapshot();
      const raw = snapshot?.balance ?? 0n;
      const label = `${formatUnits(raw, NATIVE_THRU_DECIMALS, 9)} THRU`;
      availableEls.forEach((el) => { el.textContent = label; });
    } else {
      const amount = await readWthruBalance();
      const label = `${formatUnits(amount ?? 0n, NATIVE_THRU_DECIMALS, 9)} wTHRU`;
      availableEls.forEach((el) => { el.textContent = label; });
    }
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unavailable";
    availableEls.forEach((el) => {
      el.textContent = message.includes("Connect") ? "Connect wallet" : "Unavailable";
    });
  }
}

async function refreshBalance() {
  // Always refresh wrap page available line (even when disconnected).
  const wrapRefresh = refreshWrapAvailable().catch(() => { /* ignore */ });
  if (!connectedAccount) {
    await wrapRefresh;
    return;
  }
  const balance = document.querySelector("[data-balance]");
  const wthruBalance = document.querySelector("[data-wthru-balance]");
  try {
    const snapshot = await getAccountSnapshot();
    const thruLabel = `${formatUnits(snapshot.balance, NATIVE_THRU_DECIMALS, 9)} THRU`;
    if (balance) balance.textContent = thruLabel;
  } catch {
    if (balance) balance.textContent = "Unavailable";
  }
  try {
    const amount = await readWthruBalance();
    // Base units are 1:1 with native THRU; show the same 9-decimal scale.
    const wthruLabel = `${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} wTHRU`;
    if (wthruBalance) wthruBalance.textContent = wthruLabel;
  } catch {
    if (wthruBalance) wthruBalance.textContent = "Unavailable";
  }
  await wrapRefresh;
  // Token holdings (async; don't block THRU/wTHRU display).
  refreshWalletTokenHoldings().catch(() => { /* ignore */ });
}

async function currentSlot() {
  const height = await client.blocks.getBlockHeight();
  const values = [height.clusterExecuted, height.locallyExecuted, height.finalized]
    .filter((value) => value != null)
    .map(BigInt);
  return values.reduce((largest, value) => value > largest ? value : largest, 0n);
}

async function buildAndSign(options) {
  const { rawTransaction } = await client.transactions.buildAndSign({
    feePayer: {
      publicKey: connectedAccount.publicKey,
      privateKey: connectedAccount.privateKey,
    },
    ...options,
  });
  return rawTransaction;
}

/** Decode Thru userErrorCode (often unsigned i64 wire form, e.g. 2^64-38 → -38). */
function normalizeUserErrorCode(code) {
  if (code == null || code === "") return null;
  try {
    let value = typeof code === "bigint" ? code : BigInt(String(code).trim());
    // Unsigned 64-bit values with the high bit set are signed i64 negatives.
    if (value >= 0x8000000000000000n) {
      value -= 0x10000000000000000n;
    }
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : null;
  } catch {
    const asNumber = Number(code);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
}

async function submitTransaction(rawTransaction, { programLabel = "Transaction" } = {}) {
  for await (const update of client.transactions.sendAndTrack(rawTransaction, { timeoutMs: 60000 })) {
    const result = update.executionResult;
    if (result?.vmError) {
      const userCode = normalizeUserErrorCode(result.userErrorCode);
      const ammErrors = {
        1: "Invalid AMM instruction data.",
        2: "Unknown AMM instruction.",
        3: "This AMM pool is already initialized.",
        4: "This AMM pool is not initialized yet.",
        5: "Invalid account index in the AMM transaction.",
        6: "Mint ordering is invalid for this pool.",
        7: "Wallet is not authorized for this AMM action (or pool authority is invalid — hard-refresh and create a new pool).",
        8: "The AMM pool account could not be created. Refresh and try again.",
        12: "The AMM pool account could not be resized.",
        13: "The AMM pool account could not be made writable.",
        14: "The AMM token operation failed.",
        17: "The supplied liquidity amounts are outside the pool bounds.",
        22: "The AMM derived a different pool address than the website.",
        23: "Thru rejected the AMM pool account creation proof.",
        24: "LP mint is missing. Refresh and try creating the pool again.",
        25: "Pool vault accounts are missing. Refresh and try again.",
      };
      const syscallErrors = {
        [-8]: "Invalid account index for a Thru syscall.",
        [-9]: "A required account does not exist yet.",
        [-10]: "An account was not marked writable in the transaction.",
        [-15]: "Account already exists.",
        [-16]: "Pool address does not match the seed.",
        [-23]: "Invalid state proof. Refresh and try again.",
        [-32]: "Invalid state-proof length.",
        [-33]: "State proof slot is stale. Refresh and try again.",
        // Thru VM: balance < transfer amount + transaction fee.
        [-38]: "Insufficient THRU balance (need amount + network fee). Use Max or lower the amount.",
      };
      let explanation;
      if (result.vmError === -766) {
        explanation = "The requested program account is not deployed on this Thru network.";
      } else if (result.vmError === -767 && userCode != null && Math.abs(userCode) > 1000) {
        explanation = `${programLabel} faulted in the Thru VM. Hard-refresh and try again.`;
      } else if (programLabel === "AMM" && userCode != null && ammErrors[userCode]) {
        explanation = ammErrors[userCode];
      } else if (userCode != null && syscallErrors[userCode]) {
        explanation = syscallErrors[userCode];
      } else {
        const codeLabel = userCode != null
          ? userCode
          : (result.userErrorCode ?? "unknown");
        explanation =
          `${programLabel} rejected (VM ${result.vmError}, code ${codeLabel}).`;
      }
      throw new Error(explanation);
    }
    if (
      result ||
      update.consensusStatus === ConsensusStatus.FINALIZED ||
      update.consensusStatus === ConsensusStatus.CLUSTER_EXECUTED
    ) return;
  }
}

async function submitWithNonce(startNonce, builder, options = {}) {
  let nonce = startNonce < 0n ? 0n : startNonce;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await submitTransaction(await builder(nonce), options);
      return;
    } catch (reason) {
      const message = String(reason?.message || reason);
      if (message.includes("-511")) { nonce += 1n; continue; }
      if (message.includes("-510")) { nonce = nonce > 0n ? nonce - 1n : 0n; continue; }
      throw reason;
    }
  }
  throw new Error("Could not find a valid account nonce.");
}

async function ensureAccountExists(setStatus) {
  if ((await getAccountSnapshot()).exists) return;
  setStatus("Preparing your account…");
  const proof = await client.proofs.generate({ address: connectedAccount.address, proofType: 1 });
  await submitWithNonce(0n, (nonce) => buildAndSign({
    program: EOA_CREATE_PROGRAM,
    header: {
      fee: 0n, nonce, startSlot: proof.slot, expiryAfter: 100,
      computeUnits: 10000, memoryUnits: 10000, stateUnits: 10000, chainId: CHAIN_ID,
    },
    feePayerStateProof: proof.proof,
  }));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await getAccountSnapshot()).exists) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("The account was submitted but is not live yet. Please try the faucet again.");
}

async function waitForAccount(address, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await getAccountSnapshot(address)).exists) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`${label} was submitted but is not visible on-chain yet. Please try again.`);
}

function randomHex(byteLength = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function submitTokenInstruction({ accounts, instructionData }) {
  const snapshot = await getAccountSnapshot();
  const slot = await currentSlot();
  await submitWithNonce(snapshot.nonce, (nonce) => buildAndSign({
    program: TOKEN_PROGRAM,
    accounts,
    instructionData,
    header: {
      fee: 0n, nonce, startSlot: slot, expiryAfter: 100,
      computeUnits: 300000, memoryUnits: 10000, stateUnits: 10000, chainId: CHAIN_ID,
    },
  }), { programLabel: "Token program" });
}

async function submitProgramInstruction(
  program,
  { accounts, instructionData, fee = 0n, startSlot: anchoredStartSlot, programLabel },
) {
  const snapshot = await getAccountSnapshot();
  const slot = anchoredStartSlot ?? await currentSlot();
  const label = programLabel
    || (program === GENESIS_AMM_PROGRAM ? "AMM" : "Program");
  await submitWithNonce(snapshot.nonce, (nonce) => buildAndSign({
    program,
    accounts,
    instructionData,
    header: {
      fee, nonce, startSlot: slot, expiryAfter: 100,
      computeUnits: 500000, memoryUnits: 10000, stateUnits: 10000, chainId: CHAIN_ID,
    },
  }), { programLabel: label });
}

function parseUnits(value, decimals) {
  const normalized = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Enter a valid positive amount.");
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return (BigInt(whole) * (10n ** BigInt(decimals))) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function formatUnits(raw, decimals, precision = 6) {
  const d = Number(decimals);
  const places = Number.isFinite(d) && d >= 0 && d <= 18 ? Math.floor(d) : 6;
  const value = typeof raw === "bigint"
    ? raw
    : BigInt(String(raw ?? 0).split(".")[0] || "0");
  if (value < 0n) return "0";
  const scale = 10n ** BigInt(places);
  const whole = value / scale;
  const fracPlaces = Number.isFinite(Number(precision))
    ? Math.min(places, Math.max(0, Math.floor(Number(precision))))
    : Math.min(places, 6);
  const fraction = (value % scale)
    .toString()
    .padStart(places, "0")
    .slice(0, fracPlaces)
    .replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

async function ensureTokenAccount(ownerAddress, mintAddress, seed = new Uint8Array(32)) {
  const account = deriveTokenAccountAddress(client, ownerAddress, mintAddress, TOKEN_PROGRAM, seed);
  if ((await getAccountSnapshot(account.address)).exists) return account;
  const proof = await client.proofs.generate({ address: account.address, proofType: 1 });
  // Fee payer is always index 0. Any other owner pubkey must appear in the account list
  // so instruction encoding can resolve its index (pool PDAs are not fee payers).
  const ownerIsFeePayer = connectedAccount && ownerAddress === connectedAccount.address;
  const readOnly = ownerIsFeePayer
    ? [mintAddress]
    : [mintAddress, ownerAddress];
  await submitTokenInstruction({
    accounts: { readWrite: [account.address], readOnly },
    instructionData: createInitializeAccountInstruction({
      tokenAccountBytes: account.bytes,
      mintAccountBytes: Pubkey.from(mintAddress).toBytes(),
      ownerAccountBytes: Pubkey.from(ownerAddress).toBytes(),
      seedBytes: seed,
      stateProof: proof.proof,
    }),
  });
  await waitForAccount(account.address, "Token account");
  return account;
}

function nativeTransferInstruction(amount) {
  const data = new Uint8Array(16);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, amount, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 2, true);
  return data;
}

async function readTokenAmount(address) {
  const account = await client.accounts.get(address, { view: AccountView.FULL });
  const raw = account.data?.data ?? account.data;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true);
}

/** Integer square root for bigint (floor). */
function sqrtBigInt(value) {
  if (value < 0n) throw new Error("sqrt of negative");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (value >> 1n) + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + value / x1) >> 1n;
  }
  return x0;
}

function assertInitialLiquidityAmounts(amountOne, amountTwo) {
  if (amountOne <= 0n || amountTwo <= 0n) {
    throw new Error("Both pool sides need a positive deposit.");
  }
  const root = sqrtBigInt(amountOne * amountTwo);
  if (root <= AMM_MINIMUM_LIQUIDITY) {
    throw new Error(
      "Liquidity is too small for the pool. Seed more THRU (and matching tokens) so " +
      `√(token×wTHRU) is greater than ${AMM_MINIMUM_LIQUIDITY}.`,
    );
  }
}

/* ─── Bonding curve ────────────────────────────────────────────────────── */

function isBondingMarket(market) {
  // Curve stays tradeable until an AMM pool is actually live.
  // Graduation alone does not lock the curve (AMM seed may still be pending).
  if (!market?.curve) return false;
  if (market.liquidity && market.phase === "amm") return false;
  // privateKeyHex is required for the curve vault to sign token releases.
  // tokenAccount is the curve inventory; both must be present on the board.
  const pk = String(market.curve.privateKeyHex || "").trim();
  const vault = String(market.curve.tokenAccount || "").trim();
  return Boolean(pk.length >= 64 && vault);
}

/** Prefer the fullest local+active market record (keeps curve key after sync). */
function resolveTradeMarket(market) {
  if (!market?.mintAddress) return market || null;
  const local = readMarkets().find((m) => m.mintAddress === market.mintAddress);
  if (!local) return market;
  return mergeTwoMarkets(local, market);
}

function isGraduatedMarket(market) {
  return Boolean(market?.graduated) || market?.phase === "graduated" || market?.phase === "amm";
}

function readCurve(market) {
  if (!market?.curve) throw new Error("This market has no bonding curve.");
  return {
    virtualThru: BigInt(market.curve.virtualThru),
    virtualToken: BigInt(market.curve.virtualToken),
    realThru: BigInt(market.curve.realThru),
    realToken: BigInt(market.curve.realToken),
    graduationTarget: BigInt(market.curve.graduationTargetThru || GRADUATION_REAL_THRU),
  };
}

function curveProgress(market) {
  try {
    const c = readCurve(market);
    if (c.graduationTarget <= 0n) return 1;
    const pct = Number((c.realThru * 10000n) / c.graduationTarget) / 100;
    return Math.min(100, Math.max(0, pct));
  } catch {
    return 0;
  }
}

function curveSpotPriceThruPerToken(market) {
  const c = readCurve(market);
  if (c.virtualToken <= 0n) return 0n;
  // THRU base units for one whole token (10^decimals base units).
  const oneToken = 10n ** BigInt(market.decimals || 0);
  return (c.virtualThru * oneToken) / c.virtualToken;
}

function formatSpotPrice(priceBaseUnits) {
  // priceBaseUnits = THRU base units per 1 whole token
  if (priceBaseUnits <= 0n) return "0 THRU";
  // Show more precision for tiny alphanet prices
  return `${formatUnits(priceBaseUnits, NATIVE_THRU_DECIMALS, 12)} THRU`;
}

const CHART_HISTORY = 240;

function readChart(market) {
  const points = Array.isArray(market?.chart) ? market.chart : [];
  return points
    .map((p) => ({
      t: Number(p.t) || 0,
      price: String(p.price || "0"),
      side: p.side || "seed",
      thru: String(p.thru || "0"),
      tokens: String(p.tokens || "0"),
    }))
    .filter((p) => BigInt(p.price) >= 0n)
    .slice(-CHART_HISTORY);
}

function readTradeStats(market) {
  const points = readChart(market);
  let buys = 0;
  let sells = 0;
  let buyThru = 0n;
  let sellThru = 0n;
  let buyTokens = 0n;
  let sellTokens = 0n;
  let high = 0n;
  let low = 0n;
  for (const p of points) {
    const price = BigInt(p.price || "0");
    if (high === 0n || price > high) high = price;
    if (low === 0n || (price > 0n && price < low)) low = price;
    if (p.side === "buy") {
      buys += 1;
      buyThru += BigInt(p.thru || "0");
      buyTokens += BigInt(p.tokens || "0");
    } else if (p.side === "sell") {
      sells += 1;
      sellThru += BigInt(p.thru || "0");
      sellTokens += BigInt(p.tokens || "0");
    }
  }
  return { buys, sells, buyThru, sellThru, buyTokens, sellTokens, high, low, points };
}

function appendChartPoint(market, { side, price, thru = 0n, tokens = 0n }) {
  const chart = readChart(market);
  chart.push({
    t: Date.now(),
    price: price.toString(),
    side: side || "seed",
    thru: thru.toString(),
    tokens: tokens.toString(),
  });
  const stats = {
    buys: 0,
    sells: 0,
    buyThru: "0",
    sellThru: "0",
  };
  for (const p of chart) {
    if (p.side === "buy") {
      stats.buys += 1;
      stats.buyThru = (BigInt(stats.buyThru) + BigInt(p.thru || "0")).toString();
    } else if (p.side === "sell") {
      stats.sells += 1;
      stats.sellThru = (BigInt(stats.sellThru) + BigInt(p.thru || "0")).toString();
    }
  }
  return updateMarket(market.mintAddress, {
    chart: chart.slice(-CHART_HISTORY),
    lastPrice: price.toString(),
    stats,
    updatedAt: Date.now(),
  }) || market;
}

function ensureChartSeed(market) {
  if (!market?.curve) return market;
  const existing = readChart(market);
  if (existing.length > 0) return market;
  // One flat seed tick so the chart can open; real trades create movement.
  try {
    const c = readCurve(market);
    const oneToken = 10n ** BigInt(market.decimals || 0);
    const startPrice = c.virtualToken > 0n
      ? (c.virtualThru * oneToken) / c.virtualToken
      : 0n;
    const now = Date.now();
    const seed = [
      { t: now, price: startPrice.toString(), side: "seed", thru: "0", tokens: "0" },
    ];
    return updateMarket(market.mintAddress, {
      chart: seed,
      lastPrice: startPrice.toString(),
      updatedAt: now,
    }) || market;
  } catch {
    return market;
  }
}

/** Candle interval: 1m | 5m | 15m | 1h | all — DexScreener-style. */
let chartWindow = "5m";

function chartIntervalMs(windowKey = chartWindow) {
  if (windowKey === "1m") return 60 * 1000;
  if (windowKey === "5m") return 5 * 60 * 1000;
  if (windowKey === "15m") return 15 * 60 * 1000;
  if (windowKey === "1h") return 60 * 60 * 1000;
  // ALL: adaptive bucket from data span
  return 0;
}

function compactChartPrice(priceBaseUnits) {
  if (priceBaseUnits <= 0n) return "0";
  const full = formatUnits(priceBaseUnits, NATIVE_THRU_DECIMALS, 8);
  if (full.includes("e") || full.includes("E")) return full;
  const [w, f = ""] = full.split(".");
  if (!f) return w;
  const trimmed = f.replace(/0+$/, "").slice(0, 6);
  return trimmed ? `${w}.${trimmed}` : w;
}

/**
 * Bucket trade prints into OHLC candles (DexScreener-style).
 * @returns {{ t: number, o: bigint, h: bigint, l: bigint, c: bigint, vol: bigint, buys: number, sells: number }[]}
 */
function buildCandles(points, intervalMs, spot = 0n) {
  const trades = (points || [])
    .filter((p) => p && (p.side === "buy" || p.side === "sell" || p.side === "seed" || p.side === "live"))
    .map((p) => ({
      t: Number(p.t) || 0,
      price: BigInt(p.price || "0"),
      vol: BigInt(p.thru || "0"),
      side: p.side || "seed",
    }))
    .filter((p) => p.price > 0n && p.t > 0)
    .sort((a, b) => a.t - b.t);

  if (!trades.length && spot > 0n) {
    const now = Date.now();
    return [{
      t: now,
      o: spot,
      h: spot,
      l: spot,
      c: spot,
      vol: 0n,
      buys: 0,
      sells: 0,
    }];
  }
  if (!trades.length) return [];

  let bucket = intervalMs;
  if (!bucket) {
    const span = Math.max(60_000, (trades[trades.length - 1].t - trades[0].t) || 60_000);
    // Aim for ~40–60 candles across ALL
    bucket = Math.max(60_000, Math.floor(span / 48));
  }

  const map = new Map();
  for (const tr of trades) {
    const key = Math.floor(tr.t / bucket) * bucket;
    let c = map.get(key);
    if (!c) {
      c = {
        t: key,
        o: tr.price,
        h: tr.price,
        l: tr.price,
        c: tr.price,
        vol: 0n,
        buys: 0,
        sells: 0,
      };
      map.set(key, c);
    }
    if (tr.price > c.h) c.h = tr.price;
    if (tr.price < c.l) c.l = tr.price;
    c.c = tr.price;
    c.vol += tr.vol;
    if (tr.side === "buy") c.buys += 1;
    if (tr.side === "sell") c.sells += 1;
  }

  // Fill empty buckets through now so the chart extends live
  const candles = [...map.values()].sort((a, b) => a.t - b.t);
  if (!candles.length) return candles;
  const last = candles[candles.length - 1];
  const nowBucket = Math.floor(Date.now() / bucket) * bucket;
  if (spot > 0n) {
    if (last.t === nowBucket) {
      if (spot > last.h) last.h = spot;
      if (spot < last.l) last.l = spot;
      last.c = spot;
    } else if (nowBucket > last.t) {
      candles.push({
        t: nowBucket,
        o: last.c,
        h: spot > last.c ? spot : last.c,
        l: spot < last.c ? spot : last.c,
        c: spot,
        vol: 0n,
        buys: 0,
        sells: 0,
      });
    }
  }
  // Cap candles for SVG density
  return candles.slice(-80);
}

/**
 * DexScreener-style OHLC candlesticks + volume histogram.
 * Green up / red down bodies, wicks, volume bars, live price + %.
 */
function renderTokenChart(market) {
  const root = document.querySelector("[data-token-chart]");
  const svg = document.querySelector("[data-chart-svg]");
  const priceEl = document.querySelector("[data-chart-price]");
  const changeEl = document.querySelector("[data-chart-change]");
  const changeVal = document.querySelector("[data-chart-change-value]");
  const rangeLabel = document.querySelector("[data-chart-range-label]");
  const tradesEl = document.querySelector("[data-chart-trades]");
  const rangeEl = document.querySelector("[data-chart-range]");
  if (!svg || !market) return;

  let m = ensureChartSeed(market);
  const rawPoints = readChart(m).filter((p) => p.side !== "hold");
  const stats = readTradeStats(m);

  let spot = 0n;
  try {
    spot = curveSpotPriceThruPerToken(m);
  } catch {
    spot = 0n;
  }
  if (spot <= 0n && m.lastPrice) {
    try { spot = BigInt(m.lastPrice); } catch { spot = 0n; }
  }

  const intervalMs = chartIntervalMs();
  const candles = buildCandles(rawPoints, intervalMs, spot);
  const openPrice = candles.length ? candles[0].o : spot;
  const last = candles.length ? candles[candles.length - 1].c : spot;
  const up = last >= openPrice;

  if (root) {
    root.classList.toggle("up", up);
    root.classList.toggle("down", !up);
  }
  if (priceEl) {
    const prevText = priceEl.textContent;
    priceEl.textContent = formatSpotPrice(last);
    if (prevText && prevText !== priceEl.textContent) {
      priceEl.classList.remove("price-flash");
      void priceEl.offsetWidth;
      priceEl.classList.add("price-flash");
    }
  }
  let pctText = "0.00%";
  if (openPrice > 0n && last !== openPrice) {
    const delta = up ? last - openPrice : openPrice - last;
    const bps = (delta * 10000n) / openPrice;
    pctText = `${up ? "+" : "−"}${(Number(bps) / 100).toFixed(2)}%`;
  }
  if (changeVal) changeVal.textContent = pctText;
  else if (changeEl) changeEl.textContent = pctText;
  if (changeEl) {
    changeEl.classList.toggle("up", up && last !== openPrice);
    changeEl.classList.toggle("down", !up && last !== openPrice);
    changeEl.classList.toggle("is-up", up && last !== openPrice);
    changeEl.classList.toggle("is-down", !up && last !== openPrice);
  }
  if (rangeLabel) {
    rangeLabel.textContent = chartWindow === "all" ? "ALL" : chartWindow;
  }
  if (tradesEl) {
    const realTrades = stats.buys + stats.sells;
    tradesEl.textContent = realTrades
      ? `${realTrades} trade${realTrades === 1 ? "" : "s"} · ${stats.buys}B / ${stats.sells}S`
      : "No trades yet";
  }
  if (rangeEl) rangeEl.textContent = `OHLC · ${chartWindow === "all" ? "auto" : chartWindow} candles · THRU`;

  const setStat = (sel, text, cls) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.textContent = text;
    el.classList.remove("stat-buy", "stat-sell");
    if (cls) el.classList.add(cls);
  };
  setStat("[data-stat-buys]", String(stats.buys), "stat-buy");
  setStat("[data-stat-sells]", String(stats.sells), "stat-sell");
  setStat("[data-stat-buy-vol]", `${formatUnits(stats.buyThru, NATIVE_THRU_DECIMALS, 6)} THRU`, "stat-buy");
  setStat("[data-stat-sell-vol]", `${formatUnits(stats.sellThru, NATIVE_THRU_DECIMALS, 6)} THRU`, "stat-sell");
  let hi = 0n;
  let lo = 0n;
  for (const c of candles) {
    if (hi === 0n || c.h > hi) hi = c.h;
    if (lo === 0n || c.l < lo) lo = c.l;
  }
  setStat("[data-stat-high]", formatSpotPrice(hi || last));
  setStat("[data-stat-low]", formatSpotPrice(lo || last));
  try {
    const c = readCurve(m);
    setStat("[data-stat-vault]", `${formatUnits(c.realThru, NATIVE_THRU_DECIMALS, 6)} THRU`);
    setStat("[data-stat-progress]", `${curveProgress(m).toFixed(1)}%`);
  } catch {
    setStat("[data-stat-vault]", "—");
    setStat("[data-stat-progress]", "—");
  }

  // DexScreener layout: price pane + volume pane
  const W = 720;
  const H = 360;
  const padL = 8;
  const padR = 68;
  const padT = 12;
  const volH = 64;
  const gap = 10;
  const priceH = H - padT - volH - gap - 8;
  const priceBottom = padT + priceH;
  const volTop = priceBottom + gap;
  const plotW = W - padL - padR;

  let minP = lo || last || 1n;
  let maxP = hi || last || 1n;
  if (maxP === minP) maxP = minP + 1n;
  const pad = (maxP - minP) / 10n || 1n;
  minP = minP > pad ? minP - pad : 0n;
  maxP += pad;
  const span = maxP - minP || 1n;

  let maxVol = 1n;
  for (const c of candles) {
    if (c.vol > maxVol) maxVol = c.vol;
  }

  const n = Math.max(candles.length, 1);
  const slot = plotW / n;
  const bodyW = Math.max(2, Math.min(14, slot * 0.62));

  const yPrice = (p) => {
    const yRatio = Number(((p - minP) * 10000n) / span) / 10000;
    return padT + priceH * (1 - Math.min(1, Math.max(0, yRatio)));
  };

  // Grid + y ticks
  const yTicks = [];
  for (let i = 0; i < 5; i += 1) {
    const y = padT + (priceH * i) / 4;
    const priceAt = maxP - ((maxP - minP) * BigInt(i)) / 4n;
    yTicks.push({ y, label: compactChartPrice(priceAt) });
  }
  const grid = yTicks.map((t) =>
    `<line class="dex-grid" x1="${padL}" x2="${padL + plotW}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"></line>`
    + `<text class="dex-ytick" x="${W - 4}" y="${(t.y + 3).toFixed(1)}" text-anchor="end">${t.label}</text>`,
  ).join("");

  let candleSvg = "";
  let volSvg = "";
  candles.forEach((c, i) => {
    const cx = padL + slot * i + slot / 2;
    const bull = c.c >= c.o;
    const cls = bull ? "up" : "down";
    const yO = yPrice(c.o);
    const yC = yPrice(c.c);
    const yH = yPrice(c.h);
    const yL = yPrice(c.l);
    const bodyTop = Math.min(yO, yC);
    const bodyBot = Math.max(yO, yC);
    const bodyHeight = Math.max(1.2, bodyBot - bodyTop);
    // Wick
    candleSvg +=
      `<line class="dex-wick ${cls}" x1="${cx.toFixed(2)}" x2="${cx.toFixed(2)}" `
      + `y1="${yH.toFixed(2)}" y2="${yL.toFixed(2)}"></line>`;
    // Body
    candleSvg +=
      `<rect class="dex-body ${cls}" x="${(cx - bodyW / 2).toFixed(2)}" y="${bodyTop.toFixed(2)}" `
      + `width="${bodyW.toFixed(2)}" height="${bodyHeight.toFixed(2)}" rx="0.5"></rect>`;
    // Volume
    const vH = maxVol > 0n
      ? Math.max(1, Number((c.vol * 1000n) / maxVol) / 1000) * (volH - 4)
      : 1;
    const vy = volTop + volH - vH;
    volSvg +=
      `<rect class="dex-vol ${cls}" x="${(cx - bodyW / 2).toFixed(2)}" y="${vy.toFixed(2)}" `
      + `width="${bodyW.toFixed(2)}" height="${vH.toFixed(2)}"></rect>`;
  });

  // Volume baseline
  const volBase =
    `<line class="dex-grid" x1="${padL}" x2="${padL + plotW}" y1="${(volTop + volH).toFixed(1)}" y2="${(volTop + volH).toFixed(1)}"></line>`
    + `<text class="dex-ytick" x="${W - 4}" y="${(volTop + 10).toFixed(1)}" text-anchor="end">Vol</text>`;

  // Separator between price & volume
  const sep =
    `<line class="dex-sep" x1="${padL}" x2="${padL + plotW}" y1="${priceBottom.toFixed(1)}" y2="${priceBottom.toFixed(1)}"></line>`;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `
    ${grid}
    ${sep}
    ${volBase}
    <g class="dex-volumes">${volSvg}</g>
    <g class="dex-candles">${candleSvg}</g>
    <g class="dex-cursor" hidden>
      <line class="dex-cursor-v" x1="0" x2="0" y1="${padT}" y2="${volTop + volH}"></line>
      <line class="dex-cursor-h" x1="${padL}" x2="${padL + plotW}" y1="0" y2="0"></line>
    </g>
    <rect class="dex-scrub" x="${padL}" y="${padT}" width="${plotW}" height="${priceH + gap + volH}"></rect>
  `;

  // Hover: snap to candle, show OHLC in price
  const cursor = svg.querySelector(".dex-cursor");
  const scrub = svg.querySelector(".dex-scrub");
  const onMove = (clientX) => {
    if (!cursor || !candles.length) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = W / Math.max(rect.width, 1);
    const xSvg = (clientX - rect.left) * scaleX;
    let idx = Math.floor((xSvg - padL) / slot);
    idx = Math.max(0, Math.min(candles.length - 1, idx));
    const c = candles[idx];
    const cx = padL + slot * idx + slot / 2;
    const cy = yPrice(c.c);
    cursor.hidden = false;
    const v = cursor.querySelector(".dex-cursor-v");
    const h = cursor.querySelector(".dex-cursor-h");
    if (v) {
      v.setAttribute("x1", cx.toFixed(2));
      v.setAttribute("x2", cx.toFixed(2));
    }
    if (h) {
      h.setAttribute("y1", cy.toFixed(2));
      h.setAttribute("y2", cy.toFixed(2));
    }
    if (priceEl) {
      priceEl.textContent = formatSpotPrice(c.c);
    }
    if (changeVal || changeEl) {
      const o = c.o;
      const bull = c.c >= c.o;
      let tip = `O ${compactChartPrice(c.o)}  H ${compactChartPrice(c.h)}  L ${compactChartPrice(c.l)}  C ${compactChartPrice(c.c)}`;
      if (o > 0n && c.c !== o) {
        const d = bull ? c.c - o : o - c.c;
        const bps = (d * 10000n) / o;
        tip = `${bull ? "+" : "−"}${(Number(bps) / 100).toFixed(2)}% · ${tip}`;
      }
      if (changeVal) changeVal.textContent = tip;
    }
  };
  if (scrub) {
    scrub.onpointermove = (e) => onMove(e.clientX);
    scrub.onpointerleave = () => {
      if (cursor) cursor.hidden = true;
      if (priceEl) priceEl.textContent = formatSpotPrice(last);
      if (changeVal) changeVal.textContent = pctText;
      else if (changeEl) changeEl.textContent = pctText;
    };
  }
}

function bindChartRangePills() {
  document.querySelectorAll("[data-chart-window]").forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      chartWindow = btn.dataset.chartWindow || "5m";
      document.querySelectorAll("[data-chart-window]").forEach((b) => {
        const on = b.dataset.chartWindow === chartWindow;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      if (activeTrade) renderTokenChart(activeTrade);
    });
  });
}

function quoteCurveBuy(market, thruIn) {
  if (thruIn <= 0n) throw new Error("Enter an amount greater than zero.");
  const c = readCurve(market);
  const fee = (thruIn * CURVE_TRADE_FEE_BPS) / 10000n;
  const net = thruIn - fee;
  if (net <= 0n) throw new Error("Amount is too small after fees.");
  const k = c.virtualThru * c.virtualToken;
  // Price impact uses net (after fee). Full thruIn still lands in the vault.
  const newVirtualThru = c.virtualThru + net;
  const newVirtualToken = k / newVirtualThru;
  const tokensOut = c.virtualToken - newVirtualToken;
  if (tokensOut <= 0n) throw new Error("Quote produced zero tokens.");
  if (tokensOut > c.realToken) {
    throw new Error("Not enough tokens left on the bonding curve for that buy.");
  }
  return {
    fee,
    netThru: net,
    tokensOut,
    next: {
      virtualThru: newVirtualThru,
      virtualToken: newVirtualToken,
      // Count the full deposit as sell liquidity (fee stays in the vault).
      realThru: c.realThru + thruIn,
      realToken: c.realToken - tokensOut,
      graduationTarget: c.graduationTarget,
    },
  };
}

function quoteCurveSell(market, tokensIn) {
  if (tokensIn <= 0n) throw new Error("Enter an amount greater than zero.");
  const c = readCurve(market);
  if (c.realThru <= 0n) {
    throw new Error(
      "The curve vault has no THRU to pay sellers yet. " +
      "Sells need THRU from prior buys (creator free allocation cannot all be sold into an empty vault).",
    );
  }
  const k = c.virtualThru * c.virtualToken;
  const newVirtualToken = c.virtualToken + tokensIn;
  const newVirtualThru = k / newVirtualToken;
  if (newVirtualThru >= c.virtualThru) throw new Error("Quote produced zero THRU.");
  const thruGross = c.virtualThru - newVirtualThru;
  const fee = (thruGross * CURVE_TRADE_FEE_BPS) / 10000n;
  const netThru = thruGross - fee;
  if (netThru <= 0n) throw new Error("Amount is too small after fees.");
  if (netThru > c.realThru) {
    throw new Error(
      "Sell is larger than THRU in the curve vault. " +
      "You can only sell into what buyers have paid in — use Max, or sell a smaller amount. " +
      `(Vault ≈ ${formatUnits(c.realThru, NATIVE_THRU_DECIMALS, 9)} THRU.)`,
    );
  }
  return {
    fee,
    netThru,
    tokensIn,
    next: {
      virtualThru: newVirtualThru,
      virtualToken: newVirtualToken,
      // Fee stays in the vault as residual depth.
      realThru: c.realThru - netThru,
      realToken: c.realToken + tokensIn,
      graduationTarget: c.graduationTarget,
    },
  };
}

/** Largest token amount that can be sold without exceeding vault THRU. */
function maxSellableTokens(market) {
  const c = readCurve(market);
  if (c.realThru <= 0n || c.virtualThru <= 0n) return 0n;
  // Binary search tokensIn in [0, virtualToken * 2] (sells can exceed virtual inventory).
  let lo = 0n;
  let hi = c.virtualToken * 4n + 1n;
  // Cap search by a generous upper bound from constant-product invert.
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    try {
      const q = quoteCurveSell(market, mid);
      if (q.netThru <= c.realThru) lo = mid;
      else hi = mid - 1n;
    } catch {
      hi = mid - 1n;
    }
  }
  return lo;
}

async function syncCurveVaultFromChain(market) {
  if (!market?.curve?.address) return market;
  try {
    const snap = await getAccountSnapshot(market.curve.address);
    const onChainThru = snap.exists ? snap.balance : 0n;
    // Leave dust for the curve account to sign later txs when possible.
    const spendable = onChainThru > CURVE_GAS_FUND ? onChainThru - CURVE_GAS_FUND : onChainThru;
    let onChainTokens = BigInt(market.curve.realToken || "0");
    try {
      if (market.curve.tokenAccount) {
        onChainTokens = await readTokenAmount(market.curve.tokenAccount);
      }
    } catch { /* keep prior */ }
    const metaThru = BigInt(market.curve.realThru || "0");
    const metaToken = BigInt(market.curve.realToken || "0");
    // Always trust on-chain vault depth (fixes drained vaults after failed AMM attempts).
    if (spendable === metaThru && onChainTokens === metaToken) return market;
    return updateMarket(market.mintAddress, {
      curve: {
        realThru: spendable.toString(),
        realToken: onChainTokens.toString(),
      },
      updatedAt: Date.now(),
    }) || market;
  } catch {
    return market;
  }
}

function marketTimestamp(market) {
  return Number(market?.updatedAt || market?.createdAt || 0);
}

function marketCreatedAt(market) {
  return Number(market?.createdAt || market?.updatedAt || 0);
}

function marketVolumeThru(market) {
  const stats = market?.stats;
  if (stats) {
    try {
      return BigInt(stats.buyThru || "0") + BigInt(stats.sellThru || "0");
    } catch { /* fall through */ }
  }
  let vol = 0n;
  for (const p of readChart(market)) {
    if (p.side === "buy" || p.side === "sell") vol += BigInt(p.thru || "0");
  }
  return vol;
}

function marketCapProxy(market) {
  try {
    const price = BigInt(market?.lastPrice || "0");
    const supply = BigInt(market?.supply || "0");
    if (price <= 0n || supply <= 0n) return 0n;
    // lastPrice is THRU base units per 1 whole token; mcap ≈ price * supply.
    return price * supply;
  } catch {
    return 0n;
  }
}

function mergeChartPoints(a, b) {
  const map = new Map();
  for (const p of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!p) continue;
    const key = `${Number(p.t) || 0}|${p.side || ""}|${p.price || ""}|${p.thru || ""}|${p.tokens || ""}`;
    if (!map.has(key)) map.set(key, p);
  }
  return [...map.values()]
    .sort((x, y) => (Number(x.t) || 0) - (Number(y.t) || 0))
    .slice(-CHART_HISTORY);
}

function mergeCurveRecords(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  // Prefer the more-traded snapshot as a coherent set. virtualThru + virtualToken
  // must stay paired or price/chart stay flat while the other wallet moves.
  try {
    const realThruA = BigInt(a.realThru || "0");
    const realThruB = BigInt(b.realThru || "0");
    const virtThruA = BigInt(a.virtualThru || "0");
    const virtThruB = BigInt(b.virtualThru || "0");
    const preferA = realThruA > realThruB
      || (realThruA === realThruB && virtThruA >= virtThruB);
    const advanced = preferA ? a : b;
    const base = preferA ? b : a;
    return {
      ...base,
      ...advanced,
      realThru: advanced.realThru,
      realToken: advanced.realToken,
      virtualThru: advanced.virtualThru,
      virtualToken: advanced.virtualToken,
      privateKeyHex: a.privateKeyHex || b.privateKeyHex,
      address: a.address || b.address,
      tokenAccount: a.tokenAccount || b.tokenAccount,
      graduationTargetThru: advanced.graduationTargetThru || base.graduationTargetThru,
      tradeFeeBps: advanced.tradeFeeBps ?? base.tradeFeeBps,
    };
  } catch {
    return {
      ...a,
      ...b,
      privateKeyHex: a.privateKeyHex || b.privateKeyHex,
      tokenAccount: a.tokenAccount || b.tokenAccount,
      address: a.address || b.address,
    };
  }
}

function mergeTwoMarkets(a, b) {
  const newer = marketTimestamp(a) >= marketTimestamp(b) ? a : b;
  const older = newer === a ? b : a;
  const chart = mergeChartPoints(a.chart, b.chart);
  // lastPrice from newest real trade, not seed/hold flat ticks.
  let lastPrice = newer.lastPrice || older.lastPrice;
  const tradePts = chart.filter((p) => p && (p.side === "buy" || p.side === "sell"));
  if (tradePts.length && tradePts[tradePts.length - 1]?.price) {
    lastPrice = String(tradePts[tradePts.length - 1].price);
  } else if (chart.length && chart[chart.length - 1]?.price) {
    lastPrice = String(chart[chart.length - 1].price);
  }
  // Recompute trade stats from merged chart.
  let buys = 0;
  let sells = 0;
  let buyThru = 0n;
  let sellThru = 0n;
  for (const p of chart) {
    if (p.side === "buy") {
      buys += 1;
      buyThru += BigInt(p.thru || "0");
    } else if (p.side === "sell") {
      sells += 1;
      sellThru += BigInt(p.thru || "0");
    }
  }
  return {
    ...older,
    ...newer,
    createdAt: marketCreatedAt(a) && marketCreatedAt(b)
      ? Math.min(marketCreatedAt(a), marketCreatedAt(b))
      : (a.createdAt || b.createdAt),
    updatedAt: Math.max(marketTimestamp(a), marketTimestamp(b)),
    chart,
    lastPrice,
    image: newer.image || older.image || "",
    curve: mergeCurveRecords(a.curve, b.curve),
    graduated: Boolean(a.graduated || b.graduated),
    liquidity: a.liquidity || b.liquidity || false,
    phase: newer.phase || older.phase,
    stats: {
      buys,
      sells,
      buyThru: buyThru.toString(),
      sellThru: sellThru.toString(),
    },
  };
}

function marketImageHtml(market, className = "token-avatar") {
  const src = typeof market?.image === "string" ? market.image.trim() : "";
  if (src && (src.startsWith("data:image/") || /^https?:\/\//i.test(src))) {
    return `<img class="${className}" src="${src.replace(/"/g, "&quot;")}" alt="" />`;
  }
  const letter = (market?.ticker || market?.name || "?").slice(0, 1).toUpperCase();
  return `<span class="${className} token-avatar-fallback">${letter}</span>`;
}

function compressTokenImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      reject(new Error("Choose a PNG, JPEG, WebP, or GIF image."));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error("Image must be under 8 MB before compress."));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, TOKEN_IMAGE_MAX_DIM / Math.max(img.width || 1, img.height || 1));
        const width = Math.max(1, Math.round((img.width || 1) * scale));
        const height = Math.max(1, Math.round((img.height || 1) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable.");
        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(objectUrl);
        let quality = 0.84;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length > TOKEN_IMAGE_MAX_CHARS && quality > 0.35) {
          quality -= 0.12;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        if (dataUrl.length > TOKEN_IMAGE_MAX_CHARS) {
          reject(new Error("Image is still too large after compression. Try a simpler image."));
          return;
        }
        resolve(dataUrl);
      } catch (reason) {
        URL.revokeObjectURL(objectUrl);
        reject(reason instanceof Error ? reason : new Error("Could not process image."));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read that image file."));
    };
    img.src = objectUrl;
  });
}

function clearTokenImagePicker() {
  pendingTokenImage = null;
  const input = document.querySelector("[data-token-image]");
  const preview = document.querySelector("[data-token-image-preview]");
  const img = document.querySelector("[data-token-image-preview-img]");
  if (input) input.value = "";
  if (img) img.removeAttribute("src");
  if (preview) preview.hidden = true;
}

function setTokenImagePreview(dataUrl) {
  pendingTokenImage = dataUrl || null;
  const preview = document.querySelector("[data-token-image-preview]");
  const img = document.querySelector("[data-token-image-preview-img]");
  if (!preview || !img) return;
  if (!dataUrl) {
    preview.hidden = true;
    img.removeAttribute("src");
    return;
  }
  img.src = dataUrl;
  preview.hidden = false;
}

/** Diagnostic / probe mints never belong on the public Explore board. */
function isRegistryProbeMint(mid) {
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

function mergeMarketLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const market of list || []) {
      if (!market?.mintAddress || isRegistryProbeMint(market.mintAddress)) continue;
      const prev = map.get(market.mintAddress);
      map.set(market.mintAddress, prev ? mergeTwoMarkets(prev, market) : market);
    }
  }
  return [...map.values()]
    .sort((a, b) => marketTimestamp(b) - marketTimestamp(a))
    .slice(0, 100);
}

/** Serialize registry writes so concurrent tabs/visitors don't clobber each other. */
let registryPublishChain = Promise.resolve();

function withRegistryLock(fn) {
  const run = registryPublishChain.then(fn, fn);
  // Keep the chain alive even if fn rejects.
  registryPublishChain = run.then(() => {}, () => {});
  return run;
}

function sanitizeMarketForRegistry(market) {
  if (!market?.mintAddress) return null;
  // Keep curve private key — required for public bonding-curve fills on alphanet.
  const copy = { ...market };
  // Cap chart history hard for the public board (smaller writes survive free-tier limits).
  const maxChart = Math.min(CHART_HISTORY, 48);
  if (Array.isArray(copy.chart) && copy.chart.length > maxChart) {
    copy.chart = copy.chart.slice(-maxChart);
  }
  // Cap image size (base64) so the shared board stays under free-tier limits.
  if (typeof copy.image === "string" && copy.image.length > TOKEN_IMAGE_MAX_CHARS) {
    copy.image = "";
  }
  return copy;
}

function stampMarkets(markets) {
  return (markets || [])
    .map((market) => sanitizeMarketForRegistry({
      ...market,
      updatedAt: market.updatedAt || market.createdAt || Date.now(),
    }))
    .filter(Boolean)
    .slice(0, 100);
}

function saveMarkets(markets, { publish = true } = {}) {
  const stamped = stampMarkets(markets);
  localStorage.setItem(MARKETS_KEY, JSON.stringify(stamped));
  if (publish) {
    // Always merge with remote before PUT so we never wipe others' launches.
    pushMarketsToPublic(stamped).catch(() => { /* non-create paths stay soft-fail */ });
  }
  return stamped;
}

/**
 * Fetch one registry URL with a hard timeout + cache bust.
 * @returns {{ ok: boolean, markets: any[], error?: string, url: string }}
 */
function parseRegistryTime(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const asDate = Date.parse(String(value));
  return Number.isFinite(asDate) ? asDate : 0;
}

/** Stale wipe flags on free mirrors must not clear the board forever. */
const REGISTRY_WIPE_TTL_MS = 30 * 60 * 1000;

function isFreshRegistryWipe(wipedAt) {
  const ts = parseRegistryTime(wipedAt);
  if (!ts) return false;
  return Date.now() - ts < REGISTRY_WIPE_TTL_MS;
}

async function fetchPublicMarketsFrom(url, { timeoutMs = REGISTRY_FETCH_TIMEOUT_MS } = {}) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const bust = `${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
    const response = await fetch(`${url}${bust}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      // Never serve a stale public board from browser/CDN cache.
      cache: "no-store",
      mode: "cors",
      signal: controller?.signal,
    });
    if (!response.ok) {
      return { ok: false, markets: [], error: `HTTP ${response.status}`, url };
    }
    const data = await response.json();
    const markets = Array.isArray(data.markets)
      ? data.markets
      : Array.isArray(data) ? data : [];
    const updatedAt = parseRegistryTime(data?.updatedAt);
    const wipedAt = parseRegistryTime(data?.wipedAt || data?.updatedAt);
    const apiWiped = Boolean(data?.wiped) && markets.length === 0;
    // Prefer server `wiped` flag (already TTL-aware). Ignore stale wipe fields.
    return {
      ok: true,
      markets,
      url,
      wiped: apiWiped && isFreshRegistryWipe(wipedAt || updatedAt),
      updatedAt,
      wipedAt,
    };
  } catch (reason) {
    const aborted = reason?.name === "AbortError";
    return {
      ok: false,
      markets: [],
      error: aborted
        ? "timeout"
        : reason instanceof Error ? reason.message : "network error",
      url,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * JSONBlob mirrors only (not static markets-board.json).
 */
async function fetchMirrorMarkets() {
  const lists = [];
  let newestWipeAt = 0;
  let wipeVotes = 0;
  let blobOk = 0;
  const now = Date.now();
  await Promise.all(MARKET_BLOB_URLS.map(async (url) => {
    try {
      const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        mode: "cors",
      });
      if (!response.ok) return;
      blobOk += 1;
      const data = await response.json();
      const markets = Array.isArray(data?.markets)
        ? data.markets
        : Array.isArray(data) ? data : [];
      const updatedAt = parseRegistryTime(
        data && typeof data === "object" && !Array.isArray(data) ? data.updatedAt : 0,
      );
      const wipedAt = parseRegistryTime(
        data && typeof data === "object" && !Array.isArray(data)
          ? (data.wipedAt || data.updatedAt)
          : 0,
      );
      const wipeFresh = wipedAt > 0 && now - wipedAt < REGISTRY_WIPE_TTL_MS;
      const isWipe = Boolean(
        data
        && typeof data === "object"
        && !Array.isArray(data)
        && (data.wipe || data.forceEmpty)
        && markets.length === 0
        && wipeFresh,
      );
      if (isWipe) {
        wipeVotes += 1;
        newestWipeAt = Math.max(newestWipeAt, wipedAt || updatedAt);
        return;
      }
      // Non-empty boards always count (even if an old wipe flag is still set).
      if (markets.length) lists.push({ markets, updatedAt });
    } catch {
      /* ignore */
    }
  }));

  const markets = stampMarkets(mergeMarketLists(...lists.map((e) => e.markets)));
  // Fresh wipe only if majority agree AND no blob still has markets.
  const wipeConsensus = wipeVotes > 0
    && wipeVotes >= Math.ceil(Math.max(blobOk, 1) / 2)
    && markets.length === 0;
  return {
    markets,
    wiped: wipeConsensus,
    wipedAt: wipeConsensus ? newestWipeAt : 0,
  };
}

/**
 * Read the public board from /api/markets + durable mirrors.
 * CRITICAL: failed fetches must NOT be treated as empty boards.
 * Stale wipe mirrors must NOT erase a live API board (show-then-vanish bug).
 */
async function fetchPublicMarketsDetailed({ mode = "full" } = {}) {
  void mode;
  const [result, mirrorResult] = await Promise.all([
    fetchPublicMarketsFrom(MARKET_REGISTRY_API, {
      timeoutMs: REGISTRY_FETCH_TIMEOUT_MS,
    }),
    fetchMirrorMarkets(),
  ]);
  const mirrors = mirrorResult.markets || [];
  const mirrorWiped = Boolean(mirrorResult.wiped);
  const apiMarkets = result.ok ? (result.markets || []) : [];

  // Live markets always win over a lagging wipe payload.
  if (apiMarkets.length || mirrors.length) {
    const markets = stampMarkets(mergeMarketLists(apiMarkets, mirrors));
    lastPublicBoard = { ok: true, count: markets.length, error: "" };
    return {
      ok: true,
      markets,
      durable: mirrors.length > 0 || result.ok,
      wiped: false,
    };
  }

  const wipeAt = mirrorResult.wipedAt || result.updatedAt || 0;
  const freshWipe = (result.ok && result.wiped && isFreshRegistryWipe(wipeAt))
    || (mirrorWiped && isFreshRegistryWipe(mirrorResult.wipedAt));

  // Both empty: only treat as intentional wipe when it is *fresh*.
  // Stale wipe:true left on JSONBlob must not zero the registry forever.
  if (result.ok && freshWipe) {
    lastPublicBoard = { ok: true, count: 0, error: "" };
    return {
      ok: true,
      markets: [],
      durable: true,
      wiped: true,
      wipedAt: wipeAt,
    };
  }

  if (!result.ok) {
    if (mirrorWiped && isFreshRegistryWipe(mirrorResult.wipedAt)) {
      lastPublicBoard = { ok: true, count: 0, error: "" };
      return {
        ok: true,
        markets: [],
        durable: true,
        wiped: true,
        wipedAt: mirrorResult.wipedAt || 0,
      };
    }
    lastPublicBoard = {
      ok: false,
      count: 0,
      error: result.error || "Public board unreachable",
    };
    return { ok: false, markets: [], error: lastPublicBoard.error };
  }

  // Empty API, no *fresh* wipe — valid empty board, do not clear local ghosts
  // via wiped:true (callers keep/merge local).
  lastPublicBoard = { ok: true, count: 0, error: "" };
  return { ok: true, markets: [], durable: true, wiped: false };
}

async function fetchPublicMarkets() {
  const result = await fetchPublicMarketsDetailed();
  return result.markets;
}

/**
 * Write the board to every JSONBlob mirror from the browser.
 * Belt-and-suspenders for friend visibility when the API instance is cold.
 */
async function publishToBlobMirrors(markets) {
  const cleaned = stampMarkets(markets);
  const payload = {
    markets: cleaned,
    updatedAt: Date.now(),
    note: "GenesisPad public market registry",
    wipe: false,
    forceEmpty: false,
    wipedAt: 0,
  };
  const body = JSON.stringify(payload);
  // Sequential writes — parallel PUTs hit JSONBlob 429s and leave mirrors empty,
  // which made tokens flash on Explore then disappear on the next poll.
  let anyOk = false;
  for (let index = 0; index < MARKET_BLOB_URLS.length; index += 1) {
    const url = MARKET_BLOB_URLS[index];
    if (index > 0) await new Promise((r) => setTimeout(r, 400));
    let ok = false;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          mode: "cors",
          cache: "no-store",
        });
        if (response.ok) {
          ok = true;
          break;
        }
        if (response.status === 429) {
          await new Promise((r) => setTimeout(r, 700 * attempt * attempt));
          continue;
        }
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    if (ok) anyOk = true;
  }
  return anyOk;
}

/**
 * Publish markets through same-origin /api/markets + durable blob mirrors.
 * No GitHub login — same simple flow as before.
 * @returns {{ markets: any[], durable: boolean }}
 */
async function publishPublicMarkets(markets, { stripImages = false } = {}) {
  let cleaned = stampMarkets(markets);
  if (stripImages) {
    cleaned = cleaned.map(({ image, ...rest }) => rest);
  }
  const payload = {
    markets: cleaned,
    updatedAt: Date.now(),
    note: "GenesisPad public market registry",
  };
  const body = JSON.stringify(payload);

  // Fan out: API (merge + server mirrors) and direct browser blob writes.
  const [apiOutcome, blobOk] = await Promise.all([
    (async () => {
      const response = await fetch(MARKET_REGISTRY_API, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        cache: "no-store",
      });
      if (!response.ok) {
        if (!stripImages && body.length > 120_000) {
          return { retryStrip: true };
        }
        let detail = "";
        try {
          const err = await response.json();
          detail = err?.error ? `: ${err.error}` : "";
        } catch { /* ignore */ }
        throw new Error(`Public board publish failed (${response.status})${detail}`);
      }
      const data = await response.json();
      if (!Array.isArray(data?.markets)) {
        throw new Error("Public board publish returned an invalid payload.");
      }
      return {
        markets: stampMarkets(data.markets),
        durable: Boolean(data.durable),
      };
    })(),
    publishToBlobMirrors(cleaned).catch(() => false),
  ]);

  if (apiOutcome?.retryStrip) {
    return publishPublicMarkets(markets, { stripImages: true });
  }

  const durable = Boolean(apiOutcome.durable || blobOk);
  // Prefer the merged API board, but ensure our payload is never lost.
  const merged = stampMarkets(mergeMarketLists(apiOutcome.markets, cleaned));
  return { markets: merged, durable };
}

function mintSet(markets) {
  return new Set((markets || []).map((m) => m?.mintAddress).filter(Boolean));
}

function remoteHasMint(markets, mintAddress) {
  if (!mintAddress) return true;
  return (markets || []).some((m) => m?.mintAddress === mintAddress);
}

/**
 * Fetch remote → merge with local → publish via /api/markets + blob mirrors.
 * When requireMint is set (create flow), success requires the mint on a durable
 * re-read so friends on other devices/instances can see it — not just warm memory.
 *
 * Never re-publish wiped/deleted tokens from localStorage. Only push:
 *  - markets already on the public board (live updates), and
 *  - recent local-only markets / requireMint (new launches).
 */
async function pushMarketsToPublic(localMarkets, { requireMint = null, attempts = 5 } = {}) {
  return withRegistryLock(async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const remoteResult = await fetchPublicMarketsDetailed();
        const remote = remoteResult.ok ? remoteResult.markets : [];
        const remoteMints = mintSet(remote);
        const now = Date.now();

        // Fresh wipe only — stale wipe flags must not block re-publish of real markets.
        if (
          remoteResult.ok
          && remoteResult.wiped
          && remote.length === 0
          && isFreshRegistryWipe(remoteResult.wipedAt)
        ) {
          if (requireMint) {
            const onlyNew = stampMarkets((localMarkets || []).filter(
              (m) => m?.mintAddress === requireMint,
            ));
            if (!onlyNew.length) {
              throw new Error("Nothing to publish to the public board.");
            }
            const publishResult = await publishPublicMarkets(onlyNew);
            if (!remoteHasMint(publishResult.markets, requireMint) && !publishResult.durable) {
              throw new Error("Public board write did not stick on shared mirrors. Retrying…");
            }
            const publicView = stampMarkets(publishResult.markets);
            localStorage.setItem(MARKETS_KEY, JSON.stringify(publicView));
            lastPublicBoard = { ok: true, count: publicView.length, error: "" };
            return publicView;
          }
          // Soft no-op: keep local launches so Explore does not zero out.
          const keep = stampMarkets(localMarkets || []);
          localStorage.setItem(MARKETS_KEY, JSON.stringify(keep));
          lastPublicBoard = { ok: true, count: keep.length, error: "" };
          return keep;
        }

        const pushableLocal = (localMarkets || []).filter((market) => {
          if (!market?.mintAddress) return false;
          if (requireMint && market.mintAddress === requireMint) return true;
          if (remoteMints.has(market.mintAddress)) return true;
          // Heal empty public board: re-push local bonding-curve launches.
          if (market?.curve?.privateKeyHex) return true;
          const created = Number(market.createdAt || market.updatedAt || 0);
          return created > 0 && now - created < 24 * 60 * 60 * 1000;
        });
        const merged = stampMarkets(mergeMarketLists(remote, pushableLocal));

        if (remoteResult.ok) {
          const mergedMints = mintSet(merged);
          for (const mint of remoteMints) {
            if (!mergedMints.has(mint)) {
              throw new Error("Refusing to publish: would drop a public market.");
            }
          }
          if (!merged.length && remote.length) {
            localStorage.setItem(MARKETS_KEY, JSON.stringify(stampMarkets(remote)));
            lastPublicBoard = { ok: true, count: remote.length, error: "" };
            return stampMarkets(remote);
          }
        }

        if (!merged.length) {
          // Empty public board + nothing new to push: clear local ghosts.
          if (remoteResult.ok && remote.length === 0) {
            localStorage.setItem(MARKETS_KEY, JSON.stringify([]));
            lastPublicBoard = { ok: true, count: 0, error: "" };
            return [];
          }
          throw new Error("Nothing to publish to the public board.");
        }

        const publishResult = await publishPublicMarkets(merged);
        const published = publishResult.markets;

        if (requireMint && !remoteHasMint(published, requireMint)) {
          throw new Error(
            "Token was not present in the public board response. Retrying…",
          );
        }

        // Prefer the publish result; a lagging wipe re-read must not erase it.
        await new Promise((r) => setTimeout(r, 200));
        const confirmed = await fetchPublicMarketsDetailed();
        let publicView = published;
        if (confirmed.ok && !confirmed.wiped) {
          publicView = stampMarkets(mergeMarketLists(confirmed.markets, published));
        }
        publicView = stampMarkets(mergeMarketLists(publicView, merged));

        if (requireMint) {
          const wroteDurable = Boolean(publishResult.durable);
          const onPublished = remoteHasMint(published, requireMint);
          const onConfirm = confirmed.ok
            && !confirmed.wiped
            && remoteHasMint(confirmed.markets, requireMint);
          // Success if PUT body had the mint AND (durable write OR confirm saw it).
          // Do not fail solely because a lagging wipe re-read returned empty.
          if (!onPublished) {
            throw new Error(
              "Token was not present in the public board response. Retrying…",
            );
          }
          if (!wroteDurable && !onConfirm) {
            throw new Error(
              "Public board write did not stick on shared mirrors. Retrying…",
            );
          }
          if (!remoteHasMint(publicView, requireMint)) {
            publicView = stampMarkets(mergeMarketLists(publicView, published, merged));
          }
        }

        localStorage.setItem(MARKETS_KEY, JSON.stringify(publicView));
        registryLiveAt = Date.now();
        lastPublicBoard = { ok: true, count: publicView.length, error: "" };
        return publicView;
      } catch (reason) {
        lastError = reason;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    throw (lastError instanceof Error
      ? lastError
      : new Error("Could not publish markets to the public board."));
  });
}

function marketsSignature(markets) {
  return (markets || [])
    .map((m) => {
      const chart = Array.isArray(m.chart) ? m.chart : [];
      const trades = chart.filter((p) => p && (p.side === "buy" || p.side === "sell"));
      const lastTrade = trades.length ? trades[trades.length - 1] : null;
      return [
        m.mintAddress,
        marketTimestamp(m),
        chart.length,
        trades.length,
        m.lastPrice || "",
        m.curve?.realThru || "",
        m.curve?.virtualThru || "",
        m.curve?.virtualToken || "",
        lastTrade ? `${lastTrade.t}:${lastTrade.side}:${lastTrade.thru}` : "",
        m.image ? 1 : 0,
      ].join(":");
    })
    .join("|");
}

/** Push trade prints + curve state so friends see candles, tape, and mark-to-market. */
async function publishTradeActivity(market, statusEl = null) {
  if (!market?.mintAddress) return;
  const note = statusEl ? String(statusEl.textContent || "") : "";
  try {
    if (statusEl) statusEl.textContent = `${note} Publishing trade…`.trim();
    await pushMarketsToPublic(readMarkets(), {
      requireMint: market.mintAddress,
      attempts: 5,
    });
  } catch {
    // Soft retry — board may still catch the next poll.
    pushMarketsToPublic(readMarkets(), { attempts: 3 }).catch(() => {});
  }
}

/**
 * Merge remote registry into local storage and refresh open trade UI.
 * @param {{ mode?: "fast" | "full", publish?: boolean }} [opts]
 *  - mode "fast": first mirror wins (boot / perceived speed)
 *  - mode "full": merge every mirror (authoritative poll)
 *  - publish: when true (default on full), soft-push local extras in background
 */
/** If a sync is skipped because one is in-flight, run again after it finishes. */
let registrySyncQueued = false;

async function syncPublicMarkets({ mode = "full", publish = mode === "full" } = {}) {
  if (registrySyncing) {
    registrySyncQueued = true;
    return readMarkets();
  }
  registrySyncing = true;
  try {
    const local = readMarkets();
    // Friends need the full multi-mirror merge; "fast" is only for first paint.
    const remoteResult = await fetchPublicMarketsDetailed({ mode });

    // If the public board is unreachable, keep local and DO NOT publish
    // (publishing after a failed fetch was wiping everyone's board).
    if (!remoteResult.ok) {
      // Keep live clock ticking when we already have a local board to show.
      if (local.length) registryLiveAt = Date.now();
      if (!local.length) {
        lastPublicBoard = {
          ok: false,
          count: 0,
          error: remoteResult.error || "Public board unreachable",
        };
      }
      return local;
    }

    const remote = remoteResult.markets;
    const remoteMints = mintSet(remote);
    const now = Date.now();

    // Fresh intentional wipe only: drop old ghosts, keep very recent local launches.
    // Stale empty remote (or expired wipe flags) must NOT clear the registry UI.
    if (remoteResult.wiped && remote.length === 0 && isFreshRegistryWipe(remoteResult.wipedAt)) {
      const recentLocalOnly = (local || []).filter((market) => {
        if (!market?.mintAddress) return false;
        const created = Number(market.createdAt || market.updatedAt || 0);
        return created > 0 && now - created < 10 * 60 * 1000;
      });
      const kept = stampMarkets(recentLocalOnly);
      localStorage.setItem(MARKETS_KEY, JSON.stringify(kept));
      registryLiveAt = Date.now();
      lastPublicBoard = { ok: true, count: kept.length, error: "" };
      void publish;
      return kept;
    }

    // Merge remote with FULL local list so bonding-curve private keys / vault
    // accounts are never dropped when the remote board has a thinner record.
    // Keep local-only markets for 24h so a flaky empty remote cannot zero Explore.
    const LOCAL_ONLY_KEEP_MS = 24 * 60 * 60 * 1000;
    const mergedAll = stampMarkets(mergeMarketLists(remote, local || []));
    const merged = mergedAll.filter((market) => {
      if (!market?.mintAddress) return false;
      if (remoteMints.has(market.mintAddress)) return true;
      // Local-only: keep real launches (have curve key) for a day; short window otherwise.
      const created = Number(market.createdAt || market.updatedAt || 0);
      if (!(created > 0)) return false;
      if (market?.curve?.privateKeyHex) return now - created < LOCAL_ONLY_KEEP_MS;
      return now - created < 10 * 60 * 1000;
    });
    const before = marketsSignature(local);
    const after = marketsSignature(merged);
    localStorage.setItem(MARKETS_KEY, JSON.stringify(merged));
    registryLiveAt = Date.now();
    lastPublicBoard = { ok: true, count: Math.max(remote.length, merged.length), error: "" };

    // Heal public board when local has markets the remote lost (empty board / missing keys).
    const remoteByMint = new Map((remote || []).map((m) => [m.mintAddress, m]));
    const needsHeal = (merged || []).some((l) => {
      if (!l?.mintAddress || !l?.curve?.privateKeyHex) return false;
      const r = remoteByMint.get(l.mintAddress);
      if (!r) return true; // local launch missing from public board
      return !String(r?.curve?.privateKeyHex || "").trim();
    });
    if (needsHeal) {
      pushMarketsToPublic(merged, { attempts: 4 }).catch(() => {});
    }
    void publish;

    // Keep open trade modal + chart/tape live when remote activity lands
    // (friend buys must move your candle and appear in Trades).
    if (activeTrade?.mintAddress) {
      const fresh = merged.find((m) => m.mintAddress === activeTrade.mintAddress);
      if (fresh) {
        const prevSig = `${(activeTrade.chart || []).length}:${activeTrade.lastPrice}:${activeTrade.curve?.virtualThru}:${activeTrade.curve?.realThru}`;
        const nextSig = `${(fresh.chart || []).length}:${fresh.lastPrice}:${fresh.curve?.virtualThru}:${fresh.curve?.realThru}`;
        activeTrade = resolveTradeMarket(fresh) || fresh;
        if (before !== after || prevSig !== nextSig) {
          renderTokenChart(activeTrade);
          renderTradeTape(activeTrade);
          // Refresh quote if amount field has a value.
          try { updateTradeQuote(); } catch { /* ignore */ }
        }
      }
    }
    return readMarkets();
  } finally {
    registrySyncing = false;
    if (registrySyncQueued) {
      registrySyncQueued = false;
      // Catch up any poll that arrived mid-sync (friends see new launches faster).
      syncPublicMarkets({ mode: "full", publish: true }).catch(() => {});
    }
  }
}

function updateMarket(mintAddress, patch) {
  const markets = readMarkets();
  const index = markets.findIndex((m) => m.mintAddress === mintAddress);
  if (index < 0) return null;
  const prev = markets[index];
  markets[index] = {
    ...prev,
    ...patch,
    updatedAt: Date.now(),
  };
  if (patch.curve) {
    markets[index].curve = { ...(prev.curve || {}), ...patch.curve };
  }
  saveMarkets(markets);
  return markets[index];
}

function applyCurveState(market, next) {
  return updateMarket(market.mintAddress, {
    curve: {
      ...market.curve,
      virtualThru: next.virtualThru.toString(),
      virtualToken: next.virtualToken.toString(),
      realThru: next.realThru.toString(),
      realToken: next.realToken.toString(),
    },
  });
}

async function loadCurveSigner(market) {
  if (!market?.curve?.privateKeyHex) {
    throw new Error("Bonding curve key is missing from this market record.");
  }
  const privateKey = hexToBytes(market.curve.privateKeyHex);
  const publicKey = await client.keys.fromPrivateKey(privateKey);
  const address = Pubkey.from(publicKey).toThruFmt();
  if (market.curve.address && market.curve.address !== address) {
    throw new Error("Curve private key does not match the stored curve address.");
  }
  return { address, publicKey, privateKey };
}

async function submitAs(signer, program, {
  accounts, instructionData, fee = 0n, startSlot: anchoredStartSlot, programLabel = "Program",
}) {
  const snapshot = await getAccountSnapshot(signer.address);
  const slot = anchoredStartSlot ?? await currentSlot();
  let nonce = snapshot.nonce < 0n ? 0n : snapshot.nonce;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const { rawTransaction } = await client.transactions.buildAndSign({
        feePayer: { publicKey: signer.publicKey, privateKey: signer.privateKey },
        program,
        accounts,
        instructionData,
        header: {
          fee, nonce, startSlot: slot, expiryAfter: 100,
          computeUnits: 500000, memoryUnits: 10000, stateUnits: 10000, chainId: CHAIN_ID,
        },
      });
      await submitTransaction(rawTransaction, { programLabel });
      return;
    } catch (reason) {
      const message = String(reason?.message || reason);
      if (message.includes("-511")) { nonce += 1n; continue; }
      if (message.includes("-510")) { nonce = nonce > 0n ? nonce - 1n : 0n; continue; }
      throw reason;
    }
  }
  throw new Error("Could not find a valid account nonce for the curve signer.");
}

async function ensureAccountExistsFor(signer, setStatus = () => {}) {
  if ((await getAccountSnapshot(signer.address)).exists) return;
  setStatus("Opening the bonding-curve account…");
  // Match SDK accounts.createAccount: program 0x…03 + creation state proof (proofType 1).
  // Native transfers use all-zero program; account *creation* must use 0x…03.
  const proof = await client.proofs.generate({ address: signer.address, proofType: 1 });
  let nonce = 0n;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const { rawTransaction } = await client.transactions.buildAndSign({
        feePayer: { publicKey: signer.publicKey, privateKey: signer.privateKey },
        program: EOA_CREATE_PROGRAM,
        header: {
          fee: 0n, nonce, startSlot: proof.slot, expiryAfter: 100,
          computeUnits: 10000, memoryUnits: 10000, stateUnits: 10000, chainId: CHAIN_ID,
        },
        feePayerStateProof: proof.proof,
      });
      await submitTransaction(rawTransaction, { programLabel: "Curve account" });
      await waitForAccount(signer.address, "Bonding curve account");
      return;
    } catch (reason) {
      const message = String(reason?.message || reason);
      if (message.includes("-511")) { nonce += 1n; continue; }
      if (message.includes("-510")) { nonce = nonce > 0n ? nonce - 1n : 0n; continue; }
      throw reason;
    }
  }
  throw new Error("Could not open the bonding-curve account.");
}

async function fundCurveAccount(curveAddress, amount = CURVE_GAS_FUND) {
  if (amount <= 0n) return;
  const snap = await getAccountSnapshot(curveAddress);
  // Top up only when the curve is empty / very low.
  if (snap.exists && snap.balance >= amount) return;
  await submitProgramInstruction(EOA_PROGRAM, {
    accounts: { readWrite: [curveAddress] },
    instructionData: nativeTransferInstruction(amount),
    fee: NATIVE_TRANSFER_FEE,
    programLabel: "Fund curve",
  });
}

async function createBondingCurve({ mint, creatorTokenAccount, decimals, supplyWhole, setStatus }) {
  setStatus("Creating the bonding-curve vault…");
  const pair = await client.keys.generateKeyPair();
  const curveSigner = {
    address: pair.address,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };

  // Open the curve account first (fee 0 + state proof), then fund gas dust from creator.
  await ensureAccountExistsFor(curveSigner, setStatus);
  await fundCurveAccount(curveSigner.address, CURVE_GAS_FUND);

  setStatus("Creating the curve token inventory account…");
  const curveToken = await ensureTokenAccount(curveSigner.address, mint.address);

  const totalBase = supplyWhole * (10n ** BigInt(decimals));
  const curveTokens = (totalBase * CURVE_TOKEN_BPS) / 10000n;
  if (curveTokens <= 0n) throw new Error("Supply is too small for a bonding curve.");

  setStatus(`Seeding the curve with ${formatUnits(curveTokens, decimals)} tokens…`);
  await submitTokenTransfer(creatorTokenAccount, curveToken, curveTokens);

  const virtualThru = CURVE_VIRTUAL_THRU;
  const virtualToken = curveTokens;
  const oneToken = 10n ** BigInt(decimals);
  const startPrice = virtualToken > 0n ? (virtualThru * oneToken) / virtualToken : 0n;
  const now = Date.now();

  return {
    phase: "bonding",
    graduated: false,
    liquidity: false,
    lastPrice: startPrice.toString(),
    chart: [
      { t: now - 60_000, price: startPrice.toString(), side: "seed" },
      { t: now, price: startPrice.toString(), side: "seed" },
    ],
    curve: {
      address: curveSigner.address,
      privateKeyHex: bytesToHex(curveSigner.privateKey),
      tokenAccount: curveToken.address,
      tokenAccountBytesHint: bytesToHex(curveToken.bytes),
      virtualThru: virtualThru.toString(),
      virtualToken: virtualToken.toString(),
      realThru: "0",
      realToken: curveTokens.toString(),
      graduationTargetThru: GRADUATION_REAL_THRU.toString(),
      tradeFeeBps: Number(CURVE_TRADE_FEE_BPS),
    },
  };
}

async function graduateMarket(market, setStatus = () => {}) {
  if (!market?.curve) return market;
  if (market.graduated && market.liquidity) return market;

  // Do NOT pull THRU/tokens out of the curve here. A failed AMM seed used to drain
  // the vault and break sells. Graduation is accounting-only until AMM is reliable.
  setStatus("Graduation threshold reached…");
  const updated = updateMarket(market.mintAddress, {
    graduated: true,
    phase: "graduated",
    liquidity: false,
    liquidityPendingReason: "Graduated. Trading continues.",
    graduatedAt: market.graduatedAt || Date.now(),
    updatedAt: Date.now(),
  }) || market;
  return updated;
}

async function wrapThru(amount, destination) {
  if (amount <= 0n) throw new Error("Wrap amount must be positive.");
  let before = 0n;
  try {
    before = await readTokenAmount(destination.address);
  } catch {
    before = 0n;
  }
  // Native transfer program is the all-zero system program.
  await submitProgramInstruction(EOA_PROGRAM, {
    accounts: { readWrite: [WTHRU_VAULT] },
    instructionData: nativeTransferInstruction(amount),
    fee: NATIVE_TRANSFER_FEE,
    programLabel: "Native transfer",
  });
  await submitProgramInstruction(WTHRU_PROGRAM, {
    accounts: {
      readWrite: [WTHRU_MINT, WTHRU_VAULT, destination.address],
      readOnly: [TOKEN_PROGRAM],
    },
    instructionData: async (context) => {
      const data = new Uint8Array(12);
      const view = new DataView(data.buffer);
      view.setUint32(0, 1, true); // deposit
      view.setUint16(4, context.getAccountIndex(Pubkey.from(TOKEN_PROGRAM).toBytes()), true);
      view.setUint16(6, context.getAccountIndex(Pubkey.from(WTHRU_VAULT).toBytes()), true);
      view.setUint16(8, context.getAccountIndex(Pubkey.from(WTHRU_MINT).toBytes()), true);
      view.setUint16(10, context.getAccountIndex(destination.bytes), true);
      return data;
    },
    programLabel: "wTHRU",
  });
  // wTHRU mints 1:1 with native base units on Alphanet.
  const after = await readTokenAmount(destination.address);
  if (after < before + amount) {
    throw new Error(
      "Wrapped THRU was not credited. Refresh, check your balance, and try again.",
    );
  }
}

/** Burn wTHRU and receive native THRU (1:1 base units). */
async function unwrapThru(amount, source) {
  if (amount <= 0n) throw new Error("Unwrap amount must be positive.");
  const nativeBefore = (await getAccountSnapshot()).balance;
  let tokenBefore = 0n;
  try {
    tokenBefore = await readTokenAmount(source.address);
  } catch {
    tokenBefore = 0n;
  }
  if (tokenBefore < amount) {
    throw new Error(
      `Insufficient wTHRU. Available: ${formatUnits(tokenBefore, NATIVE_THRU_DECIMALS, 9)} wTHRU.`,
    );
  }
  await submitProgramInstruction(WTHRU_PROGRAM, {
    accounts: {
      readWrite: [WTHRU_MINT, WTHRU_VAULT, source.address],
      readOnly: [TOKEN_PROGRAM],
    },
    instructionData: async (context) => {
      // tag u32 + 6×u16 + amount u64
      const data = new Uint8Array(24);
      const view = new DataView(data.buffer);
      view.setUint32(0, 2, true); // withdraw
      view.setUint16(4, context.getAccountIndex(Pubkey.from(TOKEN_PROGRAM).toBytes()), true);
      view.setUint16(6, context.getAccountIndex(Pubkey.from(WTHRU_VAULT).toBytes()), true);
      view.setUint16(8, context.getAccountIndex(Pubkey.from(WTHRU_MINT).toBytes()), true);
      view.setUint16(10, context.getAccountIndex(source.bytes), true);
      view.setUint16(12, context.getAccountIndex(connectedAccount.publicKey), true); // owner
      view.setUint16(14, context.getAccountIndex(connectedAccount.publicKey), true); // recipient
      view.setBigUint64(16, amount, true);
      return data;
    },
    // Fee 0 so dust-only wallets can still recover wTHRU into native.
    fee: 0n,
    programLabel: "wTHRU",
  });
  const nativeAfter = (await getAccountSnapshot()).balance;
  if (nativeAfter < nativeBefore + amount) {
    throw new Error(
      "Native THRU was not credited after unwrap. Refresh and check both balances.",
    );
  }
}

function bytesToHexSeed(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function derivePool(mintAddress) {
  if (!connectedAccount) {
    throw new Error("Connect a Thru wallet before deriving a pool.");
  }
  const pool = deriveAmmPoolAddresses(client, {
    ammProgramAddress: GENESIS_AMM_PROGRAM,
    mintAAddress: mintAddress,
    mintBAddress: WTHRU_MINT,
    swapFeeBps: CREATOR_FEE_BPS,
  });
  // Token program requires the mint *creator* to authorize creation (fee payer).
  // Seed the LP mint with the pool address so each pool gets a unique LP mint;
  // mint authority remains the pool PDA so the AMM can mint LP tokens later.
  const lpRawSeed = pool.poolBytes;
  const lpMint = deriveMintAddress(
    client, connectedAccount.address, bytesToHexSeed(lpRawSeed), TOKEN_PROGRAM,
  );
  const vaultOne = deriveTokenAccountAddress(
    client, pool.poolAddress, pool.mintOneAddress, TOKEN_PROGRAM, pool.vaultOneSeed,
  );
  const vaultTwo = deriveTokenAccountAddress(
    client, pool.poolAddress, pool.mintTwoAddress, TOKEN_PROGRAM, pool.vaultTwoSeed,
  );
  return { ...pool, lpMint, lpRawSeed, vaultOne, vaultTwo };
}

async function ensureLpMint(pool, setStatus) {
  if ((await getAccountSnapshot(pool.lpMint.address)).exists) return pool.lpMint;
  setStatus("Creating the LP mint…");
  const proof = await client.proofs.generate({
    address: pool.lpMint.address, proofType: 1,
  });
  await submitTokenInstruction({
    accounts: { readWrite: [pool.lpMint.address] },
    instructionData: createInitializeMintInstruction({
      mintAccountBytes: pool.lpMint.bytes,
      decimals: AMM_LP_DECIMALS,
      mintAuthorityBytes: pool.poolBytes,
      freezeAuthorityBytes: null,
      ticker: "GEN-LP",
      seedHex: bytesToHexSeed(pool.lpRawSeed),
      stateProof: proof.proof,
      creatorBytes: connectedAccount.publicKey,
    }),
  });
  await waitForAccount(pool.lpMint.address, "LP mint");
  return pool.lpMint;
}

async function ensurePoolVaults(pool, setStatus) {
  setStatus("Creating pool vault accounts…");
  const vaultOne = await ensureTokenAccount(
    pool.poolAddress, pool.mintOneAddress, pool.vaultOneSeed,
  );
  const vaultTwo = await ensureTokenAccount(
    pool.poolAddress, pool.mintTwoAddress, pool.vaultTwoSeed,
  );
  return { vaultOne, vaultTwo };
}

async function seedPool({ mint, tokenAccount, decimals, thruAmount, tokenAmount, setStatus }) {
  const pool = derivePool(mint.address);
  const creatorWthru = await ensureTokenAccount(connectedAccount.address, WTHRU_MINT);
  setStatus(`Wrapping ${formatUnits(thruAmount, NATIVE_THRU_DECIMALS, 9)} THRU…`);
  await wrapThru(thruAmount, creatorWthru);

  // Create LP mint + vaults first (token program). Pool PDA is only a pubkey here.
  await ensureLpMint(pool, setStatus);
  await ensurePoolVaults(pool, setStatus);

  const poolSnap = await getAccountSnapshot(pool.poolAddress);
  let poolReady = false;
  if (poolSnap.exists) {
    try {
      const meta = await client.accounts.get(pool.poolAddress, { view: AccountView.META_ONLY });
      poolReady = Number(meta.meta?.dataSize ?? 0) >= 203;
    } catch {
      poolReady = false;
    }
  }

  if (!poolReady) {
    setStatus("Initializing the 0.21% creator-fee AMM pool…");
    const needsCreate = !poolSnap.exists;
    const poolProof = needsCreate
      ? await client.proofs.generate({ address: pool.poolAddress, proofType: 1 })
      : { proof: new Uint8Array(), slot: await currentSlot() };
    await submitProgramInstruction(GENESIS_AMM_PROGRAM, {
      accounts: {
        readWrite: [
          pool.poolAddress, pool.lpMint.address, pool.vaultOne.address, pool.vaultTwo.address,
        ],
        readOnly: [pool.mintOneAddress, pool.mintTwoAddress, TOKEN_PROGRAM],
      },
      instructionData: createInitPoolInstruction({
        payerAccountBytes: connectedAccount.publicKey,
        poolAccountBytes: pool.poolBytes,
        lpMintAccountBytes: pool.lpMint.bytes,
        vaultOneAccountBytes: pool.vaultOne.bytes,
        vaultTwoAccountBytes: pool.vaultTwo.bytes,
        mintOneAccountBytes: pool.mintOneBytes,
        mintTwoAccountBytes: pool.mintTwoBytes,
        tokenProgramAccountBytes: Pubkey.from(TOKEN_PROGRAM).toBytes(),
        swapFeeBps: CREATOR_FEE_BPS,
        lpMintSeed: pool.poolSeed,
        poolStateProof: poolProof.proof,
        lpMintStateProof: new Uint8Array(),
        vaultOneStateProof: new Uint8Array(),
        vaultTwoStateProof: new Uint8Array(),
      }),
      startSlot: poolProof.slot,
      programLabel: "AMM",
    });
    await waitForAccount(pool.poolAddress, "AMM pool");
  }

  setStatus("Depositing the opening liquidity…");
  const creatorLp = await ensureTokenAccount(connectedAccount.address, pool.lpMint.address);
  const tokenIsOne = pool.mintOneAddress === mint.address;
  const depositorOne = tokenIsOne ? tokenAccount : creatorWthru;
  const depositorTwo = tokenIsOne ? creatorWthru : tokenAccount;
  // wTHRU uses the same base units as the native amount transferred into the vault.
  const amountOne = tokenIsOne ? tokenAmount : thruAmount;
  const amountTwo = tokenIsOne ? thruAmount : tokenAmount;
  assertInitialLiquidityAmounts(amountOne, amountTwo);
  // Preflight balances — wrap must have credited wTHRU before the AMM deposit.
  const wthruBal = await readTokenAmount(creatorWthru.address);
  const tokenBal = await readTokenAmount(tokenAccount.address);
  if (wthruBal < thruAmount) {
    throw new Error(
      `Need ${formatUnits(thruAmount, NATIVE_THRU_DECIMALS, 9)} wTHRU to seed, but this wallet only has ` +
      `${formatUnits(wthruBal, NATIVE_THRU_DECIMALS, 9)} wTHRU. Wrap native THRU first.`,
    );
  }
  if (tokenBal < tokenAmount) {
    throw new Error(
      `Need ${formatUnits(tokenAmount, decimals)} tokens to seed, but the mint account only holds ` +
      `${formatUnits(tokenBal, decimals)}.`,
    );
  }
  await submitProgramInstruction(GENESIS_AMM_PROGRAM, {
    accounts: {
      readWrite: [
        pool.poolAddress, depositorOne.address, depositorTwo.address, creatorLp.address,
        pool.vaultOne.address, pool.vaultTwo.address, pool.lpMint.address,
      ],
      readOnly: [TOKEN_PROGRAM],
    },
    instructionData: createAddLiquidityInstruction({
      poolAccountBytes: pool.poolBytes,
      depositorAccountBytes: connectedAccount.publicKey,
      depositorTokenOneAccountBytes: depositorOne.bytes,
      depositorTokenTwoAccountBytes: depositorTwo.bytes,
      depositorLpAccountBytes: creatorLp.bytes,
      vaultOneAccountBytes: pool.vaultOne.bytes,
      vaultTwoAccountBytes: pool.vaultTwo.bytes,
      lpMintAccountBytes: pool.lpMint.bytes,
      tokenProgramAccountBytes: Pubkey.from(TOKEN_PROGRAM).toBytes(),
      maxAmountMintOne: amountOne,
      maxAmountMintTwo: amountTwo,
    }),
  });
  return {
    poolAddress: pool.poolAddress,
    lpMint: pool.lpMint.address,
    vaultOne: pool.vaultOne.address,
    vaultTwo: pool.vaultTwo.address,
    mintOne: pool.mintOneAddress,
    mintTwo: pool.mintTwoAddress,
    creatorLpAccount: creatorLp.address,
    creatorWthruAccount: creatorWthru.address,
    seededThru: formatUnits(thruAmount, NATIVE_THRU_DECIMALS, 9),
    seededTokens: formatUnits(tokenAmount, decimals),
  };
}

/** When set, the create button retries board publish only (does not re-mint). */
let pendingPublishRetryMint = null;

async function retryPublicPublishOnly(mintAddress, ticker = "Token") {
  createButton.disabled = true;
  createStatus.textContent = "Retrying public board publish…";
  try {
    await pushMarketsToPublic(readMarkets(), { requireMint: mintAddress, attempts: 6 });
    await syncPublicMarkets({ mode: "full", publish: false });
    renderMarkets();
    pendingPublishRetryMint = null;
    createStatus.textContent =
      `${ticker} is now public on the shared board. Mint: ${mintAddress}`;
    createButton.textContent = "Token created on Thru";
  } catch (retryError) {
    createStatus.textContent =
      `Still not public: ${retryError instanceof Error ? retryError.message : "unknown error"}. Tap retry again.`;
    createButton.textContent = "Retry public publish";
  } finally {
    createButton.disabled = false;
  }
}

async function createToken() {
  if (!connectedAccount) {
    openWallet();
    return;
  }

  // Creator already minted; only the public board failed.
  if (pendingPublishRetryMint) {
    const existing = readMarkets().find((m) => m.mintAddress === pendingPublishRetryMint);
    await retryPublicPublishOnly(
      pendingPublishRetryMint,
      existing?.ticker || "Token",
    );
    return;
  }

  const name = document.querySelector("[data-token-name]").value.trim();
  const ticker = document.querySelector("[data-token-ticker]").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const description = document.querySelector("[data-token-description]").value.trim();
  const decimals = Number(document.querySelector("[data-token-decimals]").value);
  const supplyText = document.querySelector("[data-token-supply]").value.trim();
  const image = pendingTokenImage || "";
  createStatus.textContent = "Validating market details…";

  if (!name || !ticker) {
    createStatus.textContent = "Enter a token name and ticker.";
    return;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    createStatus.textContent = "Decimals must be a whole number from 0 to 9.";
    return;
  }
  if (supplyText && !/^\d+$/.test(supplyText)) {
    createStatus.textContent = "Initial supply must be a whole number without commas.";
    return;
  }
  const supply = supplyText ? BigInt(supplyText) : 0n;
  if (supply <= 0n) {
    createStatus.textContent = "Initial supply must be greater than zero for a bonding-curve launch.";
    return;
  }

  createButton.disabled = true;
  try {
    createStatus.textContent = "Preparing your Thru account…";
    await ensureAccountExists((message) => { createStatus.textContent = message; });
    const nativeBalance = await getAccountSnapshot();
    const needBalance = CURVE_GAS_FUND + 2n;
    if (nativeBalance.balance < needBalance) {
      throw new Error(
        `Insufficient balance: you have ${formatUnits(nativeBalance.balance, NATIVE_THRU_DECIMALS, 9)} THRU. ` +
        "Claim faucet THRU to fund the bonding-curve gas dust.",
      );
    }

    const authority = connectedAccount.publicKey;
    const seed = randomHex(32);
    const mint = deriveMintAddress(client, connectedAccount.address, seed, TOKEN_PROGRAM);
    createStatus.textContent = "Creating the token mint on Thru…";
    const mintProof = await client.proofs.generate({ address: mint.address, proofType: 1 });
    await submitTokenInstruction({
      accounts: { readWrite: [mint.address] },
      instructionData: createInitializeMintInstruction({
        mintAccountBytes: mint.bytes,
        decimals,
        mintAuthorityBytes: authority,
        creatorBytes: authority,
        ticker,
        seedHex: seed,
        stateProof: mintProof.proof,
      }),
    });
    await waitForAccount(mint.address, "Token mint");

    const tokenSeed = new Uint8Array(32);
    const tokenAccount = deriveTokenAccountAddress(
      client,
      connectedAccount.address,
      mint.address,
      TOKEN_PROGRAM,
      tokenSeed,
    );
    createStatus.textContent = "Creating your token account…";
    const tokenProof = await client.proofs.generate({ address: tokenAccount.address, proofType: 1 });
    await submitTokenInstruction({
      accounts: { readWrite: [tokenAccount.address], readOnly: [mint.address] },
      instructionData: createInitializeAccountInstruction({
        tokenAccountBytes: tokenAccount.bytes,
        mintAccountBytes: mint.bytes,
        ownerAccountBytes: authority,
        seedBytes: tokenSeed,
        stateProof: tokenProof.proof,
      }),
    });
    await waitForAccount(tokenAccount.address, "Token account");

    if (supply > 0n) {
      createStatus.textContent = `Minting ${supply.toLocaleString()} ${ticker}…`;
      await submitTokenInstruction({
        accounts: { readWrite: [mint.address, tokenAccount.address] },
        instructionData: createMintToInstruction({
          mintAccountBytes: mint.bytes,
          destinationAccountBytes: tokenAccount.bytes,
          authorityAccountBytes: authority,
          amount: supply * (10n ** BigInt(decimals)),
        }),
      });
    }

    const bondingMeta = await createBondingCurve({
      mint,
      creatorTokenAccount: tokenAccount,
      decimals,
      supplyWhole: supply,
      setStatus: (message) => { createStatus.textContent = message; },
    });

    const market = {
      name,
      ticker,
      description,
      image,
      decimals,
      supply: supply.toString(),
      mintAddress: mint.address,
      tokenAccount: tokenAccount.address,
      creator: connectedAccount.address,
      createdAt: Date.now(),
      mode: "curve",
      phase: bondingMeta.phase || "bonding",
      graduated: false,
      liquidity: false,
      liquidityRequested: false,
      liquidityPendingReason: "",
      priceTokensPerThru: PRICE_TOKENS_PER_THRU.toString(),
      creatorFeeBps: CREATOR_FEE_BPS,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      protocolTreasury: GENESIS_TREASURY,
      graduationTargetThru: GRADUATION_REAL_THRU.toString(),
      ...bondingMeta,
    };
    const markets = readMarkets();
    markets.unshift(market);
    // Save locally first so the creator always sees the market.
    saveMarkets(markets, { publish: false });
    renderMarkets();
    createStatus.textContent = "Publishing to the public board so everyone can see it…";
    try {
      await pushMarketsToPublic(markets, { requireMint: mint.address, attempts: 6 });
      // Force a full remote pull so creator UI matches what friends will load.
      await syncPublicMarkets({ mode: "full", publish: false });
      renderMarkets();
      createStatus.textContent =
        `${ticker} is live on the public board. Anyone on Genesis can buy/sell. ` +
        `Graduation at ${formatUnits(GRADUATION_REAL_THRU, NATIVE_THRU_DECIMALS, 9)} THRU raised. Mint: ${mint.address}`;
      createButton.textContent = "Token created on Thru";
    } catch (publishError) {
      // Keep the on-chain token; surface that the public board failed so the creator can retry.
      pendingPublishRetryMint = mint.address;
      createStatus.textContent =
        `${ticker} is on-chain, but the public board publish failed: ` +
        `${publishError instanceof Error ? publishError.message : "unknown error"}. ` +
        "Tap “Retry public publish” — do not assume friends can see it yet. " +
        `Mint: ${mint.address}`;
      createButton.textContent = "Retry public publish";
      // Background attempts while creator reads the message.
      pushMarketsToPublic(readMarkets(), { requireMint: mint.address, attempts: 4 })
        .then(async () => {
          await syncPublicMarkets({ mode: "full", publish: false });
          renderMarkets();
          pendingPublishRetryMint = null;
          if (createStatus) {
            createStatus.textContent =
              `${ticker} is now public on the shared board. Mint: ${mint.address}`;
          }
          createButton.textContent = "Token created on Thru";
        })
        .catch(() => {});
    }
    clearTokenImagePicker();
  } catch (reason) {
    createStatus.textContent = reason instanceof Error ? reason.message : "Token creation failed.";
  } finally {
    createButton.disabled = false;
  }
}

function readMarkets() {
  try {
    return JSON.parse(localStorage.getItem(MARKETS_KEY) || "[]");
  } catch {
    return [];
  }
}

function marketStatusLabel(market) {
  if (market.phase === "amm" || market.liquidity) return "AMM live";
  if (market.graduated || market.phase === "graduated") return "Graduated";
  if (market.curve) return `Curve ${curveProgress(market).toFixed(0)}%`;
  if (market.liquidityPendingReason) return "AMM pending";
  return "Awaiting pool";
}

function marketCardMedia(market) {
  const src = typeof market?.image === "string" ? market.image.trim() : "";
  const letter = (market?.ticker || market?.name || "?").slice(0, 1).toUpperCase();
  if (src && (src.startsWith("data:image/") || /^https?:\/\//i.test(src))) {
    return `<img class="token-card-img" src="${src.replace(/"/g, "&quot;")}" alt="" loading="lazy" />`;
  }
  return `<div class="token-card-img token-card-img-fallback" aria-hidden="true">${letter}</div>`;
}

function renderMarketCard(market, index) {
  const progress = market.curve ? curveProgress(market) : (market.liquidity ? 100 : 0);
  const stats = readTradeStats(market);
  const last = market.lastPrice
    ? BigInt(market.lastPrice)
    : (stats.points.length ? BigInt(stats.points[stats.points.length - 1].price) : 0n);
  const priceLabel = last > 0n ? formatSpotPrice(last) : "—";
  const status = marketStatusLabel(market);
  const graduated = isGraduatedMarket(market);
  return `
    <article class="token-card${graduated ? " is-graduated" : ""}">
      <button type="button" class="token-card-hit" data-open-market="${index}" title="Open ${market.ticker}">
        <div class="token-card-media">
          ${marketCardMedia(market)}
          ${graduated ? `<span class="token-card-badge">Graduated</span>` : ""}
        </div>
        <div class="token-card-body">
          <div class="token-card-title">
            <strong>${market.name}</strong>
            <span>$${market.ticker}</span>
          </div>
          <div class="token-card-meta">
            <small>${priceLabel}</small>
            <small class="market-mini-stats"><b class="stat-buy">${stats.buys}B</b> · <b class="stat-sell">${stats.sells}S</b></small>
          </div>
          <div class="curve-progress token-card-progress" title="Bonding progress to graduation">
            <div class="curve-progress-bar"><i style="width:${progress}%"></i></div>
            <span class="liquidity-state">${status}</span>
          </div>
        </div>
      </button>
      <div class="token-card-actions trade-actions">
        <button type="button" data-trade="${index}" data-trade-side="buy">Buy</button>
        <button type="button" data-trade="${index}" data-trade-side="sell">Sell</button>
      </div>
    </article>`;
}

function filterAndSortMarkets(markets) {
  const now = Date.now();
  const ageMs = marketAge === "24h"
    ? 86_400_000
    : marketAge === "7d"
      ? 7 * 86_400_000
      : 0;
  const q = marketQuery.toLowerCase();

  let list = markets.map((market, index) => ({ market, index }));

  if (marketSort === "graduated") {
    list = list.filter(({ market }) => isGraduatedMarket(market));
  }

  if (ageMs > 0) {
    list = list.filter(({ market }) => {
      const ts = Math.max(marketTimestamp(market), marketCreatedAt(market));
      return ts > 0 && now - ts <= ageMs;
    });
  }

  if (q) {
    list = list.filter(({ market }) => {
      const hay = [
        market.name,
        market.ticker,
        market.mintAddress,
        market.description,
        market.creator,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  const cmpBig = (a, b) => (a === b ? 0 : a > b ? -1 : 1);
  list.sort((a, b) => {
    if (marketSort === "newest") {
      return marketCreatedAt(b.market) - marketCreatedAt(a.market);
    }
    if (marketSort === "market") {
      const cap = cmpBig(marketCapProxy(b.market), marketCapProxy(a.market));
      return cap || (marketTimestamp(b.market) - marketTimestamp(a.market));
    }
    if (marketSort === "volume") {
      const vol = cmpBig(marketVolumeThru(b.market), marketVolumeThru(a.market));
      return vol || (marketTimestamp(b.market) - marketTimestamp(a.market));
    }
    // recent activity + graduated (default recency)
    return marketTimestamp(b.market) - marketTimestamp(a.market);
  });

  return list;
}

function updateRegistryLiveBadge() {
  // Always show a calm public status from the markets currently listed.
  // Do not flash "Board offline · local only" — that scared people even when
  // markets were already shared successfully.
  const n = readMarkets().length;
  document.querySelectorAll("[data-registry-live]").forEach((el) => {
    if (!registryLiveAt) {
      el.textContent = "Syncing…";
      el.dataset.state = "syncing";
      el.removeAttribute("title");
      return;
    }
    const ageSec = Math.max(0, Math.round((Date.now() - registryLiveAt) / 1000));
    el.textContent = ageSec < 4
      ? `Live · ${n}`
      : `Live · ${n} · ${ageSec}s`;
    el.dataset.state = "live";
    el.title = "Public registry shared with every visitor";
  });
}

function marketBoardHtml(markets, indexed) {
  if (!markets.length) {
    const stillSyncing = !registryLiveAt;
    return `
      <div class="token-empty">
        <div class="pulse-chart" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <h3>${stillSyncing ? "Loading live markets…" : "The registry is quiet."}</h3>
        <p>${stillSyncing
          ? "Pulling the public board — this should only take a moment."
          : "Launches are public. Create a market and anyone on Genesis can trade it with their own wallet."}</p>
        ${stillSyncing ? "" : '<a href="#create">Create the first market</a>'}
      </div>`;
  }
  if (!indexed.length) {
    const emptyTitle = marketQuery
      ? `No market found for “${marketQuery}”.`
      : marketSort === "graduated"
        ? "No graduated markets yet."
        : "No markets match this filter.";
    return `
      <div class="token-empty">
        <div class="pulse-chart" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <h3>${emptyTitle}</h3>
        <p>Try another sort, clear search, or switch age to All.</p>
      </div>`;
  }
  return `<div class="token-grid">${indexed.map(({ market, index }) => renderMarketCard(market, index)).join("")}</div>`;
}

function renderMarkets() {
  const markets = readMarkets();
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = String(markets.length);
  });
  updateRegistryLiveBadge();

  const indexed = filterAndSortMarkets(markets);
  const html = marketBoardHtml(markets, indexed);
  document.querySelectorAll(".token-board").forEach((board) => {
    board.innerHTML = html;
  });
}

/** Hash pages: explore (default) | wrap | activity */
function currentAppPage() {
  const raw = (location.hash || "#explore").replace(/^#/, "").toLowerCase();
  if (raw === "wrap" || raw === "activity") return raw;
  if (raw === "create") return "explore"; // drawer overlay, stay on explore
  return "explore";
}

function showAppPage(page) {
  const target = page === "wrap" || page === "activity" ? page : "explore";
  document.querySelectorAll("[data-page]").forEach((el) => {
    const match = el.dataset.page === target;
    el.hidden = !match;
  });
  document.querySelectorAll("[data-app-nav] [data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === target);
  });
  if (target === "wrap") {
    // Always load the wrap available balance when opening this page.
    refreshBalance().catch(() => { /* ignore */ });
    refreshWrapAvailable().catch(() => { /* ignore */ });
  }
}

function syncAppPageFromHash() {
  showAppPage(currentAppPage());
}

async function claimFaucet() {
  if (!connectedAccount) return openWallet();
  const button = document.querySelector("[data-faucet]");
  const status = document.querySelector("[data-faucet-status]");
  const setStatus = (message) => { status.textContent = message; };
  button.disabled = true;
  try {
    await ensureAccountExists(setStatus);
    const vault = Pubkey.from(FAUCET_VAULT);
    const before = await getAccountSnapshot();
    let received = 0n;
    // Alphanet allows max 10_000 base units per withdraw — claim several times per click.
    for (let claim = 0; claim < FAUCET_CLAIMS_PER_CLICK; claim += 1) {
      setStatus(`Claiming faucet pull ${claim + 1}/${FAUCET_CLAIMS_PER_CLICK}…`);
      const snapshot = await getAccountSnapshot();
      const slot = await currentSlot();
      await submitWithNonce(snapshot.nonce, (nonce) => buildAndSign({
        program: FAUCET_PROGRAM,
        accounts: { readWrite: [vault] },
        instructionData: async (context) => {
          const data = new Uint8Array(16);
          const view = new DataView(data.buffer);
          view.setUint32(0, 1, true);
          view.setUint16(4, context.getAccountIndex(vault), true);
          view.setUint16(6, context.getAccountIndex(connectedAccount.publicKey), true);
          view.setBigUint64(8, FAUCET_AMOUNT, true);
          return data;
        },
        header: {
          fee: 0n, nonce, startSlot: slot, expiryAfter: 100,
          computeUnits: 300000, memoryUnits: 10000, stateUnits: 10000, chainId: CHAIN_ID,
        },
      }), { programLabel: "Faucet" });
      received += FAUCET_AMOUNT;
      await new Promise((resolve) => setTimeout(resolve, 800));
      const updated = await getAccountSnapshot();
      document.querySelector("[data-balance]").textContent =
        `${formatUnits(updated.balance, NATIVE_THRU_DECIMALS, 9)} THRU`;
    }
    const after = await getAccountSnapshot();
    const gained = after.balance > before.balance ? after.balance - before.balance : received;
    await refreshBalance();
    setStatus(
      `Received about ${formatUnits(gained, NATIVE_THRU_DECIMALS, 9)} THRU ` +
      `(${FAUCET_CLAIMS_PER_CLICK}×${FAUCET_AMOUNT} base units). Claim again if you need more, ` +
      "or use faucet.thruscan.net for larger drops.",
    );
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : "Faucet claim failed.";
    setStatus(
      `${detail} Alphanet faucet max is ${FAUCET_AMOUNT} base units (0.00001 THRU) per pull. ` +
      "You can also use faucet.thruscan.net.",
    );
  } finally {
    button.disabled = false;
  }
}

function wrapPanels() {
  return [...document.querySelectorAll("[data-wrap-panel]")];
}

function setWrapSide(side) {
  wrapSide = side === "unwrap" ? "unwrap" : "wrap";
  document.querySelectorAll("[data-wrap-side]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.wrapSide === wrapSide);
  });
  const labelText = wrapSide === "wrap" ? "Amount in THRU" : "Amount in wTHRU";
  const submitText = wrapSide === "wrap"
    ? "Wrap THRU → wTHRU"
    : "Unwrap wTHRU → THRU";
  document.querySelectorAll("[data-wrap-amount-label]").forEach((el) => {
    el.textContent = labelText;
  });
  document.querySelectorAll("[data-wrap-submit]").forEach((el) => {
    el.textContent = submitText;
  });
  document.querySelectorAll("[data-wrap-balance-label]").forEach((el) => {
    el.textContent = wrapSide === "wrap" ? "Your THRU balance" : "Your wTHRU balance";
  });
  refreshWrapAvailable().catch(() => { /* ignore */ });
}

function setWrapStatuses(message) {
  document.querySelectorAll("[data-wrap-status]").forEach((el) => {
    el.textContent = message;
  });
}

async function fillWrapMax(event) {
  if (!connectedAccount) return openWallet();
  const panel = event?.target?.closest("[data-wrap-panel]") || document;
  const input = panel.querySelector("[data-wrap-amount]");
  if (!input) return;
  try {
    if (wrapSide === "wrap") {
      const snapshot = await getAccountSnapshot();
      // Leave fee headroom for native transfer + deposit.
      const spendable = snapshot.balance > 2n ? snapshot.balance - 2n : 0n;
      input.value = formatUnits(spendable, NATIVE_THRU_DECIMALS, 9);
    } else {
      const amount = await readWthruBalance();
      input.value = formatUnits(amount, NATIVE_THRU_DECIMALS, 9);
    }
  } catch {
    setWrapStatuses("Could not load balance for Max.");
  }
}

async function swapThruWthru(event) {
  if (!connectedAccount) return openWallet();
  const panel = event?.target?.closest("[data-wrap-panel]") || document;
  const button = panel.querySelector("[data-wrap-submit]") || event?.target;
  const status = panel.querySelector("[data-wrap-status]");
  const amountText = panel.querySelector("[data-wrap-amount]")?.value.trim() || "";
  const setStatus = (message) => {
    if (status) status.textContent = message;
    else setWrapStatuses(message);
  };
  let amount;
  try {
    amount = parseUnits(amountText, NATIVE_THRU_DECIMALS);
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  } catch (reason) {
    setStatus(reason instanceof Error ? reason.message : "Enter a valid amount.");
    return;
  }

  if (button) button.disabled = true;
  document.querySelectorAll("[data-wrap-submit]").forEach((el) => { el.disabled = true; });
  try {
    await ensureAccountExists((message) => { setStatus(message); });
    if (wrapSide === "wrap") {
      const snapshot = await getAccountSnapshot();
      // Reserve 2 base units for wrap transfer fee + deposit fee headroom.
      if (snapshot.balance < amount + 2n) {
        throw new Error(
          `Insufficient native THRU. Available: ${formatUnits(snapshot.balance, NATIVE_THRU_DECIMALS, 9)} THRU ` +
          "(keep a little for fees).",
        );
      }
      setStatus(`Wrapping ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU…`);
      const destination = await getWthruTokenAccount(true);
      await wrapThru(amount, destination);
      setStatus(
        `Wrapped ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU → wTHRU. ` +
        "Native balance drops; wTHRU balance rises.",
      );
      setWrapStatuses(
        `Wrapped ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU → wTHRU. ` +
        "Native balance drops; wTHRU balance rises.",
      );
    } else {
      const source = await getWthruTokenAccount(false);
      if (!(await getAccountSnapshot(source.address)).exists) {
        throw new Error("No wTHRU token account yet. Wrap some THRU first.");
      }
      setStatus(`Unwrapping ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} wTHRU…`);
      await unwrapThru(amount, source);
      setStatus(
        `Unwrapped ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} wTHRU → THRU. ` +
        "Native balance rises; wTHRU balance drops.",
      );
      setWrapStatuses(
        `Unwrapped ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} wTHRU → THRU. ` +
        "Native balance rises; wTHRU balance drops.",
      );
    }
    await refreshBalance();
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Wrap failed on Thru.";
    setStatus(message);
    setWrapStatuses(message);
  } finally {
    document.querySelectorAll("[data-wrap-submit]").forEach((el) => { el.disabled = false; });
  }
}

async function fillSendMax() {
  if (!connectedAccount) return openWallet();
  const input = document.querySelector("[data-send-amount]");
  if (!input) return;
  try {
    const asset = getSelectedSendAsset();
    const raw = await readSendAssetBalance(asset);
    if (asset.kind === "native") {
      const spendable = raw > NATIVE_TRANSFER_FEE ? raw - NATIVE_TRANSFER_FEE : 0n;
      input.value = formatUnits(spendable, asset.decimals, 9);
    } else {
      input.value = formatUnits(raw, asset.decimals);
    }
  } catch {
    const status = document.querySelector("[data-send-status]");
    if (status) status.textContent = "Could not load balance for Max.";
  }
}

async function sendAsset() {
  if (!connectedAccount) return openWallet();
  const button = document.querySelector("[data-send]");
  const status = document.querySelector("[data-send-status]");
  const recipientText = document.querySelector("[data-send-address]")?.value.trim() || "";
  const amountText = document.querySelector("[data-send-amount]")?.value.trim() || "";
  const asset = getSelectedSendAsset();
  let recipient;
  let amount;
  try {
    recipient = Pubkey.from(recipientText);
    amount = parseUnits(amountText, asset.decimals);
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
    if (recipient.toThruFmt() === connectedAccount.address) {
      throw new Error("Enter a different recipient address.");
    }
  } catch (reason) {
    if (status) {
      status.textContent = reason instanceof Error
        ? reason.message
        : "Enter a valid Thru address and amount.";
    }
    return;
  }

  if (button) button.disabled = true;
  try {
    await ensureAccountExists((message) => { if (status) status.textContent = message; });
    const nativeSnap = await getAccountSnapshot();

    if (asset.kind === "native") {
      if (nativeSnap.balance < amount + NATIVE_TRANSFER_FEE) {
        throw new Error(
          `Insufficient THRU. Need ${formatUnits(amount + NATIVE_TRANSFER_FEE, NATIVE_THRU_DECIMALS, 9)} THRU ` +
          `(incl. fee); available: ${formatUnits(nativeSnap.balance, NATIVE_THRU_DECIMALS, 9)} THRU.`,
        );
      }
      if (status) {
        status.textContent =
          `Sending ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU…`;
      }
      await submitProgramInstruction(EOA_PROGRAM, {
        accounts: { readWrite: [recipient] },
        instructionData: nativeTransferInstruction(amount),
        fee: NATIVE_TRANSFER_FEE,
      });
      if (status) {
        status.textContent =
          `Sent ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU to ${compactAddress(recipient.toThruFmt())}.`;
      }
    } else {
      // Token / wTHRU path — still need a little native THRU for the tx fee.
      if (nativeSnap.balance < NATIVE_TRANSFER_FEE) {
        throw new Error(
          "Need a little native THRU for the network fee. Claim faucet THRU first.",
        );
      }
      const balance = await readSendAssetBalance(asset);
      if (balance < amount) {
        throw new Error(
          `Insufficient ${asset.ticker}. Available: ${formatUnits(balance, asset.decimals)} ${asset.ticker}.`,
        );
      }
      if (status) {
        status.textContent =
          `Preparing ${asset.ticker} accounts…`;
      }
      const source = asset.id === "wthru" || asset.mint === WTHRU_MINT
        ? await getWthruTokenAccount(false)
        : await ensureTokenAccount(connectedAccount.address, asset.mint);
      if (!(await getAccountSnapshot(source.address)).exists) {
        throw new Error(`No ${asset.ticker} account to send from.`);
      }
      const destination = await ensureTokenAccount(recipient.toThruFmt(), asset.mint);
      if (status) {
        status.textContent =
          `Sending ${formatUnits(amount, asset.decimals)} ${asset.ticker}…`;
      }
      await submitTokenTransfer(source, destination, amount);
      if (status) {
        status.textContent =
          `Sent ${formatUnits(amount, asset.decimals)} ${asset.ticker} to ${compactAddress(recipient.toThruFmt())}.`;
      }
    }
    await refreshBalance();
  } catch (reason) {
    if (status) {
      status.textContent = reason instanceof Error ? reason.message : "Transfer failed on Thru.";
    }
  } finally {
    if (button) button.disabled = false;
  }
}

function downloadBackup() {
  if (!generatedAccount) return;
  const backup = {
    format: "genesis-thru-keystore",
    version: 1,
    network: "Alphanet",
    address: generatedAccount.address,
    publicKey: bytesToHex(generatedAccount.publicKey),
    privateKey: bytesToHex(generatedAccount.privateKey),
    createdAt: new Date(generatedAccount.createdAt).toISOString(),
    warning: "KEEP THIS FILE SECRET. Anyone with this private key controls this account.",
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `thru-wallet-${generatedAccount.address.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

connectButtons.forEach((button) => button.addEventListener("click", openWallet));
document.querySelectorAll("[data-wallet-close]").forEach((button) => button.addEventListener("click", closeWallet));
document.querySelectorAll("[data-wallet-home]").forEach((button) => button.addEventListener("click", () => showWalletView(null)));
document.querySelector("[data-wallet-view='create']")?.addEventListener("click", createWallet);
document.querySelector("[data-wallet-view='import']")?.addEventListener("click", () => showWalletView("import"));
document.querySelector("[data-import]")?.addEventListener("click", importWallet);
document.querySelector("[data-backup-check]")?.addEventListener("change", (event) => {
  document.querySelector("[data-use-generated]").disabled = !event.target.checked;
});
document.querySelector("[data-use-generated]")?.addEventListener("click", () => generatedAccount && activateAccount(generatedAccount));
document.querySelector("[data-download]")?.addEventListener("click", downloadBackup);
document.querySelector("[data-copy-generated]")?.addEventListener("click", () => {
  if (generatedAccount) navigator.clipboard.writeText(bytesToHex(generatedAccount.privateKey));
});
document.querySelectorAll("[data-copy-address]").forEach((button) => {
  button.addEventListener("click", () => {
    if (connectedAccount) navigator.clipboard.writeText(connectedAccount.address);
  });
});
document.querySelectorAll("[data-reveal]").forEach((button) => button.addEventListener("click", () => {
  const input = document.querySelector(button.dataset.reveal === "generated" ? "[data-generated-key]" : "[data-import-key]");
  input.type = input.type === "password" ? "text" : "password";
  button.textContent = input.type === "password" ? "Show" : "Hide";
}));
document.querySelector("[data-faucet]")?.addEventListener("click", claimFaucet);
document.querySelectorAll("[data-wrap-side]").forEach((button) => {
  button.addEventListener("click", () => setWrapSide(button.dataset.wrapSide));
});
document.querySelectorAll("[data-wrap-submit]").forEach((button) => {
  button.addEventListener("click", (event) => swapThruWthru(event));
});
document.querySelectorAll("[data-wrap-max]").forEach((button) => {
  button.addEventListener("click", (event) => fillWrapMax(event));
});
document.querySelector("[data-send]")?.addEventListener("click", sendAsset);
document.querySelector("[data-send-max]")?.addEventListener("click", () => {
  fillSendMax().catch(() => {});
});
document.querySelector("[data-send-asset]")?.addEventListener("change", () => {
  refreshSendAvailable().catch(() => {});
});
document.querySelector("[data-disconnect]")?.addEventListener("click", () => {
  if (connectedAccount) connectedAccount.privateKey.fill(0);
  connectedAccount = null;
  generatedAccount = null;
  try { sessionStorage.removeItem(WALLET_SESSION_KEY); } catch { /* Storage is unavailable. */ }
  setWalletState("Connect wallet");
  document.querySelector("[data-import-key]").value = "";
  const balance = document.querySelector("[data-balance]");
  const wthruBalance = document.querySelector("[data-wthru-balance]");
  if (balance) balance.textContent = "—";
  if (wthruBalance) wthruBalance.textContent = "—";
  document.querySelectorAll("[data-wrap-available]").forEach((el) => { el.textContent = "Connect wallet"; });
  const tokenHost = document.querySelector("[data-wallet-tokens]");
  if (tokenHost) {
    tokenHost.innerHTML = `<div class="wallet-token-empty">Connect a wallet to see token balances.</div>`;
  }
  showWalletView(null);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !walletModal.hidden) closeWallet();
});

document.querySelector("[data-create-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  createToken();
});
window.addEventListener("hashchange", syncAppPageFromHash);
document.querySelectorAll("[data-app-nav] a[data-nav]").forEach((link) => {
  link.addEventListener("click", () => {
    // Let hash update, then show page on next tick (hashchange also fires).
    requestAnimationFrame(syncAppPageFromHash);
  });
});
// Wallet hint → Wrap page
document.querySelectorAll('a[href="#wrap"]').forEach((link) => {
  link.addEventListener("click", () => {
    requestAnimationFrame(() => showAppPage("wrap"));
  });
});
document.querySelector("[data-token-image]")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    clearTokenImagePicker();
    return;
  }
  const status = document.querySelector("[data-create-status]");
  try {
    if (status) status.textContent = "Compressing token image…";
    const dataUrl = await compressTokenImage(file);
    setTokenImagePreview(dataUrl);
    if (status) status.textContent = "Image ready. Connect wallet and launch when set.";
  } catch (reason) {
    clearTokenImagePicker();
    if (status) {
      status.textContent = reason instanceof Error ? reason.message : "Could not use that image.";
    }
  }
});
document.querySelector("[data-token-image-clear]")?.addEventListener("click", () => {
  clearTokenImagePicker();
  const status = document.querySelector("[data-create-status]");
  if (status) status.textContent = "Image removed.";
});

const tradeModal = document.querySelector("[data-trade-modal]");
const liquidityModal = document.querySelector("[data-liquidity-modal]");
let activeTrade = null;
let activeLiquidityMarket = null;
let activeSide = "buy";
/** Cached raw balances for the open trade modal (base units). */
let tradeBalances = { thru: 0n, token: 0n, sellable: 0n };

function shortAddress(value, head = 6, tail = 4) {
  const text = String(value || "");
  if (text.length <= head + tail + 1) return text || "—";
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

let lastTapeSignature = "";

function renderTradeTape(market) {
  const tape = document.querySelector("[data-trade-tape]");
  if (!tape) return;
  const points = Array.isArray(market?.chart) ? market.chart.slice() : [];
  const trades = points
    .filter((p) => p && (p.side === "buy" || p.side === "sell"))
    .slice(-16)
    .reverse();
  if (!trades.length) {
    lastTapeSignature = "";
    tape.innerHTML = `<p class="trade-tape-empty">No trades yet · waiting for buys/sells</p>`;
    return;
  }
  const sig = trades.map((p) => `${p.t}:${p.side}:${p.thru}:${p.tokens}`).join("|");
  const isFresh = sig !== lastTapeSignature && lastTapeSignature !== "";
  lastTapeSignature = sig;
  tape.innerHTML = trades.map((point, index) => {
    const side = point.side === "sell" ? "sell" : "buy";
    let thru = "—";
    let tokens = "—";
    let price = "—";
    try {
      thru = point.thru != null ? formatUnits(BigInt(String(point.thru)), NATIVE_THRU_DECIMALS, 6) : "—";
    } catch { /* ignore */ }
    try {
      tokens = point.tokens != null
        ? formatUnits(BigInt(String(point.tokens)), market.decimals || 6)
        : "—";
    } catch { /* ignore */ }
    try {
      price = point.price != null ? formatSpotPrice(BigInt(String(point.price))) : "—";
    } catch { /* ignore */ }
    const when = point.t || point.ts || point.at
      ? new Date(Number(point.t || point.ts || point.at)).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      : "";
    const flash = isFresh && index === 0 ? " is-new" : "";
    return `
      <div class="trade-tape-row${flash}">
        <span class="side-${side}">${side.toUpperCase()}</span>
        <span>${tokens} ${market.ticker || ""}</span>
        <span class="tape-muted">${thru} THRU</span>
        <span class="tape-muted" title="${price}">${when || price}</span>
      </div>`;
  }).join("");
}

/** Pull storage + remote, then repaint chart / tape / % / quote. */
async function refreshOpenTradeUi({ sync = false } = {}) {
  if (!activeTrade?.mintAddress) return;
  const modal = document.querySelector("[data-trade-modal]");
  if (!modal || modal.hidden) return;
  if (sync) {
    try {
      await syncPublicMarkets({ mode: "full", publish: false });
    } catch { /* ignore */ }
  }
  const fresh = resolveTradeMarket(
    readMarkets().find((m) => m.mintAddress === activeTrade.mintAddress),
  );
  if (fresh) activeTrade = fresh;
  renderTokenChart(activeTrade);
  renderTradeTape(activeTrade);
  try { updateTradeQuote(); } catch { /* ignore */ }
}

let tradeLiveTimer = 0;
let tradeLiveBusy = false;

function stopTradeLiveFeed() {
  if (tradeLiveTimer) {
    clearInterval(tradeLiveTimer);
    tradeLiveTimer = 0;
  }
  tradeLiveBusy = false;
}

function startTradeLiveFeed() {
  stopTradeLiveFeed();
  // Immediate paint, then 1s live loop while the modal is open.
  refreshOpenTradeUi({ sync: true }).catch(() => {});
  tradeLiveTimer = window.setInterval(() => {
    if (tradeLiveBusy) return;
    const open = activeTrade
      && document.querySelector("[data-trade-modal]")?.hidden === false;
    if (!open) {
      stopTradeLiveFeed();
      return;
    }
    tradeLiveBusy = true;
    refreshOpenTradeUi({ sync: true })
      .catch(() => {})
      .finally(() => { tradeLiveBusy = false; });
  }, TRADE_LIVE_POLL_MS);
}

function asBigIntAmount(value) {
  if (typeof value === "bigint") return value >= 0n ? value : 0n;
  try {
    const n = BigInt(String(value ?? "0").split(".")[0] || "0");
    return n >= 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

function tradeTokenDecimals(market = activeTrade) {
  const d = Number(market?.decimals);
  return Number.isFinite(d) && d >= 0 && d <= 18 ? Math.floor(d) : 6;
}

/** Update the receive quote from the current amount field. */
function updateTradeQuote() {
  const input = document.querySelector("[data-trade-amount]");
  const quote = document.querySelector("[data-trade-quote]");
  if (!quote) return;
  if (!input || !activeTrade) {
    quote.textContent = "—";
    return;
  }
  const text = String(input.value || "").trim();
  if (!text || text === "." || text === "0" || /^0\.0*$/.test(text)) {
    quote.textContent = text && text !== "."
      ? "Enter an amount greater than zero."
      : "—";
    return;
  }
  try {
    const raw = parseUnits(
      text,
      activeSide === "buy" ? NATIVE_THRU_DECIMALS : tradeTokenDecimals(),
    );
    if (raw <= 0n) {
      quote.textContent = "Enter an amount greater than zero.";
      return;
    }
    if (isBondingMarket(activeTrade)) {
      if (activeSide === "buy") {
        const q = quoteCurveBuy(activeTrade, raw);
        quote.textContent =
          `≈ ${formatUnits(q.tokensOut, tradeTokenDecimals())} ${activeTrade.ticker} ` +
          `(incl. ${Number(CURVE_TRADE_FEE_BPS) / 100}% fee)`;
      } else {
        const q = quoteCurveSell(activeTrade, raw);
        quote.textContent =
          `≈ ${formatUnits(q.netThru, NATIVE_THRU_DECIMALS, 9)} THRU ` +
          `(incl. ${Number(CURVE_TRADE_FEE_BPS) / 100}% fee)`;
      }
      return;
    }
    if (!activeTrade.liquidity) {
      quote.textContent = "No live pool quote for this market.";
      return;
    }
    const afterFees = raw * 9970n / 10000n;
    quote.textContent = activeSide === "buy"
      ? `≈ ${formatUnits(afterFees * PRICE_TOKENS_PER_THRU * (10n ** BigInt(tradeTokenDecimals())) / (10n ** BigInt(NATIVE_THRU_DECIMALS)), tradeTokenDecimals())} ${activeTrade.ticker}`
      : `≈ ${formatUnits(afterFees * (10n ** BigInt(NATIVE_THRU_DECIMALS)) / (PRICE_TOKENS_PER_THRU * (10n ** BigInt(tradeTokenDecimals()))), NATIVE_THRU_DECIMALS, 9)} THRU`;
  } catch (reason) {
    quote.textContent = reason instanceof Error ? reason.message : "—";
  }
}

/**
 * Fill the trade amount from wallet balance × percent.
 * Refreshes balances first so 25–100% never run against a stale 0 balance
 * (which left the quote stuck on "—").
 */
async function setTradeAmountFromPercent(percent) {
  if (!activeTrade) return;
  const input = document.querySelector("[data-trade-amount]");
  const quote = document.querySelector("[data-trade-quote]");
  if (!input) return;

  if (!connectedAccount) {
    input.value = "";
    if (quote) quote.textContent = "Connect wallet to use % shortcuts.";
    openWallet();
    return;
  }

  // Always re-read balances before applying % — openTrade may still be loading.
  try {
    await refreshTradeBalances();
  } catch {
    /* keep last known balances */
  }

  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  let amount = 0n;
  let decimals = NATIVE_THRU_DECIMALS;

  if (activeSide === "buy") {
    const thru = asBigIntAmount(tradeBalances.thru);
    // Leave native fee headroom so Max/100% can still submit.
    const feeReserve = NATIVE_TRANSFER_FEE > 0n ? NATIVE_TRANSFER_FEE : 1n;
    const spendable = thru > feeReserve ? thru - feeReserve : 0n;
    amount = (spendable * BigInt(pct)) / 100n;
    decimals = NATIVE_THRU_DECIMALS;
  } else {
    const sellable = asBigIntAmount(
      tradeBalances.sellable != null ? tradeBalances.sellable : tradeBalances.token,
    );
    amount = (sellable * BigInt(pct)) / 100n;
    decimals = tradeTokenDecimals();
  }

  if (amount <= 0n) {
    input.value = "";
    if (quote) {
      quote.textContent = activeSide === "buy"
        ? "No spendable THRU for this %."
        : `No sellable ${activeTrade.ticker || "tokens"} for this %.`;
    }
    return;
  }

  // type=text field — avoid type=number clearing long/precise values to empty ("—").
  input.value = formatUnits(amount, decimals, decimals);
  updateTradeQuote();
}

async function refreshTradeBalances() {
  const balanceEl = document.querySelector("[data-trade-balance]");
  const labelEl = document.querySelector("[data-trade-balance-label]");
  if (!balanceEl) return;
  if (!connectedAccount || !activeTrade) {
    tradeBalances = { thru: 0n, token: 0n, sellable: 0n };
    if (labelEl) labelEl.textContent = "Your balance";
    balanceEl.textContent = "Connect wallet";
    return;
  }
  if (labelEl) {
    labelEl.textContent = activeSide === "buy"
      ? "Your THRU balance"
      : `Your ${activeTrade.ticker} balance`;
  }
  balanceEl.textContent = "Loading…";
  try {
    // Keep curve vault metadata aligned with on-chain THRU (fixes post-graduation sells).
    if (isBondingMarket(activeTrade)) {
      activeTrade = await syncCurveVaultFromChain(activeTrade);
    }
    const native = await getAccountSnapshot();
    tradeBalances.thru = native.balance || 0n;
    try {
      const tokenAccount = deriveTokenAccountAddress(
        client,
        connectedAccount.address,
        activeTrade.mintAddress,
        TOKEN_PROGRAM,
      );
      if ((await getAccountSnapshot(tokenAccount.address)).exists) {
        tradeBalances.token = await readTokenAmount(tokenAccount.address);
      } else {
        tradeBalances.token = 0n;
      }
    } catch {
      tradeBalances.token = 0n;
    }
    if (isBondingMarket(activeTrade)) {
      const vaultCap = maxSellableTokens(activeTrade);
      tradeBalances.sellable = tradeBalances.token < vaultCap ? tradeBalances.token : vaultCap;
    } else {
      tradeBalances.sellable = tradeBalances.token;
    }
    if (activeSide === "buy") {
      balanceEl.textContent = `${formatUnits(tradeBalances.thru, NATIVE_THRU_DECIMALS, 9)} THRU`;
    } else {
      const walletPart = `${formatUnits(tradeBalances.token, activeTrade.decimals)} ${activeTrade.ticker}`;
      if (isBondingMarket(activeTrade) && tradeBalances.sellable < tradeBalances.token) {
        balanceEl.textContent =
          `${walletPart} · sellable now ${formatUnits(tradeBalances.sellable, activeTrade.decimals)}`;
      } else {
        balanceEl.textContent = walletPart;
      }
    }
  } catch {
    balanceEl.textContent = "Unavailable";
  }
}

async function openTrade(index, side) {
  const listed = readMarkets()[index];
  activeTrade = resolveTradeMarket(listed) || listed;
  activeSide = side;
  if (!activeTrade) return;
  tradeModal.hidden = false;
  document.body.classList.add("modal-open");
  // Pull latest peer trades/curve before first paint of chart + tape.
  try {
    await syncPublicMarkets({ mode: "full", publish: false });
    const fresh = resolveTradeMarket(
      readMarkets().find((m) => m.mintAddress === activeTrade.mintAddress),
    );
    if (fresh) activeTrade = fresh;
  } catch { /* offline: use local */ }

  const name = activeTrade.name || activeTrade.ticker || "Token";
  const ticker = activeTrade.ticker || "TOKEN";
  document.querySelector("[data-trade-title]").textContent = name;
  const nameEl = document.querySelector("[data-trade-name]");
  if (nameEl) nameEl.textContent = name;
  const tickerEl = document.querySelector("[data-trade-ticker]");
  if (tickerEl) tickerEl.textContent = `$${ticker}`;

  const mint = activeTrade.mintAddress || "";
  const mintEl = document.querySelector("[data-trade-mint]");
  if (mintEl) mintEl.textContent = shortAddress(mint, 8, 6);
  const mintLink = document.querySelector("[data-trade-mint-link]");
  if (mintLink) {
    if (mint) {
      mintLink.href = `https://scan.thru.org/address/${mint}`;
      mintLink.hidden = false;
      mintLink.title = mint;
    } else {
      mintLink.removeAttribute("href");
      mintLink.hidden = true;
    }
  }

  const aboutEl = document.querySelector("[data-trade-about]");
  if (aboutEl) {
    const desc = typeof activeTrade.description === "string" ? activeTrade.description.trim() : "";
    aboutEl.textContent = desc || "No description yet.";
  }

  const tradeImg = document.querySelector("[data-trade-image]");
  const tradeFallback = document.querySelector("[data-trade-image-fallback]");
  const src = typeof activeTrade.image === "string" ? activeTrade.image.trim() : "";
  const hasImage = Boolean(src && (src.startsWith("data:image/") || /^https?:\/\//i.test(src)));
  if (tradeImg) {
    if (hasImage) {
      tradeImg.src = src;
      tradeImg.hidden = false;
    } else {
      tradeImg.removeAttribute("src");
      tradeImg.hidden = true;
    }
  }
  if (tradeFallback) {
    tradeFallback.textContent = ticker.slice(0, 1).toUpperCase();
    tradeFallback.hidden = hasImage;
  }

  const submit = document.querySelector("[data-trade-submit]");
  if (submit) {
    submit.textContent = side === "buy" ? "Buy with THRU" : `Sell ${ticker}`;
    submit.classList.toggle("is-buy", side === "buy");
    submit.classList.toggle("is-sell", side === "sell");
  }
  const sidePanel = document.querySelector(".trade-launch-side");
  if (sidePanel) sidePanel.dataset.side = side;
  document.querySelector("[data-trade-input-label]").textContent = "You receive";
  const amountLabel = document.querySelector("[data-trade-amount-label]");
  if (amountLabel) amountLabel.textContent = side === "buy" ? "You pay" : "You sell";
  const amountAsset = document.querySelector("[data-trade-amount-asset]");
  if (amountAsset) amountAsset.textContent = side === "buy" ? "THRU" : ticker;

  const progress = activeTrade.curve ? curveProgress(activeTrade) : null;
  if (isBondingMarket(activeTrade)) {
    activeTrade = await syncCurveVaultFromChain(activeTrade);
    const c = readCurve(activeTrade);
    if (activeTrade.graduated) {
      document.querySelector("[data-trade-status]").textContent =
        `Graduated · vault ${formatUnits(c.realThru, NATIVE_THRU_DECIMALS, 9)} THRU. Buy and sell stay available.`;
    } else {
      document.querySelector("[data-trade-status]").textContent =
        `Bonding curve · ${progress.toFixed(1)}% to graduation ` +
        `(${formatUnits(c.realThru, NATIVE_THRU_DECIMALS, 9)} / ${formatUnits(c.graduationTarget, NATIVE_THRU_DECIMALS, 9)} THRU).`;
    }
  } else if (activeTrade.liquidity) {
    document.querySelector("[data-trade-status]").textContent = "AMM market · quotes from the live pool.";
  } else if (activeTrade.graduated) {
    document.querySelector("[data-trade-status]").textContent =
      activeTrade.liquidityPendingReason || "Graduated. Trading continues.";
  } else {
    document.querySelector("[data-trade-status]").textContent =
      "This mint is live, but has no bonding curve yet.";
  }

  document.querySelectorAll(".trade-switch [data-side]").forEach((button) => {
    const on = button.dataset.side === side;
    button.classList.toggle("selected", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelector("[data-trade-amount]").value = "";
  document.querySelector("[data-trade-quote]").textContent = "—";
  lastTapeSignature = "";
  bindChartRangePills();
  renderTokenChart(activeTrade);
  renderTradeTape(activeTrade);
  startTradeLiveFeed();
  await refreshTradeBalances();
}

function closeTrade() {
  stopTradeLiveFeed();
  tradeModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function openLiquidity() {
  // Public pool UI removed — buy/sell only.
}

function closeLiquidity() {
  if (liquidityModal) liquidityModal.hidden = true;
}

async function provideLiquidity() {
  const button = document.querySelector("[data-liquidity-submit]");
  const status = document.querySelector("[data-liquidity-status]");
  if (!connectedAccount) {
    closeLiquidity();
    openWallet();
    return;
  }
  if (!activeLiquidityMarket?.liquidity) {
    status.textContent = "This pool is not initialized yet. No funds were moved.";
    return;
  }

  let thruAmount;
  let tokenAmount;
  try {
    thruAmount = parseUnits(
      document.querySelector("[data-liquidity-thru]").value,
      NATIVE_THRU_DECIMALS,
    );
    tokenAmount = parseUnits(
      document.querySelector("[data-liquidity-token]").value,
      activeLiquidityMarket.decimals,
    );
    if (thruAmount <= 0n || tokenAmount <= 0n) {
      throw new Error("Enter both THRU and token amounts.");
    }
  } catch (reason) {
    status.textContent = reason instanceof Error ? reason.message : "Enter valid liquidity amounts.";
    return;
  }

  button.disabled = true;
  try {
    await ensureAccountExists((message) => { status.textContent = message; });
    const pool = derivePool(activeLiquidityMarket.mintAddress);
    if (!(await getAccountSnapshot(pool.poolAddress)).exists) {
      throw new Error("This pool is not initialized yet. No funds were moved.");
    }
    status.textContent = "Preparing your pool accounts…";
    const userToken = await ensureTokenAccount(
      connectedAccount.address,
      activeLiquidityMarket.mintAddress,
    );
    const userWthru = await ensureTokenAccount(connectedAccount.address, WTHRU_MINT);
    const userLp = await ensureTokenAccount(connectedAccount.address, pool.lpMint.address);
    status.textContent = `Wrapping ${formatUnits(thruAmount, NATIVE_THRU_DECIMALS, 9)} THRU…`;
    await wrapThru(thruAmount, userWthru);

    const tokenIsOne = pool.mintOneAddress === activeLiquidityMarket.mintAddress;
    const depositorOne = tokenIsOne ? userToken : userWthru;
    const depositorTwo = tokenIsOne ? userWthru : userToken;
    const amountOne = tokenIsOne ? tokenAmount : thruAmount;
    const amountTwo = tokenIsOne ? thruAmount : tokenAmount;
    assertInitialLiquidityAmounts(amountOne, amountTwo);
    status.textContent = "Adding liquidity and minting your LP position…";
    await submitProgramInstruction(GENESIS_AMM_PROGRAM, {
      accounts: {
        readWrite: [
          pool.poolAddress, depositorOne.address, depositorTwo.address, userLp.address,
          pool.vaultOne.address, pool.vaultTwo.address, pool.lpMint.address,
        ],
        readOnly: [TOKEN_PROGRAM],
      },
      instructionData: createAddLiquidityInstruction({
        poolAccountBytes: pool.poolBytes,
        depositorAccountBytes: connectedAccount.publicKey,
        depositorTokenOneAccountBytes: depositorOne.bytes,
        depositorTokenTwoAccountBytes: depositorTwo.bytes,
        depositorLpAccountBytes: userLp.bytes,
        vaultOneAccountBytes: pool.vaultOne.bytes,
        vaultTwoAccountBytes: pool.vaultTwo.bytes,
        lpMintAccountBytes: pool.lpMint.bytes,
        tokenProgramAccountBytes: Pubkey.from(TOKEN_PROGRAM).toBytes(),
        maxAmountMintOne: amountOne,
        maxAmountMintTwo: amountTwo,
      }),
    });
    status.textContent = `Liquidity added. LP tokens were issued to ${compactAddress(connectedAccount.address)}.`;
  } catch (reason) {
    status.textContent = reason instanceof Error ? reason.message : "Liquidity deposit failed on Thru.";
  } finally {
    button.disabled = false;
  }
}

async function submitTokenTransfer(source, destination, amount) {
  if (amount <= 0n) return;
  await submitTokenInstruction({
    accounts: { readWrite: [source.address, destination.address] },
    instructionData: createTransferInstruction({
      sourceAccountBytes: source.bytes,
      destinationAccountBytes: destination.bytes,
      amount,
    }),
  });
}

async function submitSwap(market, side, amountIn, tokenAccount, wthruAccount) {
  const pool = derivePool(market.mintAddress);
  const buying = side === "buy";
  const userInput = buying ? wthruAccount : tokenAccount;
  const userOutput = buying ? tokenAccount : wthruAccount;
  const inputMint = buying ? WTHRU_MINT : market.mintAddress;
  const inputIsOne = pool.mintOneAddress === inputMint;
  const vaultInput = inputIsOne ? pool.vaultOne : pool.vaultTwo;
  const vaultOutput = inputIsOne ? pool.vaultTwo : pool.vaultOne;
  await submitProgramInstruction(GENESIS_AMM_PROGRAM, {
    accounts: {
      readWrite: [
        pool.poolAddress, userInput.address, userOutput.address,
        vaultInput.address, vaultOutput.address, pool.lpMint.address,
      ],
      readOnly: [TOKEN_PROGRAM],
    },
    instructionData: createSwapInstruction({
      poolAccountBytes: pool.poolBytes,
      userTransferAuthorityBytes: connectedAccount.publicKey,
      userInputAccountBytes: userInput.bytes,
      userOutputAccountBytes: userOutput.bytes,
      vaultInputAccountBytes: vaultInput.bytes,
      vaultOutputAccountBytes: vaultOutput.bytes,
      lpMintAccountBytes: pool.lpMint.bytes,
      tokenProgramAccountBytes: Pubkey.from(TOKEN_PROGRAM).toBytes(),
      amountIn,
    }),
  });
}

async function executeCurveTrade(amount, status) {
  const market = activeTrade;
  const curveSigner = await loadCurveSigner(market);
  const userToken = await ensureTokenAccount(connectedAccount.address, market.mintAddress);
  const curveToken = {
    address: market.curve.tokenAccount,
    bytes: Pubkey.from(market.curve.tokenAccount).toBytes(),
  };

  if (activeSide === "buy") {
    const quote = quoteCurveBuy(market, amount);
    // Preflight: native transfer needs amount + header fee (NATIVE_TRANSFER_FEE).
    // Missing this is VM -765 / userErrorCode 2^64-38 (INSUFFICIENT_BALANCE).
    const snapshot = await getAccountSnapshot();
    const need = amount + NATIVE_TRANSFER_FEE;
    if (snapshot.balance < need) {
      throw new Error(
        `Insufficient THRU for curve buy. Need ${formatUnits(need, NATIVE_THRU_DECIMALS, 9)} THRU ` +
        `(${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} + ${NATIVE_TRANSFER_FEE} fee), ` +
        `have ${formatUnits(snapshot.balance, NATIVE_THRU_DECIMALS, 9)}. Use Max or lower the amount.`,
      );
    }
    status.textContent =
      `Buying ≈ ${formatUnits(quote.tokensOut, market.decimals)} ${market.ticker} on the bonding curve…`;
    // 1) User pays native THRU into the curve vault.
    await submitProgramInstruction(EOA_PROGRAM, {
      accounts: { readWrite: [curveSigner.address] },
      instructionData: nativeTransferInstruction(amount),
      fee: NATIVE_TRANSFER_FEE,
      programLabel: "Curve buy payment",
    });
    // 2) Curve vault releases tokens to the buyer.
    await submitAs(curveSigner, TOKEN_PROGRAM, {
      accounts: { readWrite: [curveToken.address, userToken.address] },
      instructionData: createTransferInstruction({
        sourceAccountBytes: curveToken.bytes,
        destinationAccountBytes: userToken.bytes,
        amount: quote.tokensOut,
      }),
      fee: 0n,
      programLabel: "Curve buy fill",
    });
    let updated = applyCurveState(market, quote.next);
    const nextMarket = {
      ...(updated || market),
      curve: {
        ...(updated || market).curve,
        virtualThru: quote.next.virtualThru.toString(),
        virtualToken: quote.next.virtualToken.toString(),
        realThru: quote.next.realThru.toString(),
        realToken: quote.next.realToken.toString(),
      },
    };
    updated = appendChartPoint(nextMarket, {
      side: "buy",
      price: curveSpotPriceThruPerToken(nextMarket),
      thru: amount,
      tokens: quote.tokensOut,
    }) || nextMarket;
    status.textContent =
      `Bought ${formatUnits(quote.tokensOut, market.decimals)} ${market.ticker} ` +
      `(fee ${formatUnits(quote.fee, NATIVE_THRU_DECIMALS, 9)} THRU).`;
    if (quote.next.realThru >= quote.next.graduationTarget) {
      updated = await graduateMarket(updated || market, (message) => { status.textContent = message; });
      status.textContent += updated?.liquidity
        ? " Market graduated and AMM was seeded."
        : " Market graduated.";
    }
    activeTrade = updated || readMarkets().find((m) => m.mintAddress === market.mintAddress);
    renderTokenChart(activeTrade);
    renderTradeTape(activeTrade);
    renderMarkets();
    // Public board must get this print so the other wallet's chart/tape/price move.
    await publishTradeActivity(activeTrade, status);
    await refreshOpenTradeUi({ sync: true });
    await refreshTradeBalances();
    await refreshBalance();
    return;
  }

  // Sell
  const quote = quoteCurveSell(market, amount);
  status.textContent =
    `Selling ${formatUnits(amount, market.decimals)} ${market.ticker} on the bonding curve…`;
  await submitTokenTransfer(userToken, curveToken, amount);
  await submitAs(curveSigner, EOA_PROGRAM, {
    accounts: { readWrite: [connectedAccount.address] },
    instructionData: nativeTransferInstruction(quote.netThru),
    fee: 0n,
    programLabel: "Curve sell payout",
  });
  let updated = applyCurveState(market, quote.next);
  const nextMarket = {
    ...(updated || market),
    curve: {
      ...(updated || market).curve,
      virtualThru: quote.next.virtualThru.toString(),
      virtualToken: quote.next.virtualToken.toString(),
      realThru: quote.next.realThru.toString(),
      realToken: quote.next.realToken.toString(),
    },
  };
  updated = appendChartPoint(nextMarket, {
    side: "sell",
    price: curveSpotPriceThruPerToken(nextMarket),
    thru: quote.netThru,
    tokens: amount,
  }) || nextMarket;
  activeTrade = updated || market;
  status.textContent =
    `Sold for ${formatUnits(quote.netThru, NATIVE_THRU_DECIMALS, 9)} THRU ` +
    `(fee ${formatUnits(quote.fee, NATIVE_THRU_DECIMALS, 9)} THRU).`;
  renderTokenChart(activeTrade);
  renderTradeTape(activeTrade);
  renderMarkets();
  await publishTradeActivity(activeTrade, status);
  await refreshOpenTradeUi({ sync: true });
  await refreshTradeBalances();
  await refreshBalance();
}

async function executeTrade() {
  const button = document.querySelector("[data-trade-submit]");
  const status = document.querySelector("[data-trade-status]");
  if (!connectedAccount) {
    closeTrade();
    openWallet();
    return;
  }

  // Pull peer trades first so quotes use the latest curve (friend's buy marks you up).
  try {
    await syncPublicMarkets({ mode: "full", publish: false });
  } catch { /* ignore */ }
  if (activeTrade?.mintAddress) {
    activeTrade = resolveTradeMarket(
      readMarkets().find((m) => m.mintAddress === activeTrade.mintAddress) || activeTrade,
    ) || activeTrade;
  }

  const value = document.querySelector("[data-trade-amount]").value;
  let amount;
  try {
    amount = parseUnits(
      value,
      activeSide === "buy" ? NATIVE_THRU_DECIMALS : tradeTokenDecimals(activeTrade),
    );
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  } catch (reason) {
    status.textContent = reason.message;
    return;
  }

  button.disabled = true;
  try {
    status.textContent = "Preparing your Thru account…";
    await ensureAccountExists((message) => { status.textContent = message; });

    // Bonding-curve path (default for new launches).
    if (isBondingMarket(activeTrade)) {
      await executeCurveTrade(amount, status);
      return;
    }

    if (!activeTrade?.liquidity) {
      const hasCurveShell = Boolean(activeTrade?.curve);
      const hasKey = Boolean(String(activeTrade?.curve?.privateKeyHex || "").trim());
      const hasVault = Boolean(String(activeTrade?.curve?.tokenAccount || "").trim());
      if (activeTrade?.graduated) {
        status.textContent = activeTrade.liquidityPendingReason
          || "Graduated. Trading continues when the pool is available.";
      } else if (hasCurveShell && (!hasKey || !hasVault)) {
        status.textContent =
          "Bonding curve data is incomplete for this mint (missing vault key on the public board). "
          + "Hard-refresh, or ask the creator to open the app so the full curve record re-publishes.";
      } else {
        status.textContent =
          "Trade not submitted: no bonding curve or AMM pool is available for this mint.";
      }
      return;
    }

    const protocolFee = amount * BigInt(PROTOCOL_FEE_BPS) / 10000n;
    const swapAmount = amount - protocolFee;
    if (swapAmount <= 0n) {
      status.textContent = "Amount is too small to route.";
      return;
    }

    status.textContent = "Preparing your Thru token accounts…";
    const userToken = await ensureTokenAccount(connectedAccount.address, activeTrade.mintAddress);
    const userWthru = await ensureTokenAccount(connectedAccount.address, WTHRU_MINT);
    const feeMint = activeSide === "buy" ? WTHRU_MINT : activeTrade.mintAddress;
    const treasuryAccount = await ensureTokenAccount(GENESIS_TREASURY, feeMint);

    if (activeSide === "buy") {
      status.textContent = `Wrapping ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU…`;
      await wrapThru(amount, userWthru);
    }

    status.textContent = `Swapping through the ${CREATOR_FEE_BPS / 100}% creator-fee pool…`;
    await submitSwap(activeTrade, activeSide, swapAmount, userToken, userWthru);

    if (protocolFee > 0n) {
      status.textContent = `Routing the ${PROTOCOL_FEE_BPS / 100}% Genesis fee…`;
      await submitTokenTransfer(
        activeSide === "buy" ? userWthru : userToken,
        treasuryAccount,
        protocolFee,
      );
    }
    status.textContent = `${activeSide === "buy" ? "Buy" : "Sell"} confirmed on Thru. Creator fee: 0.21%; Genesis fee: 0.09%.`;
  } catch (reason) {
    status.textContent = reason instanceof Error ? reason.message : "Trade failed on Thru.";
  } finally {
    button.disabled = false;
  }
}

function onMarketActionClick(event) {
  // Buy / Sell take priority over the card hit target.
  const tradeButton = event.target.closest("[data-trade]");
  if (tradeButton) {
    event.preventDefault();
    event.stopPropagation();
    openTrade(Number(tradeButton.dataset.trade), tradeButton.dataset.tradeSide || "buy");
    return;
  }
  const openMarket = event.target.closest("[data-open-market]");
  if (openMarket) {
    // Clicking the token card opens the launchpad-style trade panel.
    openTrade(Number(openMarket.dataset.openMarket), "buy");
  }
}
// Token boards are re-rendered often — bind once on the page containers.
document.querySelectorAll(".token-board").forEach((board) => {
  board.addEventListener("click", onMarketActionClick);
});
// Fallback: any future market list hosts.
document.querySelector("main")?.addEventListener("click", (event) => {
  if (event.target.closest(".token-board, .token-grid, .market-list")) {
    // Already handled by board listener when inside .token-board; skip double-fire.
    if (event.target.closest(".token-board")) return;
    onMarketActionClick(event);
  }
});
document.querySelectorAll("[data-trade-close]").forEach((button) => button.addEventListener("click", closeTrade));
document.querySelectorAll("[data-side]").forEach((button) => button.addEventListener("click", () => {
  if (activeTrade) openTrade(readMarkets().findIndex((market) => market.mintAddress === activeTrade.mintAddress), button.dataset.side);
}));
document.querySelector("[data-trade-max]")?.addEventListener("click", () => {
  setTradeAmountFromPercent(100).catch(() => {});
});
document.querySelectorAll("[data-trade-pct]").forEach((button) => {
  button.addEventListener("click", () => {
    setTradeAmountFromPercent(button.dataset.tradePct).catch(() => {});
  });
});
document.querySelector("[data-trade-amount]")?.addEventListener("input", () => {
  updateTradeQuote();
});
document.querySelector("[data-trade-submit]")?.addEventListener("click", executeTrade);

async function bootMarkets() {
  // 1) Instant paint from local cache — never block first view on the network.
  const local = readMarkets();
  if (local.length) {
    registryLiveAt = Date.now();
    lastPublicBoard = { ok: true, count: local.length, error: "" };
  }
  renderMarkets();
  syncAppPageFromHash();

  // 2) Fast path: first mirror that answers wins for a quick remote refresh.
  try {
    const before = marketsSignature(readMarkets());
    await syncPublicMarkets({ mode: "fast", publish: false });
    if (marketsSignature(readMarkets()) !== before) renderMarkets();
    else updateRegistryLiveBadge();
  } catch {
    /* local cache still works offline */
  }

  // 3) Full merge of every mirror (authoritative) — friends need this to see new launches.
  try {
    const before = marketsSignature(readMarkets());
    await syncPublicMarkets({ mode: "full", publish: true });
    if (marketsSignature(readMarkets()) !== before) renderMarkets();
    else updateRegistryLiveBadge();
  } catch {
    /* ignore */
  }

  // 4) One more delayed full pull (covers mirrors that lag right after someone launches).
  window.setTimeout(async () => {
    try {
      const before = marketsSignature(readMarkets());
      await syncPublicMarkets({ mode: "full", publish: true });
      if (marketsSignature(readMarkets()) !== before) renderMarkets();
    } catch { /* ignore */ }
  }, 2000);

  // Adaptive poll for Explore; trade modal has its own 1s live feed.
  let pollMs = REGISTRY_POLL_FAST_MS;
  const schedulePoll = () => {
    window.setTimeout(async () => {
      try {
        const tradeOpen = activeTrade
          && document.querySelector("[data-trade-modal]")?.hidden === false;
        // Trade live feed already syncs every second — skip heavy double-poll.
        if (tradeOpen) {
          updateRegistryLiveBadge();
          pollMs = TRADE_LIVE_POLL_MS;
          schedulePoll();
          return;
        }
        const before = marketsSignature(readMarkets());
        await syncPublicMarkets({ mode: "full", publish: true });
        const after = marketsSignature(readMarkets());
        if (before !== after) {
          renderMarkets();
          pollMs = REGISTRY_POLL_FAST_MS;
        } else {
          updateRegistryLiveBadge();
          pollMs = Math.min(REGISTRY_POLL_SLOW_MS, pollMs + 1500);
        }
      } catch {
        /* ignore */
      }
      schedulePoll();
    }, pollMs);
  };
  schedulePoll();

  // Live badge clock.
  setInterval(updateRegistryLiveBadge, 1000);
}

bindChartRangePills();
bootMarkets();
restoreWalletSession();
syncAppPageFromHash();
