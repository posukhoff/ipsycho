import { useMemo, type ReactNode } from "react";
import { createApiClient } from "../api/client.js";
import { I18nProvider, resolveLocale } from "../i18n/index.js";
import { ApiProvider } from "../lib/query.js";
import { initDataRaw, startParam, telegramLanguageCode } from "../lib/telegram.js";
import { ToastProvider } from "../ui/toast.js";
import { Boot } from "./boot.js";
import { ErrorBoundary } from "./error-boundary.js";
import { RouterProvider } from "./router.js";
import { routeFromStartParam } from "./routes.js";
import { Shell } from "./shell.js";

/**
 * The provider stack, in the order the dependencies actually run.
 *
 * - `I18nProvider` first, with the language Telegram reports, so the loading screen and the
 *   «open me from Telegram» refusal are already in the right language. `Boot` nests a second
 *   provider once `/me` has answered with the pinned one.
 * - `ApiProvider` owns the query cache. `initData` is read through a function on every request
 *   rather than captured here: a webview can produce it slightly after first paint, and it is a
 *   credential, so it never leaves this closure and is never stored.
 * - `RouterProvider` takes the launch `start_param` as its opening route — a hint, checked for
 *   shape and nothing more.
 * - `ToastProvider` sits above the screens because `useUndo` is used from inside them.
 */
export function App(): ReactNode {
  const client = useMemo(() => createApiClient({ initData: initDataRaw }), []);
  const initialRoute = useMemo(() => routeFromStartParam(startParam()), []);
  const bootLocale = resolveLocale(null, telegramLanguageCode());

  return (
    <ErrorBoundary>
      <I18nProvider locale={bootLocale}>
        <ApiProvider client={client}>
          <RouterProvider {...(initialRoute ? { initialRoute } : {})}>
            <ToastProvider>
              <Boot>
                <Shell />
              </Boot>
            </ToastProvider>
          </RouterProvider>
        </ApiProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
