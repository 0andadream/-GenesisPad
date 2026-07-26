import { BrowserSDK } from "@thru/wallet";

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

const connectButtons = [...document.querySelectorAll("[data-connect]")];
const createButton = document.querySelector("[data-create]");
const createStatus = document.querySelector("[data-create-status]");
let connectedAccount = null;
let wallet = null;
let walletReady;

function compactAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Connected";
}

function setWalletState(label, disabled = false) {
  connectButtons.forEach((button) => {
    button.textContent = label;
    button.disabled = disabled;
  });
}

async function initializeWallet() {
  if (!walletReady) {
    walletReady = (async () => {
      wallet = new BrowserSDK({
        iframeUrl: "https://app.tid.sh/embedded",
        rpcUrl: "https://rpc.alphanet.thru.org",
        signingSessionStorage: false,
      });
      wallet.on("connect", ({ accounts }) => {
        connectedAccount = accounts?.[0] || null;
        setWalletState(compactAddress(connectedAccount?.address));
      });
      await wallet.initialize();
    })();
    await walletReady;
  }
}

async function connectWallet() {
  try {
    setWalletState("Opening Thru wallet…", true);
    await initializeWallet();
    const result = await wallet.connect({
      metadata: {
        appId: window.location.origin,
        appName: "Genesis",
        appUrl: window.location.origin,
      },
    });
    connectedAccount = result.accounts?.[0] || null;
    setWalletState(compactAddress(connectedAccount?.address));
    if (createButton) createButton.textContent = "Continue with connected wallet";
    if (createStatus) createStatus.textContent = "Connected through Thru Wallet. Secret keys remain inside the hosted wallet.";
    return connectedAccount;
  } catch (error) {
    console.error("Thru wallet connection failed", error);
    walletReady = undefined;
    wallet = null;
    setWalletState("Try connecting again");
    if (createStatus) createStatus.textContent = "The wallet connection was cancelled or could not be completed.";
    return null;
  }
}

connectButtons.forEach((button) => button.addEventListener("click", connectWallet));
createButton?.addEventListener("click", async () => {
  const account = connectedAccount || await connectWallet();
  if (!account) return;
  createStatus.textContent = "Wallet connected. Token issuance will activate after the Genesis program address and launch parameters are deployed on Thru.";
});
