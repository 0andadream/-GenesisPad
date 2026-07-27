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
const FAUCET_AMOUNT = 10000n;
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
const EOA_PROGRAM = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 3 : 0);
const FAUCET_PROGRAM = Uint8Array.from({ length: 32 }, (_, index) => index === 31 ? 250 : 0);
let connectedAccount = null;
let generatedAccount = null;
const WALLET_SESSION_KEY = "genesis-thru-wallet-session";

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

async function refreshBalance() {
  if (!connectedAccount) return;
  const balance = document.querySelector("[data-balance]");
  try {
    const snapshot = await getAccountSnapshot();
    balance.textContent = `${formatUnits(snapshot.balance, NATIVE_THRU_DECIMALS, 9)} THRU`;
  } catch {
    balance.textContent = "Unavailable";
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

async function submitTransaction(rawTransaction) {
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
      } else if (userCode === 24) {
        explanation = "LP mint is missing. Refresh and try creating the pool again.";
      } else if (userCode === 25) {
        explanation = "Pool vault accounts are missing. Refresh and try again.";
      } else if (result.vmError === -767 && userCode != null && Math.abs(userCode) > 1000) {
        explanation =
          "Thru VM faulted while initializing the AMM pool. Hard-refresh and try a new token launch.";
      } else if (userCode != null && ammErrors[userCode]) {
        explanation = ammErrors[userCode];
      } else if (userCode != null && syscallErrors[userCode]) {
        explanation = syscallErrors[userCode];
      } else {
        explanation =
          `Thru rejected the transaction (VM ${result.vmError}, program code ${result.userErrorCode ?? "unknown"}).`;
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

async function submitWithNonce(startNonce, builder) {
  let nonce = startNonce < 0n ? 0n : startNonce;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await submitTransaction(await builder(nonce));
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
    program: EOA_PROGRAM,
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
  }));
}

