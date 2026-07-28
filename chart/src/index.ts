/**
 * DexScreener-style live chart powered by TradingView Lightweight Charts.
 *
 * React:
 *   import { Chart } from "./chart";
 *
 * Imperative:
 *   import { createDexChart } from "./chart";
 *   const chart = createDexChart();
 *   chart.initializeChart(el);
 *   chart.setHistoricalData(candles);
 *   chart.connectWebSocket(url);
 *   chart.updateTrade(trade);
 *   chart.changeTimeframe("1m");
 *   chart.destroy();
 */

export { Chart } from "./Chart";
export type { ChartProps } from "./Chart";

export { useChart } from "./useChart";
export type { OhlcTooltip, UseChartResult } from "./useChart";

export { useWebSocket, TradeWebSocket } from "./useWebSocket";
export type {
  TradeMessageParser,
  UseWebSocketOptions,
  WsStatus,
} from "./useWebSocket";

export {
  CandleBuilder,
  tradesToCandles,
  normalizeHistorical,
  tradeFromPartial,
} from "./candleBuilder";

export {
  createDexChart,
  initializeChart,
  DexChart,
} from "./api";

export type {
  Candle,
  ChartController,
  ChartOptions,
  ChartTheme,
  ChartTime,
  MarketStats,
  Timeframe,
  Trade,
  TradeMarker,
} from "./types";

export {
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  DEFAULT_THEME,
  formatPrice,
  formatUsdCompact,
  formatPct,
  formatTimeLabel,
  mergeTheme,
  normalizeTrade,
  toChartTime,
  toMs,
} from "./utils";
