import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { CandleBuilder, normalizeHistorical } from "./candleBuilder";
import { TradeWebSocket, type WsStatus } from "./useWebSocket";
import type {
  Candle,
  ChartController,
  ChartOptions,
  ChartTheme,
  MarketStats,
  Timeframe,
  Trade,
  TradeMarker,
} from "./types";
import {
  TIMEFRAME_SECONDS,
  mergeTheme,
  volumeColor,
} from "./utils";

type CandleSeries = ISeriesApi<"Candlestick">;
type VolumeSeries = ISeriesApi<"Histogram">;

/**
 * Imperative DexScreener-style chart controller.
 *
 * ```ts
 * const chart = createDexChart();
 * chart.initializeChart(container);
 * chart.setHistoricalData(candles);
 * chart.connectWebSocket(url);
 * chart.updateTrade(trade);
 * chart.changeTimeframe("1m");
 * chart.destroy();
 * ```
 */
export class DexChart implements ChartController {
  private chart: IChartApi | null = null;
  private candles: CandleSeries | null = null;
  private volume: VolumeSeries | null = null;
  private priceLine: IPriceLine | null = null;
  private container: HTMLElement | null = null;
  private builder = new CandleBuilder("5m");
  private ws: TradeWebSocket;
  private theme: ChartTheme;
  private showVolume: boolean;
  private showMarkers: boolean;
  private autoScroll: boolean;
  private pinned = true;
  private markers: TradeMarker[] = [];
  private ro: ResizeObserver | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private raf = 0;
  private opts: ChartOptions;

  constructor(options: ChartOptions = {}) {
    this.opts = options;
    this.theme = mergeTheme(options.theme);
    this.showVolume = options.showVolume !== false;
    this.showMarkers = options.showMarkers !== false;
    this.autoScroll = options.autoScroll !== false;
    if (options.timeframe) {
      this.builder = new CandleBuilder(options.timeframe);
    }

    this.ws = new TradeWebSocket({
      reconnectMs: options.wsReconnectMs ?? 800,
    });
    this.ws.onTrade = (trade) => this.updateTrade(trade);
  }

  initializeChart(container: HTMLElement): void {
    if (this.chart) {
      // Already initialized — move to new container if needed
      if (this.container !== container) {
        this.destroy();
      } else {
        return;
      }
    }
    this.container = container;
    const theme = this.theme;

    const chart = createChart(container, {
      width: container.clientWidth || 640,
      height: container.clientHeight || 420,
      layout: {
        background: { type: ColorType.Solid, color: theme.background },
        textColor: theme.text,
        fontSize: 11,
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: theme.crosshair,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#21262d",
        },
        horzLine: {
          color: theme.crosshair,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#21262d",
        },
      },
      rightPriceScale: {
        borderColor: theme.border,
        scaleMargins: { top: 0.08, bottom: this.showVolume ? 0.28 : 0.06 },
      },
      timeScale: {
        borderColor: theme.border,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 6,
        barSpacing: 8,
        minBarSpacing: 2,
      },
      handleScroll: true,
      handleScale: true,
      kineticScroll: { mouse: true, touch: true },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
      priceLineVisible: false,
      lastValueVisible: true,
    });

