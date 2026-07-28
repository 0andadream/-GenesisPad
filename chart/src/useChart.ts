import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { CandleBuilder } from "./candleBuilder";
import type {
  Candle,
  ChartOptions,
  ChartTheme,
  MarketStats,
  Timeframe,
  Trade,
  TradeMarker,
} from "./types";
import {
  TIMEFRAMES,
  formatPrice,
  formatTimeLabel,
  mergeTheme,
  volumeColor,
} from "./utils";

export interface OhlcTooltip {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
  timeLabel: string;
  x: number;
  y: number;
}

export interface UseChartResult {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;
  tooltip: OhlcTooltip | null;
  pinned: boolean;
  stats: MarketStats;
  setStats: (s: MarketStats) => void;
  setHistoricalData: (candles: Candle[]) => void;
  updateTrade: (trade: Trade) => void;
  setMarkers: (markers: TradeMarker[]) => void;
  setFromTrades: (trades: Trade[]) => void;
  destroy: () => void;
  timeframes: Timeframe[];
}

type CandleSeries = ISeriesApi<"Candlestick">;
type VolumeSeries = ISeriesApi<"Histogram">;

/**
 * Owns a single Lightweight Charts instance for the component lifetime.
 * Never recreates the chart — only series.update / setData / applyOptions.
 */
