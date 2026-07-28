/**
 * Bridge: Genesis trade modal ↔ DexScreener Lightweight Charts controller.
 * Vanilla JS — no React mount required.
 */
import { createDexChart } from "../chart/src/api.ts";
import { tradesToCandles } from "../chart/src/candleBuilder.ts";

const THRU_DECIMALS = 9;

/** @type {import("../chart/src/api").DexChart | null} */
let liveChart = null;
let lastMarketKey = "";
let lastPointSig = "";
/** @type {string} */
let liveTimeframe = "5m";

const TF_MAP = {
  "1s": "1s",
  "5s": "5s",
  "15s": "15s",
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  all: "4h",
};

function hostEl() {
  return document.querySelector("[data-live-chart]");
}

function toHumanPrice(priceBase) {
  try {
    const raw = typeof priceBase === "bigint" ? priceBase : BigInt(String(priceBase || "0"));
    const scale = 10n ** BigInt(THRU_DECIMALS);
    const whole = raw / scale;
    const frac = (raw % scale).toString().padStart(THRU_DECIMALS, "0");
    return Number(`${whole}.${frac}`);
  } catch {
    const n = Number(priceBase);
    return Number.isFinite(n) ? n : 0;
  }
}

function toHumanThru(thruBase) {
  return toHumanPrice(thruBase);
}

/**
 * Convert market.chart trade prints → live trades for the candle builder.
 * @param {any} market
 */
export function marketToTrades(market) {
  const points = Array.isArray(market?.chart) ? market.chart : [];
  /** @type {import("../chart/src/types").Trade[]} */
  const trades = [];
  for (const p of points) {
    if (!p) continue;
    const side = p.side === "sell" ? "sell" : p.side === "buy" ? "buy" : undefined;
    // Include seed as a first print so empty markets still open a candle
    if (!side && p.side !== "seed" && p.side !== "live") continue;
    const price = toHumanPrice(p.price);
    if (!(price > 0)) continue;
    const t = Number(p.t || p.ts || p.at || 0);
    if (!(t > 0)) continue;
    trades.push({
      timestamp: t < 1e12 ? t * 1000 : t,
      price,
      volume: toHumanThru(p.thru || "0"),
      side: side || "buy",
      id: `${t}-${p.side}-${p.price}-${p.thru || 0}`,
    });
  }
  return trades.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * @param {any} market
 */
function marketToMarkers(market) {
  const points = Array.isArray(market?.chart) ? market.chart : [];
  /** @type {import("../chart/src/types").TradeMarker[]} */
  const markers = [];
  for (const p of points) {
    if (!p || (p.side !== "buy" && p.side !== "sell")) continue;
    const t = Number(p.t || 0);
    if (!(t > 0)) continue;
    markers.push({
      time: Math.floor((t < 1e12 ? t * 1000 : t) / 1000),
      side: p.side,
      text: p.side === "buy" ? "B" : "S",
    });
  }
  const byTime = new Map();
  for (const m of markers) byTime.set(m.time, m);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-80);
}

function pointsSignature(market) {
  const pts = Array.isArray(market?.chart) ? market.chart : [];
  const trades = pts.filter((p) => p && (p.side === "buy" || p.side === "sell"));
  const last = trades[trades.length - 1];
  return [
    market?.mintAddress || "",
    trades.length,
    last ? `${last.t}:${last.side}:${last.price}:${last.thru}` : "",
    market?.curve?.virtualThru || "",
    market?.curve?.realThru || "",
    market?.lastPrice || "",
  ].join("|");
}

function formatSpotLabel(n) {
  if (!(n > 0)) return "—";
  if (n >= 1) return `${n.toFixed(6)} THRU`;
  if (n >= 0.0001) return `${n.toFixed(8)} THRU`;
  return `${n.toExponential(4)} THRU`;
}

function updateHeader(market) {
  const priceEl = document.querySelector("[data-chart-price]");
  const changeEl = document.querySelector("[data-chart-change]");
  const changeVal = document.querySelector("[data-chart-change-value]");
  const rangeLabel = document.querySelector("[data-chart-range-label]");
  const tradesEl = document.querySelector("[data-chart-trades]");
  const rangeEl = document.querySelector("[data-chart-range]");

  let spot = 0;
  try {
    if (market?.lastPrice) spot = toHumanPrice(market.lastPrice);
  } catch { /* ignore */ }

  if (priceEl && spot > 0) {
    const prev = priceEl.textContent;
    priceEl.textContent = formatSpotLabel(spot);
    if (prev && prev !== priceEl.textContent) {
      priceEl.classList.remove("price-flash");
      void priceEl.offsetWidth;
      priceEl.classList.add("price-flash");
    }
  }

  const pts = Array.isArray(market?.chart) ? market.chart : [];
  const priced = pts
    .filter((p) => p && p.price && (p.side === "buy" || p.side === "sell" || p.side === "seed"))
    .map((p) => toHumanPrice(p.price))
    .filter((n) => n > 0);
  const open = priced[0] || spot;
  const last = spot > 0 ? spot : priced[priced.length - 1] || 0;
  let pctText = "0.00%";
  let up = true;
  if (open > 0 && last > 0 && last !== open) {
    up = last >= open;
    const pct = ((last - open) / open) * 100;
    pctText = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }
  if (changeVal) changeVal.textContent = pctText;
  if (changeEl) {
    changeEl.classList.toggle("up", up && last !== open);
    changeEl.classList.toggle("down", !up && last !== open);
    changeEl.classList.toggle("is-up", up && last !== open);
    changeEl.classList.toggle("is-down", !up && last !== open);
  }
  if (rangeLabel) rangeLabel.textContent = liveTimeframe === "all" ? "ALL" : liveTimeframe;
  if (tradesEl) {
    const buys = pts.filter((p) => p?.side === "buy").length;
    const sells = pts.filter((p) => p?.side === "sell").length;
    const n = buys + sells;
    tradesEl.textContent = n
      ? `${n} trade${n === 1 ? "" : "s"} · ${buys}B / ${sells}S`
      : "No trades yet";
  }
  if (rangeEl) rangeEl.textContent = `OHLC · ${liveTimeframe} · THRU · live`;
}

