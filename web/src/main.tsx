import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app.js";
import "./ui/styles.css";

/**
 * The entry point, and nothing more.
 *
 * Everything that used to be here — reading `initData`, calling `ready()`, fetching `/me` — now
 * lives inside React: `App` composes the providers, `Boot` runs the Telegram handshake and the
 * theme subscription in an effect, and `Shell` renders the route. Keeping it that way matters for
 * one specific reason: the theme and the viewport are *subscriptions*, not one-off reads, and code
 * that runs once before `createRoot` cannot unsubscribe.
 */

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
