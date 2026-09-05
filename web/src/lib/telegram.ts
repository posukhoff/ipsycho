/**
 * The Telegram Mini App SDK, behind one typed surface.
 *
 * Three things decide the shape of this file:
 *
 * - **Nothing may assume a native client.** Telegram Web runs the app in an iframe on
 *   `web.telegram.org`, and a developer opens it in a plain browser tab with `VITE_API_MOCK=1`.
 *   Every accessor here answers something sensible when `window.Telegram` is missing, so a screen
 *   never has to ask whether it is inside Telegram.
 * - **`initData` is a credential, read late.** A webview can hand it over slightly after first
 *   paint, so it is read on every request instead of captured once, and it is never stored, never
 *   logged and never put in a URL.
 * - **Newer methods are version-gated.** `BackButton` is Bot API 6.1, `safeAreaInset` is 8.0, and
 *   calling one on an older client throws. Every call goes through `callSafely`.
 */

export type ColorScheme = "light" | "dark";

export type HapticImpact = "light" | "medium" | "heavy" | "rigid" | "soft";
export type HapticNotification = "error" | "success" | "warning";

export interface TelegramThemeParams {
  readonly bg_color?: string;
  readonly text_color?: string;
  readonly hint_color?: string;
  readonly link_color?: string;
  readonly button_color?: string;
  readonly button_text_color?: string;
  readonly secondary_bg_color?: string;
  readonly header_bg_color?: string;
  readonly bottom_bar_bg_color?: string;
  readonly accent_text_color?: string;
  readonly section_bg_color?: string;
  readonly section_header_text_color?: string;
  readonly section_separator_color?: string;
  readonly subtitle_text_color?: string;
  readonly destructive_text_color?: string;
}

export interface SafeAreaInset {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface TelegramButton {
  isVisible: boolean;
  show: () => void;
  hide: () => void;
  onClick: (handler: () => void) => void;
  offClick: (handler: () => void) => void;
}

interface TelegramMainButton extends TelegramButton {
  setParams: (params: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }) => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
}

interface TelegramHaptics {
  impactOccurred: (style: HapticImpact) => void;
  notificationOccurred: (type: HapticNotification) => void;
  selectionChanged: () => void;
}

export interface TelegramWebApp {
  readonly initData: string;
  readonly initDataUnsafe?: { start_param?: string; user?: { language_code?: string } };
  readonly version: string;
  readonly platform: string;
  readonly colorScheme: ColorScheme;
  readonly themeParams: TelegramThemeParams;
  readonly viewportHeight: number;
  readonly viewportStableHeight: number;
  readonly isExpanded: boolean;
  readonly safeAreaInset?: SafeAreaInset;
  readonly contentSafeAreaInset?: SafeAreaInset;
  readonly BackButton: TelegramButton;
  readonly MainButton: TelegramMainButton;
  readonly HapticFeedback?: TelegramHaptics;
  ready: () => void;
  expand: () => void;
  close: () => void;
  isVersionAtLeast: (version: string) => boolean;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink?: (url: string) => void;
  onEvent: (event: string, handler: () => void) => void;
  offEvent: (event: string, handler: () => void) => void;
}

