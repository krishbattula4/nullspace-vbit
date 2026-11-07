import { useEffect, useState } from "react";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
export const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws";

export type HealthState = "checking" | "ok" | "down";

/** Polls /health so the shell can show whether the backend and its database are reachable. */
export function useBackendHealth(intervalMs = 10000) {
  const [state, setState] = useState<{ state: HealthState; detail: string }>({
    state: "checking",
    detail: "",
  });

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const r = await fetch(`${API_URL}/health`);
        const body = (await r.json()) as { status: string; db: string };
        if (!cancelled) setState({ state: body.db === "ok" ? "ok" : "down", detail: body.db });
      } catch (e) {
        if (!cancelled) setState({ state: "down", detail: String(e) });
      }
    }
    void check();
    const id = setInterval(check, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}
