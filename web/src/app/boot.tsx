import { createContext, useContext, useEffect, type ReactNode } from "react";
import { ApiRequestError } from "../api/client.js";
import type { MeResponse, SettingsResponse } from "../api/contracts.js";
import { I18nProvider, resolveLocale, useT } from "../i18n/index.js";
import { useQuery } from "../lib/query.js";
import { bootstrapTelegram, telegramLanguageCode } from "../lib/telegram.js";
import { installTheme } from "../lib/theme.js";
import { EmptyState, ErrorState, Skeleton } from "../ui/states.js";

/**
 * The one bootstrap call, and the three things that have to happen before any screen renders.
 *
 * 1. Telegram is told the app is ready and asked to expand. Doing it here rather than in
 *    `main.tsx` keeps it inside React's lifecycle, so a hot reload does not leave a collapsed
 *    webview behind.
 * 2. The theme is installed on `<html>` and stays subscribed to `themeChanged`.
 * 3. `GET /me` answers with access, locale, timezone, today's local date, AI state and the whole
 *    settings row. Every screen reads today's date and the timezone from here rather than from the
 *    device, which is the rule the contract's `primitives.ts` states.
 *
 * The refusal path matters as much as the happy one. The guard answers `unauthorized` identically
 * for an unknown user, a disabled user and one pending deletion — deliberately, so the API cannot
 * be used to enumerate who has an account — so the client cannot say *which* it was either. It says
 * «open me from Telegram», which is the only actionable thing left, and the deletion-pending case
 * is why the settings screen has to state that `/restore` is a chat command.
 */

const MeContext = createContext<MeResponse | null>(null);

/**
 * The bootstrap response. Available to every screen; it is fetched once and cached.
 *
 * There is no `refresh` beside it: `useSettingsPatch` invalidates `["me"]` in the query cache after
 * a change that moves the timezone or the language, which refetches this the same way, and a second
 * way to do it is a second thing to remember.
 */
export function useMe(): MeResponse {
  const value = useContext(MeContext);
  if (!value) throw new Error("useMe is only available under <Boot>");
  return value;
}

export function useSettings(): SettingsResponse {
  return useMe().settings;
}

/** The user's timezone, and local today in it. Never `new Date()` in a screen. */
export function useTimezone(): string {
  return useMe().timezone;
}

export function useTodayLocalDate(): string {
  return useMe().todayLocalDate;
}

export function Boot({ children }: { children: ReactNode }): ReactNode {
  useEffect(() => {
    bootstrapTelegram();
    return installTheme();
  }, []);

  const me = useQuery("me");

  if (me.data) {
    const locale = resolveLocale(me.data.settings.pinnedLanguage, me.data.settings.telegramLanguage ?? telegramLanguageCode());
    return (
      <I18nProvider locale={locale}>
        <MeContext.Provider value={me.data}>{children}</MeContext.Provider>
      </I18nProvider>
    );
  }

  if (me.error instanceof ApiRequestError && me.error.code === "unauthorized") return <UnauthorizedScreen />;
  if (me.error !== undefined) return <BootFailure error={me.error} onRetry={() => void me.refetch()} />;
  return <BootSkeleton />;
}

function BootSkeleton(): ReactNode {
  return (
    <div className="ip-screen">
      <div className="ip-header">
        <Skeleton width="45%" height={22} />
      </div>
      <div className="ip-screen__body ip-stack">
        <Skeleton height={64} radius={16} />
        <Skeleton height={64} radius={16} />
        <Skeleton height={64} radius={16} />
      </div>
    </div>
  );
}

function BootFailure({ error, onRetry }: { error: unknown; onRetry: () => void }): ReactNode {
  return (
    <div className="ip-screen">
      <div className="ip-screen__body">
        <ErrorState error={error} onRetry={onRetry} />
      </div>
    </div>
  );
}

function UnauthorizedScreen(): ReactNode {
  const t = useT();
  return (
    <div className="ip-screen">
      <div className="ip-screen__body">
        <EmptyState icon="🔒" title={t("error.unauthorized_title")} body={t("error.unauthorized_body")} />
      </div>
    </div>
  );
}