async function submitProgramInstruction(
  program,
  { accounts, instructionData, fee = 0n, startSlot: anchoredStartSlot },
) {
  const snapshot = await getAccountSnapshot();
  const slot = anchoredStartSlot ?? await currentSlot();
  await submitWithNonce(snapshot.nonce, (nonce) => buildAndSign({
    program,
    accounts,
    instructionData,
    header: {
      fee, nonce, startSlot: slot, expiryAfter: 100,
      computeUnits: 500000, memoryUnits: 10000, stateUnits: 10000, chainId: CHAIN_ID,
    },
  }));
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

async function wrapThru(amount, destination) {
  await submitProgramInstruction(EOA_PROGRAM, {
    accounts: { readWrite: [WTHRU_VAULT] },
    instructionData: nativeTransferInstruction(amount),
    fee: 1n,
  });
  await submitProgramInstruction(WTHRU_PROGRAM, {
    accounts: {
      readWrite: [WTHRU_MINT, WTHRU_VAULT, destination.address],
      readOnly: [TOKEN_PROGRAM],
    },
    instructionData: async (context) => {
      const data = new Uint8Array(12);
      const view = new DataView(data.buffer);
      view.setUint32(0, 1, true);
      view.setUint16(4, context.getAccountIndex(Pubkey.from(TOKEN_PROGRAM).toBytes()), true);
      view.setUint16(6, context.getAccountIndex(Pubkey.from(WTHRU_VAULT).toBytes()), true);
      view.setUint16(8, context.getAccountIndex(Pubkey.from(WTHRU_MINT).toBytes()), true);
      view.setUint16(10, context.getAccountIndex(destination.bytes), true);
      return data;
    },
  });
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
    });
    await waitForAccount(pool.poolAddress, "AMM pool");
  }

  setStatus("Depositing the opening liquidity…");
  const creatorLp = await ensureTokenAccount(connectedAccount.address, pool.lpMint.address);
  const tokenIsOne = pool.mintOneAddress === mint.address;
  const depositorOne = tokenIsOne ? tokenAccount : creatorWthru;
  const depositorTwo = tokenIsOne ? creatorWthru : tokenAccount;
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
      maxAmountMintOne: tokenIsOne ? tokenAmount : thruAmount,
      maxAmountMintTwo: tokenIsOne ? thruAmount : tokenAmount,
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
  if (liquidityThru > 0n && liquidityTokens < 1000n) {
    createStatus.textContent = "Seed a larger amount; the pool requires at least 1,000 raw token units.";
    return;
  }
  if (liquidityTokens > supply * (10n ** BigInt(decimals))) {
    createStatus.textContent = `Initial supply must cover ${formatUnits(liquidityTokens, decimals)} ${ticker} for liquidity.`;
    return;
  }

  createButton.disabled = true;
  try {
    createStatus.textContent = "Preparing your Thru account…";
    await ensureAccountExists((message) => { createStatus.textContent = message; });
    const ammProgramAvailable = liquidityThru > 0n &&
      (await getAccountSnapshot(GENESIS_AMM_PROGRAM)).exists;
    const nativeBalance = await getAccountSnapshot();
    if (ammProgramAvailable && nativeBalance.balance < liquidityThru + 1n) {
      throw new Error(
        `Insufficient balance: you have ${formatUnits(nativeBalance.balance, NATIVE_THRU_DECIMALS, 9)} THRU. ` +
        "Lower the optional liquidity amount or leave it blank.",
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
    if (liquidityThru > 0n) {
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
      liquidity: liquidityThru > 0n && !liquidityPendingReason,
      liquidityRequested: liquidityThru > 0n,
      liquidityPendingReason,
      priceTokensPerThru: PRICE_TOKENS_PER_THRU.toString(),
      creatorFeeBps: CREATOR_FEE_BPS,
      protocolFeeBps: PROTOCOL_FEE_BPS,
      protocolTreasury: GENESIS_TREASURY,
      ...poolMetadata,
    };
    const markets = readMarkets();
    markets.unshift(market);
    localStorage.setItem("genesis-markets", JSON.stringify(markets.slice(0, 50)));
    renderMarkets();
    createStatus.textContent = liquidityPendingReason
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
    return JSON.parse(localStorage.getItem("genesis-markets") || "[]");
  } catch {
    return [];
  }
}

function renderMarkets() {
  const markets = readMarkets();
  const table = document.querySelector(".token-table");
  document.querySelector("[data-count]").textContent = String(markets.length);
  if (!markets.length) return;
  table.innerHTML = `
    <div class="table-head"><span>Market</span><span>Supply</span><span>Liquidity</span><span>Trade</span></div>
    <div class="market-list">${markets.map((market, index) => `
      <article class="market-row">
        <div class="market-identity"><span>${market.ticker.slice(0, 1)}</span><div><strong>${market.name}</strong><small>${market.ticker} · ${market.mintAddress.slice(0, 7)}…${market.mintAddress.slice(-5)}</small></div></div>
        <strong>${BigInt(market.supply || "0").toLocaleString()}</strong>
        <span class="liquidity-state">${market.liquidity ? "Live" : market.liquidityPendingReason ? "AMM pending" : "Awaiting pool"}</span>
        <div class="trade-actions"><button type="button" data-trade="${index}" data-trade-side="buy">Buy</button><button type="button" data-trade="${index}" data-trade-side="sell">Sell</button><button type="button" data-liquidity="${index}">Pool</button></div>
      </article>`).join("")}
    </div>`;
}

async function claimFaucet() {
  if (!connectedAccount) return openWallet();
  const button = document.querySelector("[data-faucet]");
  const status = document.querySelector("[data-faucet-status]");
  const setStatus = (message) => { status.textContent = message; };
  button.disabled = true;
  try {
    await ensureAccountExists(setStatus);
    setStatus("Signing faucet claim locally…");
    const vault = Pubkey.from(FAUCET_VAULT);
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
    }));
    setStatus("Claim submitted. Waiting for the Alphanet balance…");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const updated = await getAccountSnapshot();
      document.querySelector("[data-balance]").textContent =
        `${formatUnits(updated.balance, NATIVE_THRU_DECIMALS, 9)} THRU`;
      if (updated.balance > snapshot.balance) {
        setStatus("Test tokens received on Thru.");
        return;
      }
    }
    setStatus("Claim confirmed. The balance may take another moment to update.");
  } catch (reason) {
    setStatus(`${reason instanceof Error ? reason.message : "Faucet claim failed."} You can also use faucet.thruscan.net.`);
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
document.querySelector("[data-send]")?.addEventListener("click", sendThru);
document.querySelector("[data-disconnect]")?.addEventListener("click", () => {
  if (connectedAccount) connectedAccount.privateKey.fill(0);
  connectedAccount = null;
  generatedAccount = null;
  try { sessionStorage.removeItem(WALLET_SESSION_KEY); } catch { /* Storage is unavailable. */ }
  setWalletState("Connect wallet");
  document.querySelector("[data-import-key]").value = "";
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
  document.querySelector("[data-trade-submit]").textContent = side === "buy" ? "Buy with faucet THRU" : `Sell ${activeTrade.ticker}`;
  document.querySelector("[data-trade-input-label]").textContent = side === "buy" ? "Pay with faucet THRU" : `Sell ${activeTrade.ticker}`;
  document.querySelector("[data-trade-status]").textContent = activeTrade.liquidity
    ? "Quote updates from the Thru AMM pool."
    : activeTrade.liquidityPendingReason
      ? `${activeTrade.liquidityPendingReason} Buy and Sell will activate only after an on-chain AMM program is available.`
    : "This mint is live, but trading needs a wrapped-THRU liquidity pool. No funds will be moved until that pool exists.";
  document.querySelectorAll("[data-side]").forEach((button) => button.classList.toggle("selected", button.dataset.side === side));
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
        maxAmountMintOne: tokenIsOne ? tokenAmount : thruAmount,
        maxAmountMintTwo: tokenIsOne ? thruAmount : tokenAmount,
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

async function executeTrade() {
  const button = document.querySelector("[data-trade-submit]");
  const status = document.querySelector("[data-trade-status]");
  if (!connectedAccount) {
    closeTrade();
    openWallet();
    return;
  }
  if (!activeTrade?.liquidity) {
    status.textContent = "Trade not submitted: a wrapped-THRU pool has not been seeded for this mint yet.";
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
  const protocolFee = amount * BigInt(PROTOCOL_FEE_BPS) / 10000n;
  const swapAmount = amount - protocolFee;
  if (swapAmount <= 0n) {
    status.textContent = "Amount is too small to route.";
    return;
  }

  button.disabled = true;
  try {
    status.textContent = "Preparing your Thru token accounts…";
    await ensureAccountExists((message) => { status.textContent = message; });
    const userToken = await ensureTokenAccount(connectedAccount.address, activeTrade.mintAddress);
    const userWthru = await ensureTokenAccount(connectedAccount.address, WTHRU_MINT);
    const feeMint = activeSide === "buy" ? WTHRU_MINT : activeTrade.mintAddress;
    const treasuryAccount = await ensureTokenAccount(GENESIS_TREASURY, feeMint);

    if (activeSide === "buy") {
      status.textContent = `Wrapping ${formatUnits(amount, NATIVE_THRU_DECIMALS, 9)} faucet THRU…`;
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

document.querySelector(".token-table")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-trade]");
  if (button) openTrade(Number(button.dataset.trade), button.dataset.tradeSide);
  const liquidityButton = event.target.closest("[data-liquidity]");
  if (liquidityButton) openLiquidity(Number(liquidityButton.dataset.liquidity));
});
document.querySelectorAll("[data-trade-close]").forEach((button) => button.addEventListener("click", closeTrade));
document.querySelectorAll("[data-side]").forEach((button) => button.addEventListener("click", () => {
  if (activeTrade) openTrade(readMarkets().findIndex((market) => market.mintAddress === activeTrade.mintAddress), button.dataset.side);
}));
document.querySelector("[data-trade-amount]")?.addEventListener("input", (event) => {
  const quote = document.querySelector("[data-trade-quote]");
  if (!event.target.value || !activeTrade?.liquidity) {
    quote.textContent = "—";
    return;
  }
  try {
    const raw = parseUnits(event.target.value, activeSide === "buy" ? NATIVE_THRU_DECIMALS : activeTrade.decimals);
    const afterFees = raw * 9970n / 10000n;
    quote.textContent = activeSide === "buy"
      ? `≈ ${formatUnits(afterFees * PRICE_TOKENS_PER_THRU * (10n ** BigInt(activeTrade.decimals)) / (10n ** BigInt(NATIVE_THRU_DECIMALS)), activeTrade.decimals)} ${activeTrade.ticker}`
      : `≈ ${formatUnits(afterFees * (10n ** BigInt(NATIVE_THRU_DECIMALS)) / (PRICE_TOKENS_PER_THRU * (10n ** BigInt(activeTrade.decimals))), NATIVE_THRU_DECIMALS, 9)} WTHRU`;
  } catch {
    quote.textContent = "—";
  }
});
document.querySelector("[data-trade-submit]")?.addEventListener("click", executeTrade);
document.querySelectorAll("[data-liquidity-close]").forEach((button) => {
  button.addEventListener("click", closeLiquidity);
});
document.querySelector("[data-liquidity-submit]")?.addEventListener("click", provideLiquidity);

renderMarkets();
restoreWalletSession();