/**
 * Mount Lightweight Charts into the trade modal host.
 * @param {any} market
 * @param {string} [timeframe]
 */
export function mountLiveChart(market, timeframe = "5m") {
  const host = hostEl();
  if (!host) return null;
  liveTimeframe = timeframe in TF_MAP ? timeframe : "5m";

  if (!liveChart) {
    liveChart = createDexChart({
      timeframe: TF_MAP[liveTimeframe] || "5m",
      showVolume: true,
      showMarkers: true,
      autoScroll: true,
      theme: {
        background: "#0d1117",
        text: "#8b949e",
        grid: "rgba(48, 54, 61, 0.55)",
        border: "#21262d",
        up: "#26a69a",
        down: "#ef5350",
        upVolume: "rgba(38, 166, 154, 0.45)",
        downVolume: "rgba(239, 83, 80, 0.45)",
        crosshair: "rgba(139, 148, 158, 0.55)",
        priceLine: "#58a6ff",
      },
    });
    liveChart.initializeChart(host);
  }

  lastMarketKey = market?.mintAddress || "";
  syncLiveChart(market, { force: true });
  return liveChart;
}

/**
 * Push latest market tape into the live chart.
 * @param {any} market
 * @param {{ force?: boolean }} [opts]
 */
export function syncLiveChart(market, opts = {}) {
  if (!liveChart || !market) return;
  const sig = pointsSignature(market);
  if (!opts.force && sig === lastPointSig && market.mintAddress === lastMarketKey) {
    updateHeader(market);
    return;
  }
  lastPointSig = sig;
  lastMarketKey = market.mintAddress || lastMarketKey;

  const trades = marketToTrades(market);
  const tf = TF_MAP[liveTimeframe] || "5m";
  if (trades.length) {
    const candles = tradesToCandles(trades, tf);
    liveChart.setHistoricalData(candles);
  } else if (market.lastPrice) {
    const price = toHumanPrice(market.lastPrice);
    const t = Math.floor(Date.now() / 1000);
    liveChart.setHistoricalData([
      { time: t - 60, open: price, high: price, low: price, close: price, volume: 0 },
      { time: t, open: price, high: price, low: price, close: price, volume: 0 },
    ]);
  }

  liveChart.setMarkers(marketToMarkers(market));
  updateHeader(market);
}

/**
 * Incremental single trade (local buy/sell fill).
 * @param {{ t: number, price: string|bigint|number, thru?: string|bigint|number, side: string }} point
 */
export function pushLiveTradePoint(point) {
  if (!liveChart || !point) return;
  const side = point.side === "sell" ? "sell" : point.side === "buy" ? "buy" : null;
  if (!side) return;
  const price = toHumanPrice(point.price);
  if (!(price > 0)) return;
  const t = Number(point.t || Date.now());
  liveChart.updateTrade({
    timestamp: t < 1e12 ? t * 1000 : t,
    price,
    volume: toHumanThru(point.thru || "0"),
    side,
    id: `${t}-${side}-${point.price}-${point.thru || 0}`,
  });
  // Refresh header from lastPrice if provided
  if (point.price != null) {
    const priceEl = document.querySelector("[data-chart-price]");
    if (priceEl) priceEl.textContent = formatSpotLabel(price);
  }
}

/**
 * @param {string} windowKey
 * @param {any} [market]
 */
export function setLiveChartTimeframe(windowKey, market) {
  liveTimeframe = windowKey in TF_MAP ? windowKey : "5m";
  if (!liveChart) return;
  liveChart.changeTimeframe(TF_MAP[liveTimeframe] || "5m");
  if (market) syncLiveChart(market, { force: true });
  const rangeLabel = document.querySelector("[data-chart-range-label]");
  if (rangeLabel) rangeLabel.textContent = liveTimeframe === "all" ? "ALL" : liveTimeframe;
}

export function destroyLiveChart() {
  if (liveChart) {
    try {
      liveChart.destroy();
    } catch { /* ignore */ }
  }
  liveChart = null;
  lastMarketKey = "";
  lastPointSig = "";
  const host = hostEl();
  if (host) host.innerHTML = "";
}

export function isLiveChartMounted() {
  return Boolean(liveChart);
}

export function getLiveTimeframe() {
  return liveTimeframe;
}
