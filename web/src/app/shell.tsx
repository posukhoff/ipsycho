import { useEffect, type ReactNode } from "react";
import { useT } from "../i18n/index.js";
import { backButton, isInsideTelegram } from "../lib/telegram.js";
import { EmptyState, NotFoundState } from "../ui/states.js";
import { useNavigate, useRoute, Link } from "./router.js";
import { screenFor } from "./screens.js";
import { isRootRoute, ROOT_ROUTES, sameRoute, type Route } from "./routes.js";

/**
 * The shell: the tab bar, the native back button, and the screen the route names.
 *
 * Back is the part with real behaviour behind it. Telegram's BackButton is shown on every screen
 * that is not a root tab and hidden on the ones that are, and it calls the router's `back`, which
 * pops history when there is history and falls back to `parentRoute` when the app was opened
 * straight onto a deep link. Sheets take it over while they are open. Nothing else in the app
 * touches `Telegram.WebApp.BackButton`.
 */

const TAB_ICONS: Record<string, string> = {
  today: "☀️",
  tasks: "📋",
  week: "🗂",
  reminders: "🔔",
  settings: "⚙️",
};

export function Shell(): ReactNode {
  const route = useRoute();
  const navigate = useNavigate();
  const root = isRootRoute(route);

  useEffect(() => {
    if (root) {
      backButton.hide();
      return;
    }
    return backButton.show(navigate.back);
  }, [root, navigate.back]);

  return (
    <div className="ip-app">
      <ScreenOutlet route={route} />
      {root ? <TabBar route={route} /> : null}
    </div>
  );
}

function ScreenOutlet({ route }: { route: Route }): ReactNode {
  const Screen = screenFor(route.name);
  if (!Screen) return <MissingScreen route={route} />;
  return <Screen route={route} />;
}

/**
 * A route nobody implements yet, and the `notFound` route itself. They share a screen on purpose:
 * an id that the server scoped away and a link to a screen that does not exist read the same to the
 * user, and neither is an error.
 */
function MissingScreen({ route }: { route: Route }): ReactNode {
  const t = useT();
  return (
    <div className="ip-screen">
      <div className="ip-screen__body">
        {route.name === "notFound" ? <NotFoundState /> : <EmptyState icon="🚧" title={t("error.not_found_title")} body={t("common.nothing_here")} />}
      </div>
    </div>
  );
}

function TabBar({ route }: { route: Route }): ReactNode {
  const t = useT();
  const labels: Record<string, string> = {
    today: t("nav.today"),
    tasks: t("nav.tasks"),
    week: t("nav.week"),
    reminders: t("nav.reminders"),
    settings: t("nav.settings"),
  };

  return (
    <nav className="ip-tabbar" aria-label={t("common.app_name")}>
      {ROOT_ROUTES.map((tab) => (
        <Link key={tab.name} to={tab} replace className={`ip-tabbar__item${sameRoute(tab, route) || tab.name === route.name ? " ip-tabbar__item--active" : ""}`}>
          <span className="ip-tabbar__icon" aria-hidden="true">
            {TAB_ICONS[tab.name] ?? "•"}
          </span>
          <span>{labels[tab.name]}</span>
        </Link>
      ))}
    </nav>
  );
}

/** True when the app is running inside a Telegram client rather than a plain browser tab. */
export { isInsideTelegram };