export function useChart(options: ChartOptions = {}): UseChartResult {
  const {
    timeframe: initialTf = "5m",
    theme: themePartial,
    showVolume = true,
    showMarkers = true,
    autoScroll = true,
    onTimeframeChange,
  } = options;

  const theme = mergeTheme(themePartial);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<CandleSeries | null>(null);
  const volumeRef = useRef<VolumeSeries | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const builderRef = useRef(new CandleBuilder(initialTf));
  const pinnedRef = useRef(true);
  const autoScrollRef = useRef(autoScroll);
  const showMarkersRef = useRef(showMarkers);
  const themeRef = useRef(theme);
  const markersRef = useRef<TradeMarker[]>([]);
  const rafTick = useRef(0);

  const [timeframe, setTimeframeState] = useState<Timeframe>(initialTf);
  const [tooltip, setTooltip] = useState<OhlcTooltip | null>(null);
  const [pinned, setPinned] = useState(true);
  const [stats, setStats] = useState<MarketStats>({});

  autoScrollRef.current = autoScroll;
  showMarkersRef.current = showMarkers;
  themeRef.current = theme;

  const applyMarkers = useCallback(() => {
    const series = candleRef.current;
    if (!series) return;
    if (!showMarkersRef.current || !markersRef.current.length) {
      series.setMarkers([]);
      return;
    }
    const markers = markersRef.current
      .map((m) => ({
        time: m.time as UTCTimestamp,
        position: (m.side === "buy" ? "belowBar" : "aboveBar") as "belowBar" | "aboveBar",
        color: m.side === "buy" ? themeRef.current.up : themeRef.current.down,
        shape: (m.side === "buy" ? "arrowUp" : "arrowDown") as "arrowUp" | "arrowDown",
        text: m.text ?? (m.side === "buy" ? "B" : "S"),
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(markers);
  }, []);

  const updatePriceLine = useCallback((price: number) => {
    const series = candleRef.current;
    if (!series || !Number.isFinite(price)) return;
    if (priceLineRef.current) {
      series.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
    }
    priceLineRef.current = series.createPriceLine({
      price,
      color: themeRef.current.priceLine,
      lineWidth: 1,
      lineStyle: LineStyle.SparseDotted,
      axisLabelVisible: true,
      title: "",
    });
  }, []);

  const scrollIfPinned = useCallback(() => {
    if (!autoScrollRef.current || !pinnedRef.current) return;
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().scrollToRealTime();
  }, []);

  const pushCandle = useCallback(
    (candle: Candle, isNew: boolean) => {
      const cSeries = candleRef.current;
      const vSeries = volumeRef.current;
      if (!cSeries) return;

      const bar = {
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      };
      // Incremental path — never setData for live ticks
      cSeries.update(bar);
      if (vSeries) {
        vSeries.update({
          time: candle.time as UTCTimestamp,
          value: candle.volume,
          color: volumeColor(candle, themeRef.current),
        });
      }
      updatePriceLine(candle.close);
      if (isNew || pinnedRef.current) scrollIfPinned();
    },
    [scrollIfPinned, updatePriceLine],
  );

  // Create chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el || chartRef.current) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: theme.background },
        textColor: theme.text,
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#21262d",
        },
        horzLine: {
          color: theme.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#21262d",
        },
      },
      rightPriceScale: {
        borderColor: theme.border,
        scaleMargins: { top: 0.08, bottom: showVolume ? 0.28 : 0.06 },
      },
      timeScale: {
        borderColor: theme.border,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 6,
        barSpacing: 8,
        minBarSpacing: 2,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
      kineticScroll: {
        mouse: true,
        touch: true,
      },
      autoSize: true,
    });

    const candles = chart.addCandlestickSeries({
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
      borderVisible: true,
      priceLineVisible: false,
      lastValueVisible: true,
      // Match imperative API: micro bonding-curve prices need tiny minMove.
      priceFormat: {
        type: "custom",
        minMove: 1e-8,
        formatter: (price: number) => {
          if (!Number.isFinite(price) || price === 0) return "0";
          const abs = Math.abs(price);
          if (abs >= 1) return price.toPrecision(6);
          if (abs >= 1e-4) return price.toFixed(8);
          return price.toExponential(4);
        },
      },
    });

    let volume: VolumeSeries | null = null;
    if (showVolume) {
      volume = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
        borderVisible: false,
      });
    }

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;

    // Detect user pan away from realtime edge
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      const bars = builderRef.current.getCandles();
      if (!bars.length) return;
      // If right edge is near last bar, stay pinned
      const lastIndex = bars.length - 1;
      const nearEnd = range.to === null || range.to >= lastIndex - 2;
      if (pinnedRef.current !== nearEnd) {
        pinnedRef.current = nearEnd;
        setPinned(nearEnd);
      }
    });

    chart.subscribeCrosshairMove((param: MouseEventParams<Time>) => {
      if (!param.point || !param.time || !param.seriesData) {
        setTooltip(null);
        return;
      }
      const data = param.seriesData.get(candles) as
        | { open: number; high: number; low: number; close: number; time: number }
        | undefined;
      if (!data) {
        setTooltip(null);
        return;
      }
      const full = builderRef.current
        .getCandles()
        .find((c) => c.time === (data.time as number));
      setTooltip({
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: full?.volume ?? 0,
        time: data.time as number,
        timeLabel: formatTimeLabel(data.time as number),
        x: param.point.x,
        y: param.point.y,
      });
    });

    const unsub = builderRef.current.onUpdate((candle, isNew) => {
      // Coalesce to animation frame for 60fps smoothness under burst trades
      if (rafTick.current) cancelAnimationFrame(rafTick.current);
      rafTick.current = requestAnimationFrame(() => {
        rafTick.current = 0;
        pushCandle(candle, isNew);
      });
    });

    // Keep empty buckets advancing on 1s/5s frames
    const tickTimer = window.setInterval(() => {
      builderRef.current.tick(Date.now());
    }, 500);

    return () => {
      unsub();
      clearInterval(tickTimer);
      if (rafTick.current) cancelAnimationFrame(rafTick.current);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      priceLineRef.current = null;
    };
    // Mount once — theme updates applied via applyOptions below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme hot-update without recreate
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles) return;
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: theme.background },
        textColor: theme.text,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border },
    });
    candles.applyOptions({
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    });
    if (volume) {
      // volume colors applied per-bar
    }
    applyMarkers();
  }, [theme, applyMarkers]);

  const setHistoricalData = useCallback(
    (data: Candle[]) => {
      const cleaned = builderRef.current.setHistorical(data);
      const cSeries = candleRef.current;
      const vSeries = volumeRef.current;
      if (!cSeries) return;
      cSeries.setData(
        cleaned.map((c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      if (vSeries) {
        vSeries.setData(
          cleaned.map((c) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: volumeColor(c, themeRef.current),
          })),
        );
      }
      if (cleaned.length) {
        updatePriceLine(cleaned[cleaned.length - 1].close);
        chartRef.current?.timeScale().fitContent();
        pinnedRef.current = true;
        setPinned(true);
      }
      applyMarkers();
    },
    [applyMarkers, updatePriceLine],
  );

  const setFromTrades = useCallback(
    (trades: Trade[]) => {
      const cleaned = builderRef.current.setFromTrades(trades);
      setHistoricalData(cleaned);
    },
    [setHistoricalData],
  );

  const updateTrade = useCallback((trade: Trade) => {
    builderRef.current.updateTrade(trade);
  }, []);

  const setTimeframe = useCallback(
    (tf: Timeframe) => {
      setTimeframeState(tf);
      onTimeframeChange?.(tf);
      // Rebuild from stored candles converted via trades is not available;
      // re-bucket from last known OHLCV midpoints as synthetic trades is lossy.
      // Prefer parent re-supplying trades; still re-init builder timeframe.
      const prev = [...builderRef.current.getCandles()];
      builderRef.current.setTimeframe(tf);
      // Expand previous candles into synthetic trades at OHLC corners for rebucket
      const synthetic: Trade[] = [];
      for (const c of prev) {
        const base = c.time * 1000;
        const mid = base + 500;
        synthetic.push(
          { timestamp: base, price: c.open, volume: c.volume * 0.25 },
          { timestamp: mid, price: c.high, volume: c.volume * 0.25 },
          { timestamp: mid + 1, price: c.low, volume: c.volume * 0.25 },
          {
            timestamp: base + TIMEFRAME_TO_MS(tf) - 1,
            price: c.close,
            volume: c.volume * 0.25,
          },
        );
      }
      if (synthetic.length) {
        const rebuilt = builderRef.current.setFromTrades(synthetic);
        setHistoricalData(rebuilt);
      } else {
        setHistoricalData([]);
      }
    },
    [onTimeframeChange, setHistoricalData],
  );

  const setMarkers = useCallback(
    (markers: TradeMarker[]) => {
      markersRef.current = markers;
      applyMarkers();
    },
    [applyMarkers],
  );

  const destroy = useCallback(() => {
    chartRef.current?.remove();
    chartRef.current = null;
    candleRef.current = null;
    volumeRef.current = null;
    priceLineRef.current = null;
    builderRef.current.clear();
  }, []);

  return {
    containerRef,
    timeframe,
    setTimeframe,
    tooltip,
    pinned,
    stats,
    setStats,
    setHistoricalData,
    updateTrade,
    setMarkers,
    setFromTrades,
    destroy,
    timeframes: TIMEFRAMES,
  };
}

function TIMEFRAME_TO_MS(tf: Timeframe): number {
  const map: Record<Timeframe, number> = {
    "1s": 1000,
    "5s": 5000,
    "15s": 15_000,
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
  };
  return map[tf];
}

export { formatPrice };
