# @genesispad/dex-chart

Production-ready **DexScreener-style** live trading chart built with:

- React + TypeScript
- [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (open-source, **not** the paid Charting Library)

## Features

- Dark theme (`#0d1117`)
- Green / red OHLC candles + volume histogram
- Right price scale, bottom time scale, crosshair OHLC tooltip
- Timeframes: `1s` `5s` `15s` `1m` `5m` `15m` `1h` `4h`
- Live trade → candle builder (`series.update`, never full redraw)
- WebSocket reconnect with backoff
- Auto-scroll only when pinned to latest; pans pause follow mode
- Current price line, buy/sell arrow markers
- Stats strip: market cap, liquidity, volume, holders
- High-DPI via Lightweight Charts, responsive layout, 60fps RAF coalescing

## Install

```bash
cd chart
pnpm install
```

Peer deps: `react` / `react-dom` ≥ 18.

## React usage

```tsx
import { Chart } from "@genesispad/dex-chart";
import "@genesispad/dex-chart/Chart.css";

<Chart
  historical={candles}
  websocketUrl="wss://your.stream/trades"
  marketStats={{
    marketCap: 1_200_000,
    liquidity: 45_000,
    volume: 120_000,
    holders: 1800,
    price: 0.00012,
    changePct: 8.2,
    symbol: "TOKEN",
  }}
  markers={[{ time: 1710000000, side: "buy" }]}
  timeframe="5m"
  showVolume
  showMarkers
/>;
```

## Imperative API

```ts
import { createDexChart } from "@genesispad/dex-chart";

const chart = createDexChart({ timeframe: "1m" });

chart.initializeChart(document.getElementById("chart")!);
chart.setHistoricalData(candles);
chart.connectWebSocket("wss://…");
chart.updateTrade({ timestamp: Date.now(), price: 1.23, volume: 10, side: "buy" });
chart.changeTimeframe("5m");
chart.setMarkers([{ time: 1710000000, side: "sell" }]);
chart.destroy();
```

Aliases:

| Method | Description |
|--------|-------------|
| `initializeChart(container)` | Create chart (once) |
| `setHistoricalData(candles)` | Bulk OHLCV seed via `setData` |
| `connectWebSocket(url)` | Live trades |
| `updateTrade(trade)` | Incremental candle update |
| `changeTimeframe(interval)` | Rebuild buckets |
| `destroy()` | Teardown |

## Architecture

```
chart/src/
  Chart.tsx          React shell (stats, intervals, tooltip)
  useChart.ts        Long-lived IChartApi + series.update
  useWebSocket.ts    Reconnecting trade stream
  candleBuilder.ts   O(1) live OHLCV aggregation
  api.ts             Imperative controller
  types.ts           Shared types
  utils.ts           Formatting + theme
  Chart.css          DexScreener-like chrome
  index.ts           Public exports
```

## Demo

```bash
cd chart
pnpm install
pnpm demo
```

Opens a live simulated tape at http://localhost:5177

## Performance notes

- Chart instance is created **once** per mount / controller.
- Live path only calls `series.update()` (and coalesces bursts to `requestAnimationFrame`).
- History is capped (~120k candles) with binary search for rare out-of-order trades.
- Volume + candle series share the same time scale; volume uses a separate price scale margin.

## License

Part of GenesisPad. Lightweight Charts is Apache-2.0 (TradingView).
