/**
 * Bridge: Genesis trade modal ↔ DexScreener Lightweight Charts controller.
 * Vanilla JS — no React mount required.
 */
import { createDexChart } from "../chart/src/api.ts";

const THRU_DECIMALS = 9;
/** Must match app.js PRICE_PRICE_EXTRA — chart prices are scaled fixed-point. */
const PRICE_EXTRA = 12;
const PRICE_DECIMALS = THRU_DECIMALS + PRICE_EXTRA; // 21

/** @type {import("../chart/src/api").DexChart | null} */
let liveChart = null;
let lastMarketKey = "";
let lastPointSig = "";
/** @type {string} */
let liveTimeframe = "15s";

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

/**
 * Decode fixed-point price integer → JS number (real THRU/token).
 * Storage is 21dp (9 THRU + 12 extra). Legacy 9dp seeds that survived
 * truncation are near-zero when read as 21dp — treat those as empty.
 */
function toHumanPrice(priceBase) {
  try {
    const raw = typeof priceBase === "bigint" ? priceBase : BigInt(String(priceBase || "0"));
    if (raw <= 0n) return 0;
    // Prefer 21-decimal fixed point (current storage).
    const scale21 = 10n ** BigInt(PRICE_DECIMALS);
    const whole21 = raw / scale21;
    const frac21 = (raw % scale21).toString().padStart(PRICE_DECIMALS, "0");
    const as21 = Number(`${whole21}.${frac21}`);
    if (Number.isFinite(as21) && as21 > 0) return as21;
    // Legacy: unscaled 9dp integer that didn't truncate to 0.
    const scale9 = 10n ** BigInt(THRU_DECIMALS);
    const whole9 = raw / scale9;
    const frac9 = (raw % scale9).toString().padStart(THRU_DECIMALS, "0");
    const as9 = Number(`${whole9}.${frac9}`);
    return Number.isFinite(as9) && as9 > 0 ? as9 : 0;
  } catch {
    const n = Number(priceBase);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
}

/** THRU volume in whole THRU (9 decimals). */
function toHumanThru(thruBase) {
  try {
    const raw = typeof thruBase === "bigint" ? thruBase : BigInt(String(thruBase || "0"));
    if (raw <= 0n) return 0;
    const scale = 10n ** BigInt(THRU_DECIMALS);
    const whole = raw / scale;
    const frac = (raw % scale).toString().padStart(THRU_DECIMALS, "0");
    const n = Number(`${whole}.${frac}`);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * One candle per trade print. open = previous close so buys paint green
 * and sells paint red. When side and move disagree (float noise / flat
 * fill), nudge open so body color matches the trade side.
 * @param {any} market
 */
function marketToCandles(market) {
  const points = Array.isArray(market?.chart) ? market.chart : [];
  const prints = [];
  for (const p of points) {
    if (!p) continue;
    if (p.side !== "buy" && p.side !== "sell" && p.side !== "seed") continue;
    const price = toHumanPrice(p.price);
    if (!(price > 0)) continue;
    let t = Number(p.t || p.ts || p.at || 0);
    if (!(t > 0)) continue;
    if (t > 1e12) t = Math.floor(t / 1000); // ms → sec
    prints.push({
      t,
      price,
      volume: toHumanThru(p.thru || "0"),
      side: p.side,
    });
  }
  prints.sort((a, b) => a.t - b.t || (a.side === "buy" ? -1 : 1));

  // Ensure unique ascending times (LW Charts requirement)
  const candles = [];
  let prevClose = 0;
  let lastT = 0;
  for (const p of prints) {
    let time = p.t;
    if (time <= lastT) time = lastT + 1;
    lastT = time;
    let open = prevClose > 0 ? prevClose : p.price;
    let close = p.price;
    // Force body direction from trade side so sells are always red.
    // Min body = 0.15% of price so micro moves still show a filled candle.
    const minBody = Math.max(close * 0.0015, close * 1e-9, 1e-24);
    if (p.side === "sell") {
      if (close >= open) open = close + minBody;
    } else if (p.side === "buy") {
      if (close <= open) open = Math.max(close - minBody, close * 0.5);
    } else if (Math.abs(close - open) < minBody * 0.25) {
      // seed / flat: small neutral wick only
      open = close;
    }
    const high = Math.max(open, close);
    const low = Math.min(open, close);
    // Short wicks — candle bodies stay blocky (horizontal width comes from barSpacing).
    const pad = Math.max((high - low) * 0.12, close * 2e-4, 1e-24);
    candles.push({
      time,
      open,
      high: high + pad,
      low: Math.max(0, low - pad),
      close,
      volume: p.volume > 0 ? p.volume : Math.abs(close - open) || pad,
    });
    prevClose = close;
  }

  // Live tip candle from current spot
  try {
    let spot = market?.lastPrice ? toHumanPrice(market.lastPrice) : 0;
    if (!(spot > 0) && market?.curve) {
      // lastPrice may be legacy 0 — leave tip off
      spot = 0;
    }
    if (spot > 0 && candles.length) {
      const last = candles[candles.length - 1];
      let time = Math.floor(Date.now() / 1000);
      if (time <= last.time) time = last.time + 1;
      const open = last.close;
      const close = spot;
      const high = Math.max(open, close);
      const low = Math.min(open, close);
      const pad = Math.max(Math.abs(close - open) * 0.05, close * 1e-6, 1e-24);
      candles.push({
        time,
        open,
        high: high + pad,
        low: Math.max(0, low - pad),
        close,
        volume: Math.abs(close - open) || pad,
      });
    } else if (spot > 0 && !candles.length) {
      const time = Math.floor(Date.now() / 1000);
      const pad = Math.max(spot * 0.01, spot * 1e-6, 1e-24);
      // Seed green then red so the pane shows both colors + range
      candles.push(
        { time: time - 3, open: spot, high: spot + pad, low: spot - pad * 0.5, close: spot, volume: pad },
        { time: time - 2, open: spot, high: spot + pad * 2, low: spot, close: spot + pad, volume: pad },
        { time: time - 1, open: spot + pad, high: spot + pad, low: spot - pad, close: spot - pad * 0.5, volume: pad },
        { time, open: spot - pad * 0.5, high: spot + pad * 0.25, low: spot - pad, close: spot, volume: pad },
      );
    }
  } catch { /* ignore */ }

  return candles;
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

/**
 * Convert a real THRU/token float into readable price units.
 * 6.25e-11 → { units: 6.25, exp: -11 }  (1 unit = 10^exp THRU)
 */
function toPriceUnits(real) {
  if (!(real > 0) || !Number.isFinite(real)) return { units: 0, exp: 0, scale: 1 };
  const exp = Math.floor(Math.log10(real));
  const scale = 10 ** -exp;
  const units = real * scale;
  return {
    units: Number.isFinite(units) ? units : 0,
    exp,
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

function formatExp(exp) {
  if (exp === 0) return "1";
  const abs = Math.abs(exp);
  const sup = String(abs).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]);
  return exp < 0 ? `10⁻${sup}` : `10${sup}`;
}

/** Big header price: unit number + unit scale (readable, matches chart axis). */
function formatSpotLabel(n) {
  if (!(n > 0)) return "—";
  const { units, exp } = toPriceUnits(n);
  if (!(units > 0)) return "—";
  if (exp === 0) return `${units.toFixed(4)} THRU`;
  return `${units.toFixed(4)} unit`;
}

function formatUnitScaleNote(n) {
  if (!(n > 0)) return "Price units · live";
  const { exp } = toPriceUnits(n);
  if (exp === 0) return "OHLC · THRU per token · live";
  return `OHLC · 1 unit = ${formatExp(exp)} THRU · side scale = units`;
}

function updateHeader(market) {
  const priceEl = document.querySelector("[data-chart-price]");
  const changeEl = document.querySelector("[data-chart-change]");
  const changeVal = document.querySelector("[data-chart-change-value]");
  const rangeLabel = document.querySelector("[data-chart-range-label]");
  const tradesEl = document.querySelector("[data-chart-trades]");
  const rangeEl = document.querySelector("[data-chart-range]");

  const candles = marketToCandles(market);
  const spot = candles.length ? candles[candles.length - 1].close : 0;
  const open = candles.length ? candles[0].open : spot;

  if (priceEl && spot > 0) {
    const prev = priceEl.textContent;
    priceEl.textContent = formatSpotLabel(spot);
    if (prev && prev !== priceEl.textContent) {
      priceEl.classList.remove("price-flash");
      void priceEl.offsetWidth;
      priceEl.classList.add("price-flash");
    }
  }

  let pctText = "0.00%";
  let up = true;
  if (open > 0 && spot > 0 && spot !== open) {
    up = spot >= open;
    const pct = ((spot - open) / open) * 100;
    pctText = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }
  if (changeVal) changeVal.textContent = pctText;
  if (changeEl) {
    changeEl.classList.toggle("up", up && spot !== open);
    changeEl.classList.toggle("down", !up && spot !== open);
    changeEl.classList.toggle("is-up", up && spot !== open);
    changeEl.classList.toggle("is-down", !up && spot !== open);
  }
  if (rangeLabel) rangeLabel.textContent = liveTimeframe === "all" ? "ALL" : liveTimeframe;
  const pts = Array.isArray(market?.chart) ? market.chart : [];
  if (tradesEl) {
    const buys = pts.filter((p) => p?.side === "buy").length;
    const sells = pts.filter((p) => p?.side === "sell").length;
    const n = buys + sells;
    tradesEl.textContent = n
      ? `${n} trade${n === 1 ? "" : "s"} · ${buys}B / ${sells}S`
      : "No trades yet";
  }
  if (rangeEl) rangeEl.textContent = formatUnitScaleNote(spot);
}

/**
 * Mount Lightweight Charts into the trade modal host.
 * @param {any} market
 * @param {string} [timeframe]
 */
export function mountLiveChart(market, timeframe = "15s") {
  const host = hostEl();
  if (!host) return null;
  liveTimeframe = timeframe in TF_MAP ? timeframe : "15s";

  if (!liveChart) {
    liveChart = createDexChart({
      timeframe: TF_MAP[liveTimeframe] || "15s",
      showVolume: true,
      showMarkers: false,
      autoScroll: true,
      theme: {
        background: "#0d1117",
        text: "#8b949e",
        grid: "rgba(48, 54, 61, 0.55)",
        border: "#21262d",
        up: "#26a69a",
        down: "#ef5350",
        upVolume: "rgba(38, 166, 154, 0.55)",
        downVolume: "rgba(239, 83, 80, 0.55)",
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

  const candles = marketToCandles(market);
  if (candles.length) {
    liveChart.setHistoricalData(candles);
  }
  liveChart.setMarkers([]);
  updateHeader(market);
}

/**
 * Incremental single trade (local buy/sell fill).
 * Builds a proper green/red candle vs previous close.
 * @param {{ t: number, price: string|bigint|number, thru?: string|bigint|number, side: string }} point
 */
export function pushLiveTradePoint(point) {
  if (!liveChart || !point) return;
  const side = point.side === "sell" ? "sell" : point.side === "buy" ? "buy" : null;
  if (!side) return;
  const price = toHumanPrice(point.price);
  if (!(price > 0)) return;
  let t = Number(point.t || Date.now());
  if (t > 1e12) t = Math.floor(t / 1000);
  // Use updateTrade so OHLC builder can form red/green vs prior bucket.
  // Force unique second so consecutive trades don't merge flat.
  liveChart.updateTrade({
    timestamp: t * 1000 + (side === "sell" ? 1 : 0),
    price,
    volume: toHumanThru(point.thru || "0") || Math.abs(price) * 1e-6,
    side,
    id: `${t}-${side}-${point.price}-${point.thru || 0}-${Math.random().toString(36).slice(2, 6)}`,
  });
  const priceEl = document.querySelector("[data-chart-price]");
  if (priceEl) priceEl.textContent = formatSpotLabel(price);
}

/**
 * @param {string} windowKey
 * @param {any} [market]
 */
export function setLiveChartTimeframe(windowKey, market) {
  liveTimeframe = windowKey in TF_MAP ? windowKey : "15s";
  if (!liveChart) return;
  // Rebuild from full market prints (not lossy OHLC rebucket)
  if (market) {
    liveChart.changeTimeframe(TF_MAP[liveTimeframe] || "15s");
    syncLiveChart(market, { force: true });
  } else {
    liveChart.changeTimeframe(TF_MAP[liveTimeframe] || "15s");
  }
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
