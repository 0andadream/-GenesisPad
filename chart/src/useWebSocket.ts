import { useCallback, useEffect, useRef, useState } from "react";
import type { Trade } from "./types";
import {
  TradeWebSocket,
  defaultTradeMessageParser,
  type TradeMessageParser,
  type WsStatus,
} from "./tradeSocket";

export type { TradeMessageParser, WsStatus };

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

const defaultParse = defaultTradeMessageParser;

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

export { TradeWebSocket };
