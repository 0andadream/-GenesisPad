/** UTCTimestamp in seconds (Lightweight Charts format). */
export type ChartTime = number;

export type Timeframe =
  | "1s"
  | "5s"
  | "15s"
  | "1m"
  | "5m"
  | "15m"
  | "1h"
  | "4h";

export interface Trade {
  /** Unix ms or seconds — builder normalizes to ms. */
  timestamp: number;
  price: number;
  volume: number;
  side?: "buy" | "sell";
  /** Optional unique id for dedupe. */
  id?: string;
}

export interface Candle {
  time: ChartTime;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketStats {
  marketCap?: number | string | null;
  liquidity?: number | string | null;
  volume?: number | string | null;
  holders?: number | string | null;
  price?: number | string | null;
  changePct?: number | null;
  symbol?: string;
  name?: string;
}

export interface TradeMarker {
  time: ChartTime;
  side: "buy" | "sell";
  price?: number;
  text?: string;
}

export interface ChartTheme {
  background: string;
  text: string;
  grid: string;
  border: string;
  up: string;
  down: string;
  upVolume: string;
  downVolume: string;
  crosshair: string;
  priceLine: string;
}

export interface ChartOptions {
  /** Default timeframe. */
  timeframe?: Timeframe;
  /** Dark theme colors (DexScreener-like). */
  theme?: Partial<ChartTheme>;
  /** Show volume histogram. */
  showVolume?: boolean;
  /** Show buy/sell arrow markers. */
  showMarkers?: boolean;
  /** Auto-scroll when pinned to latest. */
  autoScroll?: boolean;
  /** WebSocket reconnect base delay ms. */
  wsReconnectMs?: number;
  /** Called when timeframe changes. */
  onTimeframeChange?: (tf: Timeframe) => void;
  /** Called when stats need refresh (optional). */
  onVisibleRangeChange?: (from: ChartTime, to: ChartTime) => void;
}

export interface ChartController {
  initializeChart(container: HTMLElement): void;
  setHistoricalData(candles: Candle[]): void;
  connectWebSocket(url: string): void;
  disconnectWebSocket(): void;
  updateTrade(trade: Trade): void;
  changeTimeframe(interval: Timeframe): void;
  setMarketStats(stats: MarketStats): void;
  setMarkers(markers: TradeMarker[]): void;
  destroy(): void;
  /** Underlying series for advanced use. */
  getTimeframe(): Timeframe;
  isPinnedToLatest(): boolean;
}

export type CandleUpdateListener = (candle: Candle, isNew: boolean) => void;
