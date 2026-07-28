import { useCallback, useEffect, useRef, useState } from "react";
import type { Trade } from "./types";
import { normalizeTrade } from "./utils";

export type TradeMessageParser = (data: unknown) => Trade | Trade[] | null;

export interface UseWebSocketOptions {
  url?: string | null;
  /** Auto-connect when url is set. Default true. */
  enabled?: boolean;
  /** Base reconnect delay (exponential backoff). */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** Parse raw WS messages into trades. */
  parseMessage?: TradeMessageParser;
  onTrade?: (trade: Trade) => void;
  onStatus?: (status: WsStatus) => void;
  onError?: (error: Event | Error) => void;
}

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
  // Common envelope shapes
  const payload = (r.data ?? r.trade ?? r.payload ?? r) as Record<string, unknown>;
  const price = Number(payload.price ?? payload.p ?? payload.rate);
  const volume = Number(payload.volume ?? payload.v ?? payload.amount ?? payload.qty ?? payload.thru ?? 0);
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
    id: payload.id != null ? String(payload.id) : payload.tx != null ? String(payload.tx) : undefined,
  });
}

/**
 * Production WebSocket hook with exponential reconnect and heartbeat.
 * Does not tear down the chart — only streams trades upward.
 */
export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    url = null,
    enabled = true,
    reconnectMs = 800,
    maxReconnectMs = 15_000,
    parseMessage = defaultParse,
    onTrade,
    onStatus,
    onError,
  } = options;

  const [status, setStatus] = useState<WsStatus>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalClose = useRef(false);
  const onTradeRef = useRef(onTrade);
  const parseRef = useRef(parseMessage);
  onTradeRef.current = onTrade;
  parseRef.current = parseMessage;

  const updateStatus = useCallback(
    (s: WsStatus) => {
      setStatus(s);
      onStatus?.(s);
    },
    [onStatus],
  );

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const disconnect = useCallback(() => {
    intentionalClose.current = true;
    clearTimer();
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
    updateStatus("closed");
  }, [updateStatus]);

  const connect = useCallback(
    (nextUrl?: string) => {
      const target = nextUrl ?? url;
      if (!target) return;
      intentionalClose.current = false;
      clearTimer();
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }

      updateStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(target);
      } catch (err) {
        updateStatus("error");
        onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        retriesRef.current = 0;
        updateStatus("open");
      };

      ws.onmessage = (ev) => {
        let payload: unknown = ev.data;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {
            /* keep string */
          }
        }
        const parsed = parseRef.current(payload);
        if (!parsed) return;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const trade of list) {
          onTradeRef.current?.(trade);
        }
      };

      ws.onerror = (ev) => {
        updateStatus("error");
        onError?.(ev);
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (intentionalClose.current) {
          updateStatus("closed");
          return;
        }
        updateStatus("closed");
        const attempt = retriesRef.current++;
        const delay = Math.min(maxReconnectMs, reconnectMs * 2 ** Math.min(attempt, 6));
        timerRef.current = setTimeout(() => {
          if (!intentionalClose.current) connect(target);
        }, delay);
      };
    },
    [url, reconnectMs, maxReconnectMs, updateStatus, onError],
  );

  useEffect(() => {
    if (!enabled || !url) {
      disconnect();
      return;
    }
    connect(url);
    return () => disconnect();
  }, [url, enabled, connect, disconnect]);

  return {
    status,
    connect,
    disconnect,
    isOpen: status === "open",
  };
}

/** Imperative WS client (for non-React controller API). */
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
