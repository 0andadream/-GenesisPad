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
import { TradeWebSocket, type WsStatus } from "./tradeSocket";
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
  /**
   * Multiply real THRU prices into comfortable "units" (~1..10).
   * Bonding-curve spots are often 1e-12..1e-6; LW Charts default minMove
   * 0.01 would round those to 0. Axis shows unit numbers (side scale);
   * real THRU = unit × 10^displayExp.
   */
  private displayScale = 1;
  private displayExp = 0;

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
        scaleMargins: { top: 0.1, bottom: this.showVolume ? 0.28 : 0.08 },
        entireTextOnly: false,
        visible: true,
        borderVisible: true,
        minimumWidth: 72,
      },
      timeScale: {
        borderColor: theme.border,
        timeVisible: true,
        secondsVisible: true,
        // Wide bars so candles read as horizontal blocks, not thin vertical sticks.
        rightOffset: 10,
        barSpacing: 22,
        minBarSpacing: 10,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: true,
      handleScale: true,
      kineticScroll: { mouse: true, touch: true },
    });

    // Prices are display-scaled into ~1..10 "units". Axis shows those unit
    // numbers (readable side labels). Real THRU = unit × 10^exp.
    const unitPriceFormat = {
      type: "custom" as const,
      minMove: 0.0001,
      formatter: (price: number) => this.formatUnitAxis(price),
    };

    const candleSeries = chart.addCandlestickSeries({
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
      borderVisible: true,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: unitPriceFormat,
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

    // Autoscale so candle bodies fill the pane
    chart.priceScale("right").applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.12, bottom: this.showVolume ? 0.28 : 0.08 },
      entireTextOnly: false,
    });

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

    // Do NOT auto-open empty flat buckets every interval — that paints
    // rows of doji candles and makes the chart look "stuck flat".
    this.tickTimer = null;
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

  /**
   * Pick a scale so the latest price sits near 1..10 units.
   * ref = 6.25e-11 → exp = -11 → scale = 1e11 → unit ≈ 6.25
   */
  private recomputeDisplayScale(data: Candle[]): void {
    let ref = 0;
    for (let i = data.length - 1; i >= 0; i--) {
      const c = data[i];
      if (c && c.close > 0 && Number.isFinite(c.close)) {
        ref = c.close;
        break;
      }
    }
    if (!(ref > 0)) {
      this.displayScale = 1;
      this.displayExp = 0;
      return;
    }
    const exp = Math.floor(Math.log10(ref));
    const scale = 10 ** -exp;
    this.displayExp = exp;
    this.displayScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  /** Right-axis labels: plain unit numbers (e.g. 6.2500). */
  private formatUnitAxis(displayPrice: number): string {
    if (!Number.isFinite(displayPrice) || displayPrice === 0) return "0";
    const abs = Math.abs(displayPrice);
    if (abs >= 100) return displayPrice.toFixed(2);
    if (abs >= 1) return displayPrice.toFixed(4);
    if (abs >= 0.01) return displayPrice.toFixed(5);
    return displayPrice.toPrecision(4);
  }

  /** Public: unit scale metadata for chart header / HUD. */
  getPriceUnit(): { scale: number; exp: number } {
    return { scale: this.displayScale || 1, exp: this.displayExp };
  }

  private toDisplayBar(c: Candle): {
    time: UTCTimestamp;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null {
    if (!Number.isFinite(c.open) || !Number.isFinite(c.close) || !(c.close > 0)) return null;
    const s = this.displayScale || 1;
    const open = c.open * s;
    const close = c.close * s;
    const high = Math.max(c.high, c.open, c.close) * s;
    const lowRaw = Math.min(c.low > 0 ? c.low : Math.min(c.open, c.close), c.open, c.close);
    const low = Math.max(0, lowRaw * s);
    // Visible body in unit space (~0.2% min) so green/red fills read clearly.
    const minBody = Math.max(Math.abs(close) * 0.002, 0.0001);
    let o = open;
    let cl = close;
    if (Math.abs(cl - o) < minBody) {
      if (cl >= o) cl = o + minBody;
      else o = cl + minBody;
    }
    // Modest wicks — keep candles blocky, not tall thin needles.
    const bodyHi = Math.max(o, cl);
    const bodyLo = Math.min(o, cl);
    const wick = Math.max((bodyHi - bodyLo) * 0.15, minBody * 0.35);
    return {
      time: c.time as UTCTimestamp,
      open: o,
      high: Math.max(high, bodyHi + wick),
      low: Math.max(0, Math.min(low > 0 ? low : bodyLo, bodyLo - wick)),
      close: cl,
    };
  }

  private paintAll(data: Candle[]): void {
    if (!this.candles) return;
    this.recomputeDisplayScale(data);
    const bars = data
      .map((c) => this.toDisplayBar(c))
      .filter((b): b is NonNullable<typeof b> => b != null);
    this.candles.setData(bars);
    if (this.volume) {
      this.volume.setData(
        data
          .filter((c) => Number.isFinite(c.close) && c.close > 0)
          .map((c) => ({
            time: c.time as UTCTimestamp,
            value: Math.max(0, c.volume || 0),
            color: volumeColor(c, this.theme),
          })),
      );
    }
    if (bars.length) {
      this.setPriceLine(bars[bars.length - 1].close);
      // Keep wide bar spacing; show a comfortable window of recent candles.
      this.chart?.timeScale().applyOptions({ barSpacing: 22, minBarSpacing: 10, rightOffset: 10 });
      const n = bars.length;
      if (n <= 24) {
        this.chart?.timeScale().setVisibleLogicalRange({
          from: -1.5,
          to: n + 3,
        });
      } else {
        this.chart?.timeScale().setVisibleLogicalRange({
          from: n - 28,
          to: n + 3,
        });
      }
      this.chart?.priceScale("right").applyOptions({
        autoScale: true,
        visible: true,
        minimumWidth: 72,
      });
      this.pinned = true;
    }
    if (this.showMarkers) this.paintMarkers();
    else this.candles.setMarkers([]);
  }

  private applyCandle(candle: Candle, isNew: boolean): void {
    if (!this.candles) return;
    if (!(candle.close > 0) || !Number.isFinite(candle.close)) return;
    // Keep display scale in sync if this is a brand-new series or scale was 1
    if (this.displayScale === 1 && candle.close < 1e-4) {
      this.recomputeDisplayScale([candle]);
    }
    const bar = this.toDisplayBar(candle);
    if (!bar) return;
    this.candles.update(bar);
    this.volume?.update({
      time: candle.time as UTCTimestamp,
      value: Math.max(0, candle.volume || 0),
      color: volumeColor(candle, this.theme),
    });
    this.setPriceLine(bar.close);
    if ((isNew || this.pinned) && this.autoScroll) {
      this.chart?.timeScale().scrollToRealTime();
    }
  }

  private setPriceLine(displayPrice: number): void {
    if (!this.candles || !Number.isFinite(displayPrice)) return;
    if (this.priceLine) {
      this.candles.removePriceLine(this.priceLine);
      this.priceLine = null;
    }
    this.priceLine = this.candles.createPriceLine({
      price: displayPrice,
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
