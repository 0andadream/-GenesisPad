import type { Candle, CandleUpdateListener, Timeframe, Trade } from "./types";
import {
  TIMEFRAME_SECONDS,
  clampHistory,
  dedupeCandles,
  floorToInterval,
  isValidCandle,
  normalizeTrade,
  sortCandles,
  toChartTime,
  toMs,
} from "./utils";

/**
 * Incremental OHLCV candle builder.
 * Never rebuilds the full series on each trade — mutates the current bucket
 * and emits a single update for Lightweight Charts `series.update()`.
 */
export class CandleBuilder {
  private timeframe: Timeframe;
  private intervalSec: number;
  private candles: Candle[] = [];
  private current: Candle | null = null;
  private listeners = new Set<CandleUpdateListener>();
  private seenTradeIds = new Set<string>();
  private maxCandles: number;

  constructor(timeframe: Timeframe = "5m", maxCandles = 120_000) {
    this.timeframe = timeframe;
    this.intervalSec = TIMEFRAME_SECONDS[timeframe];
    this.maxCandles = maxCandles;
  }

  getTimeframe(): Timeframe {
    return this.timeframe;
  }

  getCandles(): readonly Candle[] {
    return this.candles;
  }

  getCurrent(): Candle | null {
    return this.current;
  }

