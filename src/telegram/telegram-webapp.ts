import { InlineKeyboard } from "grammy";
import type { TaskScope } from "../core/task-list-view.js";
import type { CopyKey } from "./copy/index.js";
import { t } from "./copy/index.js";
import type { TelegramLocale } from "./telegram-locale.js";
import type { GoalScope } from "./telegram-keyboards.js";

/**
 * Deep links into the Mini App, and the one button that opens them.
 *
 * Two rules, both from design.md § 2:
 *
 * - **The id goes in the fragment**, never the path or the query. A fragment is not sent to the
 *   server, so an occurrence id in a launch button never reaches Caddy's access log or an upstream
 *   proxy. `${WEBAPP_URL}/#/task/<occurrenceId>`.
 * - **A link is a hint, not an authorization.** Anyone who receives a forwarded button can edit the
 *   id in it; the API scopes every lookup by workspace and answers `not_found` for a foreign id.
 *
 * Every screen below is a route `web/src/app/routes.ts` registers, and `webAppPath` is the
 * server-side twin of that file's `routePath`. The two files are a pair with no compiler between
 * them — the client is a separate build — so `tests/app/telegram-launch-buttons.test.mjs` reads the
 * client's route table and checks every link this module can build against it. A link into a screen
 * the client does not register fails there, rather than opening a not-found in someone's hand.
 */
export type WebAppScreen =
  | { readonly name: "today" }
  | { readonly name: "tasks"; readonly scope: TaskScope }
  | { readonly name: "task"; readonly id: string }
  | { readonly name: "week" }
  | { readonly name: "goals"; readonly scope: GoalScope }
  | { readonly name: "reminders" }
  | { readonly name: "settings" }
  | { readonly name: "memory" }
  | { readonly name: "profile" };

/** The path half of the fragment, without the `#`. Mirrors `routePath` in the client. */
export function webAppPath(screen: WebAppScreen): string {
  switch (screen.name) {
    case "today":
      return "/today";
    case "tasks":
      return `/tasks/${screen.scope}`;
    case "task":
      return `/task/${screen.id}`;
    case "week":
      return "/week";
    case "goals":
      return `/goals/${screen.scope}`;
    case "reminders":
      return "/reminders";
    case "settings":
      return "/settings";
    case "memory":
      return "/memory";
    case "profile":
      return "/profile";
  }
}

/**
 * The full launch URL, or `null` when the Mini App is off.
 *
 * `null` in, `null` out is the whole flag-off contract of this change: every keyboard asks for a
 * link, gets nothing, and builds exactly the buttons it built before the app existed. Callers pass
 * `ctx.state.webAppUrl`, which is `null` unless `WEBAPP_ENABLED=true`.
 */
export function webAppLink(baseUrl: string | null | undefined, screen: WebAppScreen): string | null {
  if (!baseUrl) return null;
  // A configured URL may or may not end in a slash; `${base}//#/today` is a different origin path.
  return `${baseUrl.replace(/\/+$/u, "")}/#${webAppPath(screen)}`;
}

/**
 * Appends the launch button as a row of its own, or leaves the keyboard untouched when the app is
 * off. Returns the same keyboard so it can be used inline.
 */
export function appendLaunchButton(
  keyboard: InlineKeyboard,
  baseUrl: string | null | undefined,
  screen: WebAppScreen,
  locale: TelegramLocale,
  key: CopyKey = "webapp_open_button",
): InlineKeyboard {
  const link = webAppLink(baseUrl, screen);
  if (!link) return keyboard;
  // A fresh keyboard already carries one empty row, and several builders end with `.row()`:
  // an unconditional `row()` here would send Telegram an empty row it renders as a gap.
  const last = keyboard.inline_keyboard[keyboard.inline_keyboard.length - 1];
  if (last && last.length > 0) keyboard.row();
  return keyboard.webApp(t(locale, key), link);
}

/** A keyboard that is only the launch button; for a message that has no buttons of its own today. */
export function launchOnlyKeyboard(baseUrl: string | null | undefined, screen: WebAppScreen, locale: TelegramLocale, key: CopyKey = "webapp_open_button"): InlineKeyboard | null {
  const link = webAppLink(baseUrl, screen);
  return link ? new InlineKeyboard().webApp(t(locale, key), link) : null;
}
