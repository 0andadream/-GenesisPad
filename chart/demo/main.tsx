import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createDexChart } from "../src/api";
import type { TradeMarker } from "../src/types";
import { TIMEFRAME_SECONDS } from "../src/utils";
import type { Candle } from "../src/types";

function generateHistory(count = 500, timeframeSec = 300): Candle[] {
  const now = Math.floor(Date.now() / 1000);
  const start = now - count * timeframeSec;
  let price = 0.000012;
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = start + i * timeframeSec;
    const drift = (Math.random() - 0.48) * price * 0.04;
    const open = price;
    const close = Math.max(1e-12, price + drift);
    const high = Math.max(open, close) * (1 + Math.random() * 0.015);
    const low = Math.min(open, close) * (1 - Math.random() * 0.015);
    const volume = 50 + Math.random() * 400;
    out.push({ time: t, open, high, low, close, volume });
    price = close;
  }
  return out;
}

function Demo() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [stats, setStats] = useState({
    marketCap: 1_200_000,
    liquidity: 42_500,
    volume: 128_400,
    holders: 1832,
    price: 0.000012,
    changePct: 12.48,
    symbol: "DEMO",
  });

  useEffect(() => {
    if (!ref.current) return;

    const chart = createDexChart({
      timeframe: "5m",
      showVolume: true,
      showMarkers: true,
      autoScroll: true,
    });
    chart.initializeChart(ref.current);

    const history = generateHistory(500, TIMEFRAME_SECONDS["5m"]);
    chart.setHistoricalData(history);

    const markers: TradeMarker[] = history
      .filter((_, i) => i % 37 === 0)
      .map((c, i) => ({
        time: c.time,
        side: i % 2 === 0 ? "buy" : "sell",
      }));
    chart.setMarkers(markers);

    let price = history[history.length - 1].close;
    const open0 = history[0].open;
    const timer = window.setInterval(() => {
      const side = Math.random() > 0.45 ? "buy" : "sell";
      price = Math.max(1e-12, price * (1 + (Math.random() - 0.45) * 0.01));
      chart.updateTrade({
        timestamp: Date.now(),
        price,
        volume: 10 + Math.random() * 90,
        side,
        id: `${Date.now()}-${Math.random()}`,
      });
      setStats((s) => ({
        ...s,
        price,
        marketCap: price * 1e11,
        volume: s.volume + Math.random() * 50,
        changePct: ((price - open0) / open0) * 100,
      }));
    }, 450);

    return () => {
      clearInterval(timer);
      chart.destroy();
    };
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: 16,
        background: "#010409",
        boxSizing: "border-box",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <h1
        style={{
          color: "#e6edf3",
          fontWeight: 650,
          fontSize: 18,
          margin: "0 0 12px",
        }}
      >
        Genesis · DexScreener-style live chart (Lightweight Charts)
      </h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 1,
          background: "#21262d",
          borderRadius: "10px 10px 0 0",
          overflow: "hidden",
        }}
      >
        {(
          [
            ["Market cap", `$${(stats.marketCap / 1e6).toFixed(2)}M`],
            ["Liquidity", `$${(stats.liquidity / 1e3).toFixed(1)}K`],
            ["Volume", `$${(stats.volume / 1e3).toFixed(1)}K`],
            ["Holders", stats.holders.toLocaleString()],
          ] as const
        ).map(([label, value]) => (
          <div key={label} style={{ background: "#161b22", padding: "10px 12px" }}>
            <div style={{ color: "#8b949e", fontSize: 11, fontWeight: 600 }}>{label}</div>
            <div style={{ color: "#e6edf3", fontWeight: 650, marginTop: 4 }}>{value}</div>
          </div>
        ))}
      </div>

      <div
        style={{
          height: "min(62vh, 540px)",
          border: "1px solid #21262d",
          borderTop: 0,
          borderRadius: "0 0 10px 10px",
          overflow: "hidden",
          background: "#0d1117",
        }}
      >
        <div ref={ref} style={{ width: "100%", height: "100%" }} />
      </div>

      <p style={{ color: "#8b949e", fontSize: 12, marginTop: 12 }}>
        Live sim · {stats.symbol} {stats.price.toExponential(3)} (
        {stats.changePct >= 0 ? "+" : ""}
        {stats.changePct.toFixed(2)}%) · pan away to pause auto-scroll
      </p>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <Demo />
    </React.StrictMode>,
  );
}
