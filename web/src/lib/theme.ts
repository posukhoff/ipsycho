import { colorScheme, onTelegramEvent, safeAreaInsets, themeParams, viewportHeight, type ColorScheme, type TelegramThemeParams } from "./telegram.js";

/**
 * Telegram's theme, expressed as CSS variables.
 *
 * The client sends fifteen colours and changes them under the app while it is open — the user
 * switches to dark mode, or opens the same app from a channel with a different header colour. So
 * this is a subscription, not a one-off read: `themeChanged` and `viewportChanged` both rewrite the
 * variables in place, and every component is styled against the variables rather than a colour.
 *
 * Two things a "map the theme params" implementation usually gets wrong:
 *
 * - **Not every client sends every param.** `section_bg_color` and `bottom_bar_bg_color` are newer
 *   than the oldest supported client, and Telegram Web sends a different subset again. Each
 *   variable therefore has a fallback chain ending in a literal, and the literal differs between
 *   light and dark — which is why `data-theme` is stamped on the root element too.
 * - **Viewport height is not `100vh`.** In the iOS webview `100vh` is the height before the
 *   keyboard and before the collapsed header, so a bottom bar sits under the fold. `--app-height`
 *   is `viewportStableHeight` when Telegram reports one and `100dvh` otherwise.
 */

type ThemeVars = Record<string, string>;

const LIGHT_FALLBACK = {
  bg: "#ffffff",
  text: "#000000",
  hint: "#707579",
  link: "#3390ec",
  button: "#3390ec",
  buttonText: "#ffffff",
  secondaryBg: "#f4f4f5",
  sectionBg: "#ffffff",
  sectionHeaderText: "#707579",
  separator: "#e5e5e6",
  subtitle: "#707579",
  destructive: "#df3f40",
  headerBg: "#ffffff",
  bottomBarBg: "#f4f4f5",
  accent: "#3390ec",
} as const;

const DARK_FALLBACK = {
  bg: "#17212b",
  text: "#f5f5f5",
  hint: "#708499",
  link: "#6ab3f3",
  button: "#5288c1",
  buttonText: "#ffffff",
  secondaryBg: "#232e3c",
  sectionBg: "#17212b",
  sectionHeaderText: "#6ab3f3",
  separator: "#0f1620",
  subtitle: "#708499",
  destructive: "#ec3942",
  headerBg: "#17212b",
  bottomBarBg: "#232e3c",
  accent: "#6ab3f3",
} as const;

function pick(params: TelegramThemeParams, key: keyof TelegramThemeParams, fallback: string): string {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * The semantic palette. Screens use `--c-*`; `--tg-*` stays available for the rare case where the
 * raw Telegram colour is the right answer (a header tinted exactly like the client's).
 */
export function themeVariables(params: TelegramThemeParams, scheme: ColorScheme): ThemeVars {
  const base = scheme === "dark" ? DARK_FALLBACK : LIGHT_FALLBACK;
  const bg = pick(params, "bg_color", base.bg);
  const secondaryBg = pick(params, "secondary_bg_color", base.secondaryBg);
  const text = pick(params, "text_color", base.text);
  const hint = pick(params, "hint_color", base.hint);
  const separator = pick(params, "section_separator_color", base.separator);
  const button = pick(params, "button_color", base.button);

  return {
    "--tg-bg": bg,
    "--tg-secondary-bg": secondaryBg,
    "--tg-section-bg": pick(params, "section_bg_color", base.sectionBg),
    "--tg-header-bg": pick(params, "header_bg_color", base.headerBg),
    "--tg-bottom-bar-bg": pick(params, "bottom_bar_bg_color", base.bottomBarBg),
    "--tg-text": text,
    "--tg-hint": hint,
    "--tg-subtitle": pick(params, "subtitle_text_color", base.subtitle),
    "--tg-link": pick(params, "link_color", base.link),
    "--tg-accent": pick(params, "accent_text_color", base.accent),
    "--tg-button": button,
    "--tg-button-text": pick(params, "button_text_color", base.buttonText),
    "--tg-section-header-text": pick(params, "section_header_text_color", base.sectionHeaderText),
    "--tg-destructive": pick(params, "destructive_text_color", base.destructive),
    "--tg-separator": separator,

    /* The semantic layer every component is written against. */
    "--c-bg": secondaryBg,
    "--c-surface": pick(params, "section_bg_color", bg),
    "--c-surface-raised": bg,
    "--c-text": text,
    "--c-text-muted": hint,
    "--c-text-faint": pick(params, "subtitle_text_color", base.subtitle),
    "--c-accent": button,
    "--c-accent-text": pick(params, "button_text_color", base.buttonText),
    "--c-danger": pick(params, "destructive_text_color", base.destructive),
    "--c-separator": separator,
    "--c-overlay": scheme === "dark" ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.35)",
    "--c-skeleton": scheme === "dark" ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)",
    "--c-press": scheme === "dark" ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.04)",
  };
}

function applyVars(root: HTMLElement, vars: ThemeVars): void {
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

function applyViewport(root: HTMLElement): void {
  const height = viewportHeight();
  root.style.setProperty("--app-height", height ? `${height}px` : "100dvh");

  const insets = safeAreaInsets();
  // `env(safe-area-inset-*)` is the fallback: it is what Telegram Web and a plain browser tab have,
  // and it is what an older native client without Bot API 8.0 has too.
  root.style.setProperty("--safe-top", insets ? `${insets.top}px` : "env(safe-area-inset-top, 0px)");
  root.style.setProperty("--safe-bottom", insets ? `${insets.bottom}px` : "env(safe-area-inset-bottom, 0px)");
  root.style.setProperty("--safe-left", insets ? `${insets.left}px` : "env(safe-area-inset-left, 0px)");
  root.style.setProperty("--safe-right", insets ? `${insets.right}px` : "env(safe-area-inset-right, 0px)");
}

/**
 * Writes the theme onto `<html>` and keeps it there. Returns the teardown.
 *
 * Called once from the shell. A screen never calls it: a component that re-applied the theme on
 * mount would fight the `themeChanged` subscription during a transition.
 */
export function installTheme(): () => void {
  const root = document.documentElement;

  const paint = (): void => {
    const scheme = colorScheme();
    root.dataset["theme"] = scheme;
    root.style.colorScheme = scheme;
    applyVars(root, themeVariables(themeParams(), scheme));
    applyViewport(root);
  };

  paint();

  const offTheme = onTelegramEvent("themeChanged", paint);
  const offViewport = onTelegramEvent("viewportChanged", () => applyViewport(root));
  const offSafeArea = onTelegramEvent("safeAreaChanged", () => applyViewport(root));
  const offContentSafeArea = onTelegramEvent("contentSafeAreaChanged", () => applyViewport(root));

  // Outside Telegram the OS is the only source of truth for the scheme, and a browser tab is
  // resized by the window rather than by a viewport event.
  const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", paint);
  const onResize = (): void => applyViewport(root);
  window.addEventListener("resize", onResize);

  return () => {
    offTheme();
    offViewport();
    offSafeArea();
    offContentSafeArea();
    media?.removeEventListener("change", paint);
    window.removeEventListener("resize", onResize);
  };
}
