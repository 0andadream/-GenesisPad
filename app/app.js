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

document.querySelectorAll("[role='tablist'] button").forEach((button) => {
  button.addEventListener("click", () => {
    button.parentElement.querySelectorAll("button").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
  });
});

const search = document.querySelector("[data-search]");
search?.addEventListener("input", () => {
  document.querySelector(".token-empty h3").textContent = search.value.trim()
    ? `No market found for “${search.value.trim()}”.`
    : "The registry is quiet.";
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
// Pump.fun-style bonding curve (alphanet scale).
// Virtual THRU sets the starting price; 80% of supply sits on the curve.
const CURVE_VIRTUAL_THRU = 50_000_000n; // 0.05 THRU virtual reserve
const CURVE_TOKEN_BPS = 8000n; // 80% of minted supply on the curve
const CURVE_TRADE_FEE_BPS = 100n; // 1% fee on buys/sells
// Graduate after this much real THRU is bought into the curve (faucet-friendly).
const GRADUATION_REAL_THRU = 2_000_000n; // 0.002 THRU raised
const CURVE_GAS_FUND = 50_000n; // native dust so the curve account can pay fees
let connectedAccount = null;
let generatedAccount = null;
const WALLET_SESSION_KEY = "genesis-thru-wallet-session";
const MARKETS_KEY = "genesis-markets";

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
  document.querySelector("[data-explorer]").href = `https://scan.thru.org/account/${account.address}`;
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

async function refreshBalance() {
  if (!connectedAccount) return;
  const balance = document.querySelector("[data-balance]");
  const wthruBalance = document.querySelector("[data-wthru-balance]");
  try {
    const snapshot = await getAccountSnapshot();
    if (balance) {
      balance.textContent = `${formatUnits(snapshot.balance, NATIVE_THRU_DECIMALS, 9)} THRU`;
    }
  } catch {
    if (balance) balance.textContent = "Unavailable";
  }
  try {
    const amount = await readWthruBalance();
    // Base units are 1:1 with native THRU; show the same 9-decimal scale.
    if (wthruBalance) {
      wthruBalance.textContent = `${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} wTHRU`;
    }
  } catch {
    if (wthruBalance) wthruBalance.textContent = "Unavailable";
  }
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

async function submitTransaction(rawTransaction, { programLabel = "Transaction" } = {}) {
  for await (const update of client.transactions.sendAndTrack(rawTransaction, { timeoutMs: 60000 })) {
    const result = update.executionResult;
    if (result?.vmError) {
      const userCode = result.userErrorCode == null
        ? null
        : Number(result.userErrorCode);
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
        explanation =
          `${programLabel} rejected (VM ${result.vmError}, code ${result.userErrorCode ?? "unknown"}).`;
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
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
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

/* ─── Pump-style bonding curve ─────────────────────────────────────────── */

function isBondingMarket(market) {
  return Boolean(market?.curve) && market.phase !== "amm" && !market.graduated;
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

function quoteCurveBuy(market, thruIn) {
  if (thruIn <= 0n) throw new Error("Enter an amount greater than zero.");
  const c = readCurve(market);
  const fee = (thruIn * CURVE_TRADE_FEE_BPS) / 10000n;
  const net = thruIn - fee;
  if (net <= 0n) throw new Error("Amount is too small after fees.");
  const k = c.virtualThru * c.virtualToken;
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
      realThru: c.realThru + net,
      realToken: c.realToken - tokensOut,
      graduationTarget: c.graduationTarget,
    },
  };
}

function quoteCurveSell(market, tokensIn) {
  if (tokensIn <= 0n) throw new Error("Enter an amount greater than zero.");
  const c = readCurve(market);
  const k = c.virtualThru * c.virtualToken;
  const newVirtualToken = c.virtualToken + tokensIn;
  const newVirtualThru = k / newVirtualToken;
  if (newVirtualThru >= c.virtualThru) throw new Error("Quote produced zero THRU.");
  const thruGross = c.virtualThru - newVirtualThru;
  const fee = (thruGross * CURVE_TRADE_FEE_BPS) / 10000n;
  const netThru = thruGross - fee;
  if (netThru <= 0n) throw new Error("Amount is too small after fees.");
  if (netThru > c.realThru) {
    throw new Error("Not enough THRU left in the curve vault for that sell.");
  }
  return {
    fee,
    netThru,
    tokensIn,
    next: {
      virtualThru: newVirtualThru,
      virtualToken: newVirtualToken,
      realThru: c.realThru - netThru,
      realToken: c.realToken + tokensIn,
      graduationTarget: c.graduationTarget,
    },
  };
}

function saveMarkets(markets) {
  localStorage.setItem(MARKETS_KEY, JSON.stringify(markets.slice(0, 50)));
}

function updateMarket(mintAddress, patch) {
  const markets = readMarkets();
  const index = markets.findIndex((m) => m.mintAddress === mintAddress);
  if (index < 0) return null;
  const prev = markets[index];
  markets[index] = { ...prev, ...patch };
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
    fee: 1n,
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

  return {
    phase: "bonding",
    graduated: false,
    liquidity: false,
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
  if (!market?.curve || market.graduated) return market;
  setStatus("Graduation threshold reached — preparing AMM seed…");
  const curveSigner = await loadCurveSigner(market);
  const c = readCurve(market);
  // Keep a little gas on the curve; seed the rest.
  const seedThru = c.realThru > CURVE_GAS_FUND * 2n ? c.realThru - CURVE_GAS_FUND : c.realThru / 2n;
  // Match launch price ~500 tokens per THRU for AMM seed amounts.
  const seedTokens = (seedThru * PRICE_TOKENS_PER_THRU * (10n ** BigInt(market.decimals)))
    / (10n ** BigInt(NATIVE_THRU_DECIMALS));
  const tokensAvailable = c.realToken;
  const tokenAmount = seedTokens > 0n && seedTokens <= tokensAvailable
    ? seedTokens
    : tokensAvailable / 2n;

  let ammSeeded = false;
  let liquidityPendingReason = "";
  let poolMetadata = {};

  try {
    if (seedThru <= 0n || tokenAmount <= 0n) {
      throw new Error("Curve reserves are too small to seed an AMM pool yet.");
    }
    assertInitialLiquidityAmounts(tokenAmount, seedThru);

    // Move THRU + tokens to the creator (connected) wallet, then reuse seedPool.
    // Graduation is triggered by the trader; creator must be connected for AMM LP mint.
    if (!connectedAccount) throw new Error("Connect a wallet to complete graduation.");
    if (connectedAccount.address !== market.creator) {
      // Anyone can trigger accounting graduation; AMM seed needs creator later.
      liquidityPendingReason =
        "Graduated on the bonding curve. Creator must open the market and seed the AMM from curve reserves.";
      const updated = updateMarket(market.mintAddress, {
        graduated: true,
        phase: "graduated",
        liquidity: false,
        liquidityPendingReason,
        graduatedAt: Date.now(),
      });
      return updated || market;
    }

    setStatus("Withdrawing curve reserves to seed the AMM…");
    const creatorToken = await ensureTokenAccount(connectedAccount.address, market.mintAddress);
    const curveToken = {
      address: market.curve.tokenAccount,
      bytes: Pubkey.from(market.curve.tokenAccount).toBytes(),
    };

    // Pull tokens from curve → creator (curve signs as fee payer / owner).
    if (tokenAmount > 0n) {
      await submitAs(curveSigner, TOKEN_PROGRAM, {
        accounts: { readWrite: [curveToken.address, creatorToken.address] },
        instructionData: createTransferInstruction({
          sourceAccountBytes: curveToken.bytes,
          destinationAccountBytes: creatorToken.bytes,
          amount: tokenAmount,
        }),
        fee: 0n,
        programLabel: "Curve token withdraw",
      });
    }
    // Pull native THRU from curve → creator.
    if (seedThru > 0n) {
      await submitAs(curveSigner, EOA_PROGRAM, {
        accounts: { readWrite: [connectedAccount.address] },
        instructionData: nativeTransferInstruction(seedThru),
        fee: 0n,
        programLabel: "Curve THRU withdraw",
      });
    }

    const mintObj = {
      address: market.mintAddress,
      bytes: Pubkey.from(market.mintAddress).toBytes(),
    };
    poolMetadata = await seedPool({
      mint: mintObj,
      tokenAccount: creatorToken,
      decimals: market.decimals,
      thruAmount: seedThru,
      tokenAmount,
      setStatus,
    });
    ammSeeded = true;
  } catch (reason) {
    liquidityPendingReason = reason instanceof Error
      ? `Graduated, but AMM seed pending: ${reason.message}`
      : "Graduated, but AMM seed is pending.";
  }

  const updated = updateMarket(market.mintAddress, {
    graduated: true,
    phase: ammSeeded ? "amm" : "graduated",
    liquidity: ammSeeded,
    liquidityPendingReason: ammSeeded ? "" : liquidityPendingReason,
    graduatedAt: Date.now(),
    ...poolMetadata,
    curve: {
      ...market.curve,
      realThru: (c.realThru - (ammSeeded ? seedThru : 0n)).toString(),
      realToken: (c.realToken - (ammSeeded ? tokenAmount : 0n)).toString(),
    },
  });
  return updated || market;
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
    fee: 1n,
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

async function createToken() {
  if (!connectedAccount) {
    openWallet();
    return;
  }

  const name = document.querySelector("[data-token-name]").value.trim();
  const ticker = document.querySelector("[data-token-ticker]").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const description = document.querySelector("[data-token-description]").value.trim();
  const decimals = Number(document.querySelector("[data-token-decimals]").value);
  const supplyText = document.querySelector("[data-token-supply]").value.trim();
  const liquidityText = document.querySelector("[data-token-liquidity]")?.value.trim() || "";
  const pumpMode = document.querySelector("[data-token-pump]")?.checked !== false;

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
  let liquidityThru;
  try {
    liquidityThru = liquidityText ? parseUnits(liquidityText, NATIVE_THRU_DECIMALS) : 0n;
  } catch (reason) {
    createStatus.textContent = reason.message;
    return;
  }
  const liquidityTokens = liquidityThru * PRICE_TOKENS_PER_THRU *
    (10n ** BigInt(decimals)) / (10n ** BigInt(NATIVE_THRU_DECIMALS));
  if (liquidityThru > 0n) {
    try {
      assertInitialLiquidityAmounts(liquidityTokens, liquidityThru);
    } catch (reason) {
      createStatus.textContent = reason.message;
      return;
    }
  }
  if (liquidityTokens > supply * (10n ** BigInt(decimals))) {
    createStatus.textContent = `Initial supply must cover ${formatUnits(liquidityTokens, decimals)} ${ticker} for liquidity.`;
    return;
  }

  createButton.disabled = true;
  try {
    createStatus.textContent = "Preparing your Thru account…";
    await ensureAccountExists((message) => { createStatus.textContent = message; });
    const wantDirectAmm = !pumpMode && liquidityThru > 0n;
    const ammProgramAvailable = wantDirectAmm &&
      (await getAccountSnapshot(GENESIS_AMM_PROGRAM)).exists;
    const nativeBalance = await getAccountSnapshot();
    const curveGasNeed = pumpMode ? CURVE_GAS_FUND + 2n : 0n;
    const needBalance = (wantDirectAmm ? liquidityThru + 1n : 0n) + curveGasNeed;
    if (nativeBalance.balance < needBalance) {
      throw new Error(
        `Insufficient balance: you have ${formatUnits(nativeBalance.balance, NATIVE_THRU_DECIMALS, 9)} THRU. ` +
        (pumpMode
          ? "Claim faucet THRU to fund the bonding-curve gas dust."
          : "Lower the optional liquidity amount or leave it blank."),
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

    let poolMetadata = {};
    let liquidityPendingReason = "";
    let bondingMeta = {};
    if (pumpMode && supply > 0n) {
      bondingMeta = await createBondingCurve({
        mint,
        creatorTokenAccount: tokenAccount,
        decimals,
        supplyWhole: supply,
        setStatus: (message) => { createStatus.textContent = message; },
      });
    } else if (liquidityThru > 0n) {
      if (!ammProgramAvailable) {
        liquidityPendingReason = "The Thru Alphanet AMM program is not deployed yet. No liquidity funds were moved.";
      } else {
        poolMetadata = await seedPool({
          mint,
          tokenAccount,
          decimals,
          thruAmount: liquidityThru,
          tokenAmount: liquidityTokens,
          setStatus: (message) => { createStatus.textContent = message; },
        });
      }
    }

    const market = {
      name,
      ticker,
      description,
      decimals,
      supply: supply.toString(),
      mintAddress: mint.address,
      tokenAccount: tokenAccount.address,
      creator: connectedAccount.address,
      createdAt: Date.now(),
      mode: pumpMode ? "pump" : "amm",
      phase: bondingMeta.phase || (liquidityThru > 0n && !liquidityPendingReason ? "amm" : "awaiting"),
      graduated: false,
      liquidity: Boolean(poolMetadata.poolAddress) || (liquidityThru > 0n && !liquidityPendingReason),
      liquidityRequested: liquidityThru > 0n,
      liquidityPendingReason,
      priceTokensPerThru: PRICE_TOKENS_PER_THRU.toString(),
      creatorFeeBps: CREATOR_FEE_BPS,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      protocolTreasury: GENESIS_TREASURY,
      graduationTargetThru: GRADUATION_REAL_THRU.toString(),
      ...bondingMeta,
      ...poolMetadata,
    };
    const markets = readMarkets();
    markets.unshift(market);
    saveMarkets(markets);
    renderMarkets();
    createStatus.textContent = market.curve
      ? `${ticker} launched on a bonding curve (pump-style). Buy/sell until ` +
        `${formatUnits(GRADUATION_REAL_THRU, NATIVE_THRU_DECIMALS, 9)} THRU is raised, then it graduates. Mint: ${mint.address}`
      : liquidityPendingReason
      ? `${ticker} mint is live. ${liquidityPendingReason} Mint: ${mint.address}`
      : liquidityThru > 0n
      ? `${ticker} is live and tradeable at launch. Creator LP: ${poolMetadata.creatorLpAccount}`
      : `${ticker} is live on Thru. Mint: ${mint.address}`;
    createButton.textContent = "Token created on Thru";
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

function renderMarketCard(market, index) {
  const progress = market.curve ? curveProgress(market) : (market.liquidity ? 100 : 0);
  return `
    <article class="market-row">
      <div class="market-identity"><span>${market.ticker.slice(0, 1)}</span><div><strong>${market.name}</strong><small>${market.ticker} · ${market.mintAddress.slice(0, 7)}…${market.mintAddress.slice(-5)}</small></div></div>
      <strong>${BigInt(market.supply || "0").toLocaleString()}</strong>
      <div class="curve-progress" title="Bonding progress to graduation">
        <div class="curve-progress-bar"><i style="width:${progress}%"></i></div>
        <span class="liquidity-state">${marketStatusLabel(market)}</span>
      </div>
      <div class="trade-actions">
        <button type="button" data-trade="${index}" data-trade-side="buy">Buy</button>
        <button type="button" data-trade="${index}" data-trade-side="sell">Sell</button>
        <button type="button" data-liquidity="${index}">Pool</button>
      </div>
    </article>`;
}

function renderMarkets() {
  const markets = readMarkets();
  const table = document.querySelector(".token-table");
  document.querySelector("[data-count]").textContent = String(markets.length);

  const bonding = [];
  const graduated = [];
  markets.forEach((market, index) => {
    if (isGraduatedMarket(market) && !isBondingMarket(market)) graduated.push({ market, index });
    else bonding.push({ market, index });
  });

  const graduatedHost = document.querySelector("[data-graduated-list]");
  if (graduatedHost) {
    if (!graduated.length) {
      graduatedHost.innerHTML = `
        <div class="empty-ledger">
          <div class="seal">G</div>
          <div><strong>No graduated markets yet.</strong><span>Markets that fill the bonding curve will land here, then seed the AMM.</span></div>
          <em>Awaiting record</em>
        </div>`;
    } else {
      graduatedHost.innerHTML = `<div class="market-list">${graduated.map(({ market, index }) => renderMarketCard(market, index)).join("")}</div>`;
    }
  }

  if (!markets.length) {
    table.innerHTML = `
      <div class="table-head"><span>Market</span><span>Supply</span><span>Progress</span><span>Trade</span></div>
      <div class="token-empty">
        <div class="pulse-chart" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <h3>The registry is quiet.</h3>
        <p>Launch a pump-style token to open a bonding curve. Buys and sells run until graduation.</p>
        <a href="#create">Create the first market</a>
      </div>`;
    return;
  }

  const list = bonding.length ? bonding : markets.map((market, index) => ({ market, index }));
  table.innerHTML = `
    <div class="table-head"><span>Market</span><span>Supply</span><span>Progress</span><span>Trade</span></div>
    <div class="market-list">${list.map(({ market, index }) => renderMarketCard(market, index)).join("")}</div>`;
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

let wrapSide = "wrap";

function setWrapSide(side) {
  wrapSide = side === "unwrap" ? "unwrap" : "wrap";
  document.querySelectorAll("[data-wrap-side]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.wrapSide === wrapSide);
  });
  const label = document.querySelector("[data-wrap-amount-label]");
  const submit = document.querySelector("[data-wrap-submit]");
  if (label) {
    label.textContent = wrapSide === "wrap" ? "Amount in THRU" : "Amount in wTHRU";
  }
  if (submit) {
    submit.textContent = wrapSide === "wrap"
      ? "Wrap THRU → wTHRU"
      : "Unwrap wTHRU → THRU";
  }
}

async function swapThruWthru() {
  if (!connectedAccount) return openWallet();
  const button = document.querySelector("[data-wrap-submit]");
  const status = document.querySelector("[data-wrap-status]");
  const amountText = document.querySelector("[data-wrap-amount]")?.value.trim() || "";
  let amount;
  try {
    amount = parseUnits(amountText, NATIVE_THRU_DECIMALS);
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  } catch (reason) {
    status.textContent = reason instanceof Error ? reason.message : "Enter a valid amount.";
    return;
  }

  button.disabled = true;
  try {
    await ensureAccountExists((message) => { status.textContent = message; });
    if (wrapSide === "wrap") {
      const snapshot = await getAccountSnapshot();
      // Reserve 2 base units for wrap transfer fee + deposit fee headroom.
      if (snapshot.balance < amount + 2n) {
        throw new Error(
          `Insufficient native THRU. Available: ${formatUnits(snapshot.balance, NATIVE_THRU_DECIMALS, 9)} THRU ` +
          "(keep a little for fees).",
        );
      }
      status.textContent = `Wrapping ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU…`;
      const destination = await getWthruTokenAccount(true);
      await wrapThru(amount, destination);
      status.textContent =
        `Wrapped ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU → wTHRU. ` +
        "Native balance drops; wTHRU balance rises.";
    } else {
      const source = await getWthruTokenAccount(false);
      if (!(await getAccountSnapshot(source.address)).exists) {
        throw new Error("No wTHRU token account yet. Wrap some THRU first.");
      }
      status.textContent = `Unwrapping ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} wTHRU…`;
      await unwrapThru(amount, source);
      status.textContent =
        `Unwrapped ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} wTHRU → THRU. ` +
        "Native balance rises; wTHRU balance drops.";
    }
    await refreshBalance();
  } catch (reason) {
    status.textContent = reason instanceof Error ? reason.message : "Swap failed on Thru.";
  } finally {
    button.disabled = false;
  }
}

async function sendThru() {
  if (!connectedAccount) return openWallet();
  const button = document.querySelector("[data-send]");
  const status = document.querySelector("[data-send-status]");
  const recipientText = document.querySelector("[data-send-address]").value.trim();
  const amountText = document.querySelector("[data-send-amount]").value.trim();
  let recipient;
  let amount;
  try {
    recipient = Pubkey.from(recipientText);
    amount = parseUnits(amountText, NATIVE_THRU_DECIMALS);
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
    if (recipient.toThruFmt() === connectedAccount.address) throw new Error("Enter a different recipient address.");
  } catch (reason) {
    status.textContent = reason instanceof Error ? reason.message : "Enter a valid Thru address and amount.";
    return;
  }

  button.disabled = true;
  try {
    const snapshot = await getAccountSnapshot();
    if (snapshot.balance < amount + 1n) {
      throw new Error(`Insufficient balance. Available: ${formatUnits(snapshot.balance, NATIVE_THRU_DECIMALS, 9)} THRU.`);
    }
    status.textContent = `Sending ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU…`;
    await submitProgramInstruction(EOA_PROGRAM, {
      accounts: { readWrite: [recipient] },
      instructionData: nativeTransferInstruction(amount),
      fee: 1n,
    });
    status.textContent = `Sent ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} THRU to ${compactAddress(recipient.toThruFmt())}.`;
    await refreshBalance();
  } catch (reason) {
    status.textContent = reason instanceof Error ? reason.message : "Transfer failed on Thru.";
  } finally {
    button.disabled = false;
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
document.querySelector("[data-copy-address]")?.addEventListener("click", () => {
  if (connectedAccount) navigator.clipboard.writeText(connectedAccount.address);
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
document.querySelector("[data-wrap-submit]")?.addEventListener("click", swapThruWthru);
document.querySelector("[data-send]")?.addEventListener("click", sendThru);
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
  showWalletView(null);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !walletModal.hidden) closeWallet();
});

document.querySelector("[data-create-form]")?.addEventListener("submit", (event) => {
  event.preventDefault();
  createToken();
});

const tradeModal = document.querySelector("[data-trade-modal]");
const liquidityModal = document.querySelector("[data-liquidity-modal]");
let activeTrade = null;
let activeLiquidityMarket = null;
let activeSide = "buy";

function openTrade(index, side) {
  activeTrade = readMarkets()[index];
  activeSide = side;
  if (!activeTrade) return;
  tradeModal.hidden = false;
  document.body.classList.add("modal-open");
  document.querySelector("[data-trade-title]").textContent = `${side === "buy" ? "Buy" : "Sell"} ${activeTrade.ticker}`;
  document.querySelector("[data-trade-submit]").textContent = side === "buy" ? "Buy with THRU" : `Sell ${activeTrade.ticker}`;
  document.querySelector("[data-trade-input-label]").textContent = side === "buy" ? "Pay with THRU" : `Sell ${activeTrade.ticker}`;
  const progress = activeTrade.curve ? curveProgress(activeTrade) : null;
  if (isBondingMarket(activeTrade)) {
    const c = readCurve(activeTrade);
    document.querySelector("[data-trade-status]").textContent =
      `Bonding curve · ${progress.toFixed(1)}% to graduation ` +
      `(${formatUnits(c.realThru, NATIVE_THRU_DECIMALS, 9)} / ${formatUnits(c.graduationTarget, NATIVE_THRU_DECIMALS, 9)} THRU raised). ` +
      "Like pump.fun: trade the curve until the target, then liquidity seeds the AMM.";
  } else if (activeTrade.liquidity) {
    document.querySelector("[data-trade-status]").textContent = "Quote updates from the Thru AMM pool.";
  } else if (activeTrade.graduated) {
    document.querySelector("[data-trade-status]").textContent =
      activeTrade.liquidityPendingReason ||
      "This market graduated from the bonding curve. AMM seed is pending.";
  } else {
    document.querySelector("[data-trade-status]").textContent =
      "This mint is live, but has no bonding curve or AMM pool yet.";
  }
  document.querySelectorAll("[data-side]").forEach((button) => button.classList.toggle("selected", button.dataset.side === side));
  document.querySelector("[data-trade-amount]").value = "";
  document.querySelector("[data-trade-quote]").textContent = "—";
}

function closeTrade() {
  tradeModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function openLiquidity(index) {
  activeLiquidityMarket = readMarkets()[index];
  if (!activeLiquidityMarket) return;
  liquidityModal.hidden = false;
  document.body.classList.add("modal-open");
  document.querySelector("[data-liquidity-title]").textContent =
    `Provide ${activeLiquidityMarket.ticker} liquidity`;
  document.querySelector("[data-liquidity-status]").textContent = activeLiquidityMarket.liquidity
    ? "Your deposit will join the live on-chain pool and mint LP tokens to your wallet."
    : "The creator must successfully initialize this pool before public deposits can begin.";
}

function closeLiquidity() {
  liquidityModal.hidden = true;
  document.body.classList.remove("modal-open");
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
    status.textContent =
      `Buying ≈ ${formatUnits(quote.tokensOut, market.decimals)} ${market.ticker} on the bonding curve…`;
    // 1) User pays native THRU into the curve vault.
    await submitProgramInstruction(EOA_PROGRAM, {
      accounts: { readWrite: [curveSigner.address] },
      instructionData: nativeTransferInstruction(amount),
      fee: 1n,
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
    status.textContent =
      `Bought ${formatUnits(quote.tokensOut, market.decimals)} ${market.ticker} ` +
      `(fee ${formatUnits(quote.fee, NATIVE_THRU_DECIMALS, 9)} THRU).`;
    if (quote.next.realThru >= quote.next.graduationTarget) {
      updated = await graduateMarket(updated || market, (message) => { status.textContent = message; });
      status.textContent += updated?.liquidity
        ? " Market graduated and AMM was seeded."
        : " Market graduated from the bonding curve.";
    }
    activeTrade = updated || readMarkets().find((m) => m.mintAddress === market.mintAddress);
    renderMarkets();
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
  const updated = applyCurveState(market, quote.next);
  activeTrade = updated || market;
  status.textContent =
    `Sold for ${formatUnits(quote.netThru, NATIVE_THRU_DECIMALS, 9)} THRU ` +
    `(fee ${formatUnits(quote.fee, NATIVE_THRU_DECIMALS, 9)} THRU).`;
  renderMarkets();
}

async function executeTrade() {
  const button = document.querySelector("[data-trade-submit]");
  const status = document.querySelector("[data-trade-status]");
  if (!connectedAccount) {
    closeTrade();
    openWallet();
    return;
  }

  const value = document.querySelector("[data-trade-amount]").value;
  let amount;
  try {
    amount = parseUnits(value, activeSide === "buy" ? NATIVE_THRU_DECIMALS : activeTrade.decimals);
    if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  } catch (reason) {
    status.textContent = reason.message;
    return;
  }

  button.disabled = true;
  try {
    status.textContent = "Preparing your Thru account…";
    await ensureAccountExists((message) => { status.textContent = message; });

    // Pump-style bonding curve path (default for new launches).
    if (isBondingMarket(activeTrade)) {
      await executeCurveTrade(amount, status);
      return;
    }

    if (!activeTrade?.liquidity) {
      status.textContent = activeTrade?.graduated
        ? (activeTrade.liquidityPendingReason || "Graduated, but the AMM pool is not seeded yet.")
        : "Trade not submitted: no bonding curve or AMM pool is available for this mint.";
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
  const button = event.target.closest("[data-trade]");
  if (button) openTrade(Number(button.dataset.trade), button.dataset.tradeSide);
  const liquidityButton = event.target.closest("[data-liquidity]");
  if (liquidityButton) openLiquidity(Number(liquidityButton.dataset.liquidity));
}
document.querySelector(".token-table")?.addEventListener("click", onMarketActionClick);
document.querySelector("[data-graduated-list]")?.addEventListener("click", onMarketActionClick);
document.querySelectorAll("[data-trade-close]").forEach((button) => button.addEventListener("click", closeTrade));
document.querySelectorAll("[data-side]").forEach((button) => button.addEventListener("click", () => {
  if (activeTrade) openTrade(readMarkets().findIndex((market) => market.mintAddress === activeTrade.mintAddress), button.dataset.side);
}));
document.querySelector("[data-trade-amount]")?.addEventListener("input", (event) => {
  const quote = document.querySelector("[data-trade-quote]");
  if (!event.target.value || !activeTrade) {
    quote.textContent = "—";
    return;
  }
  try {
    const raw = parseUnits(
      event.target.value,
      activeSide === "buy" ? NATIVE_THRU_DECIMALS : activeTrade.decimals,
    );
    if (isBondingMarket(activeTrade)) {
      if (activeSide === "buy") {
        const q = quoteCurveBuy(activeTrade, raw);
        quote.textContent =
          `≈ ${formatUnits(q.tokensOut, activeTrade.decimals)} ${activeTrade.ticker} ` +
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
      quote.textContent = "—";
      return;
    }
    const afterFees = raw * 9970n / 10000n;
    quote.textContent = activeSide === "buy"
      ? `≈ ${formatUnits(afterFees * PRICE_TOKENS_PER_THRU * (10n ** BigInt(activeTrade.decimals)) / (10n ** BigInt(NATIVE_THRU_DECIMALS)), activeTrade.decimals)} ${activeTrade.ticker}`
      : `≈ ${formatUnits(afterFees * (10n ** BigInt(NATIVE_THRU_DECIMALS)) / (PRICE_TOKENS_PER_THRU * (10n ** BigInt(activeTrade.decimals))), NATIVE_THRU_DECIMALS, 9)} WTHRU`;
  } catch (reason) {
    quote.textContent = reason instanceof Error ? reason.message : "—";
  }
});
document.querySelector("[data-trade-submit]")?.addEventListener("click", executeTrade);
document.querySelectorAll("[data-liquidity-close]").forEach((button) => {
  button.addEventListener("click", closeLiquidity);
});
document.querySelector("[data-liquidity-submit]")?.addEventListener("click", provideLiquidity);

renderMarkets();
restoreWalletSession();
