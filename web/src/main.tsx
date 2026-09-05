import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient, ApiRequestError } from "./api/client.js";
import type { MeResponse } from "./api/contracts.js";

/**
 * The bootstrap, and nothing more.
 *
 * Group 5 owns `src/app/**` and replaces the body of `Shell` with the real router, theming and
 * component set. Everything below exists so that the skeleton is verifiable on its own: with
 * `VITE_API_MOCK=1` this renders a working screen against the mock transport and no backend at all,
 * which is the check task 0.8 asks for.
 *
 * The one thing that should survive group 5 unchanged is `initData`: it is read from the Telegram
 * SDK on every request rather than captured once, because a webview can hand it over slightly after
 * first paint, and it is never stored anywhere but this closure.
 */

interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  themeParams?: Record<string, string>;
}

function telegram(): TelegramWebApp | undefined {
  return (globalThis as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

const api = createApiClient({ initData: () => telegram()?.initData || null });

function Shell() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const app = telegram();
    app?.ready();
    app?.expand();
    api
      .request("me")
      .then(setMe)
      .catch((cause: unknown) => setError(cause instanceof ApiRequestError ? cause.code : "internal"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "16px", lineHeight: 1.5 }}>
      <h1 style={{ fontSize: "18px", margin: "0 0 12px" }}>IPsycho</h1>
      {error ? <p role="alert">{error}</p> : null}
      {!error && !me ? <p>…</p> : null}
      {me ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
          <dt>locale</dt>
          <dd style={{ margin: 0 }}>{me.locale}</dd>
          <dt>timezone</dt>
          <dd style={{ margin: 0 }}>{me.timezone}</dd>
          <dt>today</dt>
          <dd style={{ margin: 0 }}>{me.todayLocalDate}</dd>
          <dt>build</dt>
          <dd style={{ margin: 0 }}>{me.commit ?? "dev"}</dd>
        </dl>
      ) : null}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