  onUpdate(listener: CandleUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(candle: Candle, isNew: boolean): void {
    for (const fn of this.listeners) {
      try {
        fn(candle, isNew);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  setTimeframe(timeframe: Timeframe, trades?: Trade[]): Candle[] {
    this.timeframe = timeframe;
    this.intervalSec = TIMEFRAME_SECONDS[timeframe];
    this.current = null;
    this.candles = [];
    this.seenTradeIds.clear();
    if (trades?.length) {
      return this.setFromTrades(trades);
    }
    return [];
  }

  /** Replace history with pre-built OHLCV (historical load). */
  setHistorical(candles: Candle[]): Candle[] {
    const cleaned = clampHistory(
      dedupeCandles(candles.filter(isValidCandle)),
      this.maxCandles,
    );
    this.candles = cleaned;
    this.current = cleaned.length ? { ...cleaned[cleaned.length - 1] } : null;
    this.seenTradeIds.clear();
    return this.candles;
  }

  /** Rebuild from raw trades for a timeframe switch. */
  setFromTrades(trades: Trade[]): Candle[] {
    const sorted = [...trades]
      .map(normalizeTrade)
      .filter((t) => Number.isFinite(t.price) && t.price > 0 && t.timestamp > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    const map = new Map<number, Candle>();
    for (const trade of sorted) {
      if (trade.id) this.seenTradeIds.add(trade.id);
      const bucket = floorToInterval(trade.timestamp, this.intervalSec);
      const existing = map.get(bucket);
      if (!existing) {
        map.set(bucket, {
          time: bucket,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volume: trade.volume,
        });
      } else {
        existing.high = Math.max(existing.high, trade.price);
        existing.low = Math.min(existing.low, trade.price);
        existing.close = trade.price;
        existing.volume += trade.volume;
      }
    }

    this.candles = clampHistory(sortCandles([...map.values()]), this.maxCandles);
    this.current = this.candles.length
      ? { ...this.candles[this.candles.length - 1] }
      : null;
    return this.candles;
  }

  /**
   * Apply a live trade. Returns the updated candle + whether a new bucket opened.
   * Uses O(1) update path for the active candle.
   */
  updateTrade(raw: Trade): { candle: Candle; isNew: boolean } | null {
    const trade = normalizeTrade(raw);
    if (!Number.isFinite(trade.price) || trade.price <= 0 || trade.timestamp <= 0) {
      return null;
    }
    if (trade.id) {
      if (this.seenTradeIds.has(trade.id)) return null;
      this.seenTradeIds.add(trade.id);
      // Bound id set growth
      if (this.seenTradeIds.size > 50_000) {
        const keep = [...this.seenTradeIds].slice(-20_000);
        this.seenTradeIds = new Set(keep);
      }
    }

    const bucket = floorToInterval(trade.timestamp, this.intervalSec);

    // Out-of-order trade into a sealed past candle — patch if found.
    if (this.current && bucket < this.current.time) {
      const idx = this.findCandleIndex(bucket);
      if (idx < 0) return null;
      const c = this.candles[idx];
      c.high = Math.max(c.high, trade.price);
      c.low = Math.min(c.low, trade.price);
      // Don't rewrite open; close of past candle stays as historical end.
      c.volume += trade.volume;
      this.emit({ ...c }, false);
      return { candle: { ...c }, isNew: false };
    }

    if (!this.current || bucket > this.current.time) {
      // Seal previous into array (already there); open new candle.
      const next: Candle = {
        time: bucket,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.volume,
      };
      this.current = next;
      this.candles.push(next);
      if (this.candles.length > this.maxCandles) {
        this.candles = this.candles.slice(this.candles.length - this.maxCandles);
      }
      this.emit({ ...next }, true);
      return { candle: { ...next }, isNew: true };
    }

    // Same bucket — mutate current candle in place.
    const c = this.current;
    c.high = Math.max(c.high, trade.price);
    c.low = Math.min(c.low, trade.price);
    c.close = trade.price;
    c.volume += trade.volume;
    // Mirror into array tail
    const last = this.candles[this.candles.length - 1];
    if (last && last.time === c.time) {
      last.high = c.high;
      last.low = c.low;
      last.close = c.close;
      last.volume = c.volume;
    }
    this.emit({ ...c }, false);
    return { candle: { ...c }, isNew: false };
  }

  private findCandleIndex(time: ChartTimeLike): number {
    // Binary search
    let lo = 0;
    let hi = this.candles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.candles[mid].time;
      if (t === time) return mid;
      if (t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Ensure an empty live bucket exists at `now` (keeps chart advancing). */
  tick(nowMs = Date.now()): { candle: Candle; isNew: boolean } | null {
    if (!this.current) return null;
    const bucket = floorToInterval(nowMs, this.intervalSec);
    if (bucket <= this.current.time) return null;
    const next: Candle = {
      time: bucket,
      open: this.current.close,
      high: this.current.close,
      low: this.current.close,
      close: this.current.close,
      volume: 0,
    };
    this.current = next;
    this.candles.push(next);
    if (this.candles.length > this.maxCandles) {
      this.candles = this.candles.slice(this.candles.length - this.maxCandles);
    }
    this.emit({ ...next }, true);
    return { candle: { ...next }, isNew: true };
  }

  clear(): void {
    this.candles = [];
    this.current = null;
    this.seenTradeIds.clear();
  }
}

type ChartTimeLike = number;

/** Pure helper: trades → candles for a timeframe (one-shot). */
export function tradesToCandles(trades: Trade[], timeframe: Timeframe): Candle[] {
  const builder = new CandleBuilder(timeframe);
  return builder.setFromTrades(trades);
}

/** Convert historical candles from various shapes. */
export function normalizeHistorical(
  rows: Array<Partial<Candle> & { time?: number | string }>,
): Candle[] {
  const out: Candle[] = [];
  for (const r of rows) {
    const timeRaw = typeof r.time === "string" ? Number(r.time) : r.time;
    if (timeRaw == null || !Number.isFinite(timeRaw)) continue;
    const time = timeRaw > 1e12 ? toChartTime(timeRaw) : Math.floor(timeRaw);
    const candle: Candle = {
      time,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume) || 0,
    };
    if (isValidCandle(candle)) out.push(candle);
  }
  return dedupeCandles(out);
}

export function tradeFromPartial(p: {
  t?: number;
  timestamp?: number;
  price: number | string;
  volume?: number | string;
  thru?: number | string;
  side?: string;
  id?: string;
}): Trade {
  return {
    timestamp: toMs(Number(p.timestamp ?? p.t ?? Date.now())),
    price: Number(p.price),
    volume: Number(p.volume ?? p.thru ?? 0),
    side: p.side === "sell" ? "sell" : p.side === "buy" ? "buy" : undefined,
    id: p.id,
  };
}