    let volumeSeries: VolumeSeries | null = null;
    if (this.showVolume) {
      volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      });
    }

    this.chart = chart;
    this.candles = candleSeries;
    this.volume = volumeSeries;

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      const n = this.builder.getCandles().length;
      if (!n) return;
      const nearEnd = range.to === null || range.to >= n - 2;
      this.pinned = nearEnd;
    });

    this.builder.onUpdate((candle, isNew) => {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.applyCandle(candle, isNew);
      });
    });

    this.ro = new ResizeObserver(() => {
      if (!this.chart || !this.container) return;
      this.chart.applyOptions({
        width: this.container.clientWidth,
        height: this.container.clientHeight,
      });
    });
    this.ro.observe(container);

    this.tickTimer = setInterval(() => this.builder.tick(), 500);
  }

  setHistoricalData(candles: Candle[]): void {
    const cleaned = this.builder.setHistorical(normalizeHistorical(candles));
    this.paintAll(cleaned);
  }

  connectWebSocket(url: string): void {
    this.ws.connect(url);
  }

  disconnectWebSocket(): void {
    this.ws.disconnect();
  }

  onWsStatus(cb: (s: WsStatus) => void): void {
    this.ws.onStatus = cb;
  }

  updateTrade(trade: Trade): void {
    this.builder.updateTrade(trade);
  }

  changeTimeframe(interval: Timeframe): void {
    const prev = [...this.builder.getCandles()];
    this.builder.setTimeframe(interval);
    this.opts.onTimeframeChange?.(interval);
    // Re-bucket via synthetic trades from prior OHLC (lossy but keeps continuity)
    const intervalMs = TIMEFRAME_SECONDS[interval] * 1000;
    const synthetic: Trade[] = [];
    for (const c of prev) {
      const base = c.time * 1000;
      synthetic.push(
        { timestamp: base, price: c.open, volume: c.volume * 0.25 },
        { timestamp: base + intervalMs * 0.33, price: c.high, volume: c.volume * 0.25 },
        { timestamp: base + intervalMs * 0.66, price: c.low, volume: c.volume * 0.25 },
        { timestamp: base + intervalMs - 1, price: c.close, volume: c.volume * 0.25 },
      );
    }
    const rebuilt = synthetic.length
      ? this.builder.setFromTrades(synthetic)
      : [];
    this.paintAll(rebuilt);
  }

  setMarketStats(_stats: MarketStats): void {
    // Imperative shell does not own DOM stats — React Chart handles that.
    // Kept for API parity / external HUD binding.
  }

  setMarkers(markers: TradeMarker[]): void {
    this.markers = markers;
    this.paintMarkers();
  }

  getTimeframe(): Timeframe {
    return this.builder.getTimeframe();
  }

  isPinnedToLatest(): boolean {
    return this.pinned;
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.ro?.disconnect();
    this.ws.disconnect();
    this.chart?.remove();
    this.chart = null;
    this.candles = null;
    this.volume = null;
    this.priceLine = null;
    this.container = null;
    this.builder.clear();
  }

  private paintAll(data: Candle[]): void {
    if (!this.candles) return;
    this.candles.setData(
      data.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    if (this.volume) {
      this.volume.setData(
        data.map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: volumeColor(c, this.theme),
        })),
      );
    }
    if (data.length) {
      this.setPriceLine(data[data.length - 1].close);
      this.chart?.timeScale().fitContent();
      this.pinned = true;
    }
    this.paintMarkers();
  }

  private applyCandle(candle: Candle, isNew: boolean): void {
    if (!this.candles) return;
    this.candles.update({
      time: candle.time as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    });
    this.volume?.update({
      time: candle.time as UTCTimestamp,
      value: candle.volume,
      color: volumeColor(candle, this.theme),
    });
    this.setPriceLine(candle.close);
    if ((isNew || this.pinned) && this.autoScroll) {
      this.chart?.timeScale().scrollToRealTime();
    }
  }

  private setPriceLine(price: number): void {
    if (!this.candles || !Number.isFinite(price)) return;
    if (this.priceLine) {
      this.candles.removePriceLine(this.priceLine);
      this.priceLine = null;
    }
    this.priceLine = this.candles.createPriceLine({
      price,
      color: this.theme.priceLine,
      lineWidth: 1,
      lineStyle: LineStyle.SparseDotted,
      axisLabelVisible: true,
      title: "",
    });
  }

  private paintMarkers(): void {
    if (!this.candles) return;
    if (!this.showMarkers || !this.markers.length) {
      this.candles.setMarkers([]);
      return;
    }
    this.candles.setMarkers(
      this.markers
        .map((m) => ({
          time: m.time as UTCTimestamp,
          position: (m.side === "buy" ? "belowBar" : "aboveBar") as
            | "belowBar"
            | "aboveBar",
          color: m.side === "buy" ? this.theme.up : this.theme.down,
          shape: (m.side === "buy" ? "arrowUp" : "arrowDown") as
            | "arrowUp"
            | "arrowDown",
          text: m.text ?? (m.side === "buy" ? "B" : "S"),
        }))
        .sort((a, b) => (a.time as number) - (b.time as number)),
    );
  }
}

/** Factory matching the requested simple API surface. */
export function createDexChart(options?: ChartOptions): ChartController & DexChart {
  return new DexChart(options);
}

// Functional aliases for the requested API names
export function initializeChart(
  container: HTMLElement,
  options?: ChartOptions,
): ChartController & DexChart {
  const c = createDexChart(options);
  c.initializeChart(container);
  return c;
}
