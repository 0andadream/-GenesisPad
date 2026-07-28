import type { Candle, ChartTheme, ChartTime, Timeframe, Trade } from "./types";

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1s": 1,
  "5s": 5,
  "15s": 15,
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
};

export const TIMEFRAMES: Timeframe[] = [
  "1s",
  "5s",
  "15s",
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
];

/** DexScreener-like dark palette. */
export const DEFAULT_THEME: ChartTheme = {
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
};

export function mergeTheme(partial?: Partial<ChartTheme>): ChartTheme {
  return { ...DEFAULT_THEME, ...partial };
}

/** Normalize trade timestamp to milliseconds. */
export function toMs(ts: number): number {
  // Heuristic: seconds if < year 2100 in seconds scale
  if (ts > 0 && ts < 1e12) return Math.floor(ts * 1000);
  return Math.floor(ts);
}

/** Lightweight Charts UTCTimestamp (seconds). */
export function toChartTime(tsMs: number): ChartTime {
  return Math.floor(tsMs / 1000) as ChartTime;
}

export function floorToInterval(tsMs: number, intervalSec: number): ChartTime {
  const sec = Math.floor(tsMs / 1000);
  return (Math.floor(sec / intervalSec) * intervalSec) as ChartTime;
}

export function isValidCandle(c: Partial<Candle>): c is Candle {
  if (typeof c.time !== "number") return false;
  if (!Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) {
    return false;
  }
  if (!Number.isFinite(c.volume ?? 0)) return false;
  const high = c.high as number;
  const low = c.low as number;
  return high >= low;
}

export function sortCandles(candles: Candle[]): Candle[] {
  return [...candles].sort((a, b) => a.time - b.time);
}

/** Deduplicate by time, keep last. */
export function dedupeCandles(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles) {
    if (!isValidCandle(c)) continue;
    map.set(c.time, c);
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

export function formatPrice(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (abs >= 0.0001) return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return value.toExponential(3);
}

export function formatUsdCompact(value: number | string | null | undefined): string {
  if (value == null || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatTimeLabel(sec: number): string {
  const d = new Date(sec * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function normalizeTrade(trade: Trade): Trade {
  return {
    ...trade,
    timestamp: toMs(trade.timestamp),
    price: Number(trade.price),
    volume: Number(trade.volume) || 0,
    side: trade.side === "sell" ? "sell" : trade.side === "buy" ? "buy" : undefined,
  };
}

export function volumeColor(candle: Candle, theme: ChartTheme): string {
  return candle.close >= candle.open ? theme.upVolume : theme.downVolume;
}

/** Clamp history for extreme cases while keeping tail intact. */
export function clampHistory(candles: Candle[], max = 120_000): Candle[] {
  if (candles.length <= max) return candles;
  return candles.slice(candles.length - max);
}
