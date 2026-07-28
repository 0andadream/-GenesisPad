import type { Trade } from "./types";
import { normalizeTrade } from "./utils";

export type TradeMessageParser = (data: unknown) => Trade | Trade[] | null;
export type WsStatus = "idle" | "connecting" | "open" | "closed" | "error";

const defaultParse: TradeMessageParser = (data) => {
  if (data == null) return null;
  if (typeof data === "string") {
    try {
      return defaultParse(JSON.parse(data));
    } catch {
      return null;
    }
  }
  if (Array.isArray(data)) {
    const trades = data
      .map((row) => coerceTrade(row))
      .filter((t): t is Trade => t != null);
    return trades.length ? trades : null;
  }
  return coerceTrade(data);
};

function coerceTrade(row: unknown): Trade | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const payload = (r.data ?? r.trade ?? r.payload ?? r) as Record<string, unknown>;
  const price = Number(payload.price ?? payload.p ?? payload.rate);
  const volume = Number(
    payload.volume ?? payload.v ?? payload.amount ?? payload.qty ?? payload.thru ?? 0,
  );
  const timestamp = Number(
    payload.timestamp ?? payload.ts ?? payload.t ?? payload.time ?? Date.now(),
  );
  if (!Number.isFinite(price) || price <= 0) return null;
  const sideRaw = String(payload.side ?? payload.type ?? "").toLowerCase();
  const side =
    sideRaw === "sell" || sideRaw === "s" || sideRaw === "ask"
      ? "sell"
      : sideRaw === "buy" || sideRaw === "b" || sideRaw === "bid"
        ? "buy"
        : undefined;
  return normalizeTrade({
    timestamp,
    price,
    volume: Number.isFinite(volume) ? volume : 0,
    side,
    id:
      payload.id != null
        ? String(payload.id)
        : payload.tx != null
          ? String(payload.tx)
          : undefined,
  });
}

/** Imperative WS client (no React). */
export class TradeWebSocket {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intentional = false;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly parse: TradeMessageParser;
  onTrade: ((t: Trade) => void) | null = null;
  onStatus: ((s: WsStatus) => void) | null = null;

  constructor(
    opts: {
      reconnectMs?: number;
      maxReconnectMs?: number;
      parseMessage?: TradeMessageParser;
    } = {},
  ) {
    this.reconnectMs = opts.reconnectMs ?? 800;
    this.maxReconnectMs = opts.maxReconnectMs ?? 15_000;
    this.parse = opts.parseMessage ?? defaultParse;
  }

  connect(url: string): void {
    this.url = url;
    this.intentional = false;
    this.open();
  }

  disconnect(): void {
    this.intentional = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.onStatus?.("closed");
  }

  private open(): void {
    if (!this.url) return;
    this.onStatus?.("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.onStatus?.("open");
    };
    ws.onmessage = (ev) => {
      let payload: unknown = ev.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          /* keep */
        }
      }
      const parsed = this.parse(payload);
      if (!parsed) return;
      for (const t of Array.isArray(parsed) ? parsed : [parsed]) {
        this.onTrade?.(t);
      }
    };
    ws.onerror = () => this.onStatus?.("error");
    ws.onclose = () => {
      this.ws = null;
      if (this.intentional) {
        this.onStatus?.("closed");
        return;
      }
      this.onStatus?.("closed");
      const delay = Math.min(
        this.maxReconnectMs,
        this.reconnectMs * 2 ** Math.min(this.retries++, 6),
      );
      this.timer = setTimeout(() => this.open(), delay);
    };
  }
}

export { defaultParse as defaultTradeMessageParser };