/** The live object, or null in a browser tab. Read every time: the SDK appears asynchronously. */
export function webApp(): TelegramWebApp | null {
  return (globalThis as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp ?? null;
}

export function isInsideTelegram(): boolean {
  const app = webApp();
  return Boolean(app && app.initData !== undefined);
}

/**
 * Calls a method that may not exist on the client's Bot API version. Anything older than the method
 * simply does nothing — the app degrades, it does not break, which is the whole point of shipping
 * one bundle to five clients.
 */
function callSafely(run: () => void): void {
  try {
    run();
  } catch {
    /* an older client, or a method the platform does not implement */
  }
}

function atLeast(version: string): boolean {
  const app = webApp();
  if (!app) return false;
  try {
    return app.isVersionAtLeast(version);
  } catch {
    return false;
  }
}

/** The raw `initData` string for the `Authorization: tma …` header, or null outside Telegram. */
export function initDataRaw(): string | null {
  const raw = webApp()?.initData;
  return raw && raw.length > 0 ? raw : null;
}

/**
 * `start_param`, from the launch URL or the SDK.
 *
 * Attacker-influenced whenever a link is shared (design.md § 1). It is a navigation hint and
 * nothing else: the router turns it into a route, and server scoping turns a foreign id into a
 * not-found. Never treat it as an assertion about what the user may see.
 */
export function startParam(): string | null {
  const fromSdk = webApp()?.initDataUnsafe?.start_param;
  if (fromSdk) return fromSdk;
  const search = new URLSearchParams(globalThis.location?.search ?? "");
  return search.get("tgWebAppStartParam");
}

/** The interface language Telegram reports, e.g. `uk-UA`. Null in a browser tab. */
export function telegramLanguageCode(): string | null {
  return webApp()?.initDataUnsafe?.user?.language_code ?? null;
}

export function colorScheme(): ColorScheme {
  const scheme = webApp()?.colorScheme;
  if (scheme === "dark" || scheme === "light") return scheme;
  const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  return media?.matches ? "dark" : "light";
}

export function themeParams(): TelegramThemeParams {
  return webApp()?.themeParams ?? {};
}

export function viewportHeight(): number | null {
  const app = webApp();
  const height = app?.viewportStableHeight || app?.viewportHeight;
  return height && height > 0 ? height : null;
}

export function safeAreaInsets(): SafeAreaInset | null {
  const app = webApp();
  if (!app || !atLeast("8.0")) return null;
  const area = app.safeAreaInset;
  const content = app.contentSafeAreaInset;
  if (!area && !content) return null;
  return {
    top: (area?.top ?? 0) + (content?.top ?? 0),
    bottom: (area?.bottom ?? 0) + (content?.bottom ?? 0),
    left: (area?.left ?? 0) + (content?.left ?? 0),
    right: (area?.right ?? 0) + (content?.right ?? 0),
  };
}

/** `ready()` + `expand()`, plus the vertical-swipe guard that stops a scroll from closing the app. */
export function bootstrapTelegram(): void {
  const app = webApp();
  if (!app) return;
  callSafely(() => app.ready());
  callSafely(() => app.expand());
  if (atLeast("7.7")) callSafely(() => app.disableVerticalSwipes?.());
}

export function onTelegramEvent(event: string, handler: () => void): () => void {
  const app = webApp();
  if (!app) return () => undefined;
  callSafely(() => app.onEvent(event, handler));
  return () => callSafely(() => app.offEvent(event, handler));
}

/* ------------------------------------------------------------------ buttons */

export interface BackButtonControl {
  show: (onClick: () => void) => () => void;
  hide: () => void;
}

/** Shows the native back button and returns the teardown that hides it and drops the handler. */
export const backButton: BackButtonControl = {
  show(onClick) {
    const app = webApp();
    if (!app || !atLeast("6.1")) return () => undefined;
    callSafely(() => app.BackButton.onClick(onClick));
    callSafely(() => app.BackButton.show());
    return () => {
      callSafely(() => app.BackButton.offClick(onClick));
      callSafely(() => app.BackButton.hide());
    };
  },
  hide() {
    const app = webApp();
    if (app && atLeast("6.1")) callSafely(() => app.BackButton.hide());
  },
};

export interface MainButtonParams {
  readonly text: string;
  readonly enabled?: boolean;
  readonly loading?: boolean;
}

/** Shows the native main button and returns the teardown. The caller owns the click handler. */
export function showMainButton(params: MainButtonParams, onClick: () => void): () => void {
  const app = webApp();
  if (!app) return () => undefined;
  const button = app.MainButton;
  callSafely(() => button.onClick(onClick));
  callSafely(() => button.setParams({ text: params.text, is_active: params.enabled !== false, is_visible: true }));
  if (params.loading) callSafely(() => button.showProgress(false));
  else callSafely(() => button.hideProgress());
  return () => {
    callSafely(() => button.offClick(onClick));
    callSafely(() => button.hideProgress());
    callSafely(() => button.hide());
  };
}

/* ------------------------------------------------------------------ haptics */

/**
 * Haptics on a state change, never on navigation. A phone that buzzes on every tap stops meaning
 * anything; a task that goes done should feel different from one that failed to.
 */
export const haptics = {
  impact(style: HapticImpact = "light"): void {
    callSafely(() => webApp()?.HapticFeedback?.impactOccurred(style));
  },
  notify(type: HapticNotification): void {
    callSafely(() => webApp()?.HapticFeedback?.notificationOccurred(type));
  },
  select(): void {
    callSafely(() => webApp()?.HapticFeedback?.selectionChanged());
  },
};
