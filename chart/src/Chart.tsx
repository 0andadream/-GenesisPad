import React, { useEffect, useMemo } from "react";
import { useChart } from "./useChart";
import { useWebSocket } from "./useWebSocket";
import type {
  Candle,
  ChartOptions,
  MarketStats,
  Timeframe,
  Trade,
  TradeMarker,
} from "./types";
import { formatPct, formatPrice, formatUsdCompact } from "./utils";
import "./Chart.css";

export interface ChartProps extends ChartOptions {
  /** Historical OHLCV seed. */
  historical?: Candle[];
  /** Optional raw trades to rebuild candles on timeframe change. */
  trades?: Trade[];
  /** Live WebSocket URL for trade stream. */
  websocketUrl?: string | null;
  /** Market header stats. */
  marketStats?: MarketStats;
  /** Buy/sell arrow markers. */
  markers?: TradeMarker[];
  /** External className. */
  className?: string;
  /** Controlled timeframe (optional). */
  timeframe?: Timeframe;
  onTrade?: (trade: Trade) => void;
  style?: React.CSSProperties;
}

/**
 * DexScreener-style live trading chart.
 * React shell around a long-lived Lightweight Charts instance.
 */
export function Chart({
  historical,
  trades,
  websocketUrl = null,
  marketStats,
  markers,
  className,
  style,
  timeframe: controlledTf,
  onTrade,
  onTimeframeChange,
  theme,
  showVolume,
  showMarkers,
  autoScroll,
  wsReconnectMs,
  onVisibleRangeChange,
}: ChartProps) {
  const {
    containerRef,
    timeframe,
    setTimeframe,
    tooltip,
    pinned,
    stats,
    setStats,
    setHistoricalData,
    setFromTrades,
    updateTrade,
    setMarkers,
    timeframes,
  } = useChart({
    timeframe: controlledTf ?? "5m",
    theme,
    showVolume,
    showMarkers,
    autoScroll,
    wsReconnectMs,
    onTimeframeChange,
    onVisibleRangeChange,
  });

  const { status: wsStatus } = useWebSocket({
    url: websocketUrl,
    enabled: Boolean(websocketUrl),
    onTrade: (trade) => {
      updateTrade(trade);
      onTrade?.(trade);
    },
  });

  // Seed historical OHLCV
  useEffect(() => {
    if (historical?.length) {
      setHistoricalData(historical);
    }
  }, [historical, setHistoricalData]);

  // Optional trade list rebucket on load / when parent replaces trades
  useEffect(() => {
    if (trades?.length) {
      setFromTrades(trades);
    }
  }, [trades, setFromTrades]);

  useEffect(() => {
    if (marketStats) setStats(marketStats);
  }, [marketStats, setStats]);

  useEffect(() => {
    if (markers) setMarkers(markers);
  }, [markers, setMarkers]);

  useEffect(() => {
    if (controlledTf && controlledTf !== timeframe) {
      setTimeframe(controlledTf);
    }
  }, [controlledTf, timeframe, setTimeframe]);

  const lastPrice = useMemo(() => {
    if (typeof stats.price === "number") return stats.price;
    if (typeof stats.price === "string" && stats.price) return Number(stats.price);
    return null;
  }, [stats.price]);

  const change = stats.changePct;
  const priceUp = change == null ? true : change >= 0;

  return (
    <div className={["dex-live-chart", className].filter(Boolean).join(" ")} style={style}>
      <div className="dex-live-chart__stats" aria-label="Market stats">
        <div className="dex-live-chart__stat">
          <span className="dex-live-chart__stat-label">Market cap</span>
          <span className="dex-live-chart__stat-value">
            {formatUsdCompact(stats.marketCap)}
          </span>
        </div>
        <div className="dex-live-chart__stat">
          <span className="dex-live-chart__stat-label">Liquidity</span>
          <span className="dex-live-chart__stat-value">
            {formatUsdCompact(stats.liquidity)}
          </span>
        </div>
        <div className="dex-live-chart__stat">
          <span className="dex-live-chart__stat-label">Volume</span>
          <span className="dex-live-chart__stat-value">
            {formatUsdCompact(stats.volume)}
          </span>
        </div>
        <div className="dex-live-chart__stat">
          <span className="dex-live-chart__stat-label">Holders</span>
          <span className="dex-live-chart__stat-value">
            {stats.holders == null || stats.holders === ""
              ? "—"
              : Number(stats.holders).toLocaleString()}
          </span>
        </div>
      </div>

      <div className="dex-live-chart__toolbar">
        <div className="dex-live-chart__price-block">
          <p
            className={`dex-live-chart__price ${
              lastPrice == null ? "" : priceUp ? "is-up" : "is-down"
            }`}
          >
            {lastPrice == null ? "—" : formatPrice(lastPrice)}
            {stats.symbol ? (
              <span style={{ fontSize: "0.55em", marginLeft: 8, opacity: 0.7 }}>
                {stats.symbol}
              </span>
            ) : null}
          </p>
          <div className="dex-live-chart__sub">
            <span className={priceUp ? "is-up" : "is-down"}>{formatPct(change)}</span>
            <span className={`dex-live-chart__pin ${pinned ? "is-on" : ""}`}>
              {pinned ? "LIVE" : "PAUSED"}
            </span>
            <span className="dex-live-chart__ws" title={`WebSocket: ${wsStatus}`}>
              <i
                className={`dex-live-chart__ws-dot is-${
                  wsStatus === "open"
                    ? "open"
                    : wsStatus === "connecting"
                      ? "connecting"
                      : wsStatus === "error"
                        ? "error"
                        : ""
                }`}
              />
              {websocketUrl ? wsStatus : "local"}
            </span>
          </div>
        </div>

        <div className="dex-live-chart__intervals" role="tablist" aria-label="Timeframe">
          {timeframes.map((tf) => {
            const active = tf === timeframe;
            return (
              <button
                key={tf}
                type="button"
                role="tab"
                aria-selected={active}
                className={`dex-live-chart__interval${active ? " is-active" : ""}`}
                onClick={() => setTimeframe(tf)}
              >
                {tf}
              </button>
            );
          })}
        </div>
      </div>

      <div className="dex-live-chart__stage">
        <div ref={containerRef as React.RefObject<HTMLDivElement>} className="dex-live-chart__canvas" />
        {tooltip ? (
          <div
            className="dex-live-chart__tooltip"
            style={{
              left: Math.min(tooltip.x, (containerRef.current?.clientWidth ?? 320) - 160),
              top: Math.max(8, tooltip.y - 8),
            }}
          >
            <div className="dex-live-chart__tooltip-time">{tooltip.timeLabel}</div>
            <div className="dex-live-chart__tooltip-row">
              <span>Open</span>
              <span>{formatPrice(tooltip.open)}</span>
            </div>
            <div className="dex-live-chart__tooltip-row">
              <span>High</span>
              <span>{formatPrice(tooltip.high)}</span>
            </div>
            <div className="dex-live-chart__tooltip-row">
              <span>Low</span>
              <span>{formatPrice(tooltip.low)}</span>
            </div>
            <div
              className={`dex-live-chart__tooltip-row ${
                tooltip.close >= tooltip.open ? "is-up" : "is-down"
              }`}
            >
              <span>Close</span>
              <span>{formatPrice(tooltip.close)}</span>
            </div>
            <div className="dex-live-chart__tooltip-row">
              <span>Volume</span>
              <span>{formatPrice(tooltip.volume, 4)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default Chart;
