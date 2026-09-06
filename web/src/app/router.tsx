import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { haptics } from "../lib/telegram.js";
import { DEFAULT_ROUTE, parentRoute, parseRoute, routeHref, routePath, sameRoute, withoutLaunchParams, type Route } from "./routes.js";

/**
 * The fragment router.
 *
 * It is `history.pushState` on the hash rather than a router package for the same reason the query
 * cache is hand-rolled: every web dependency lives in `devDependencies`, and the whole routing need
 * here is fifteen screens with no nested layouts.
 *
 * The part worth reading is `back`. A Mini App is entered three ways — from the menu button, from a
 * deep link in a reminder, and from Telegram's own back gesture — and only the first has a history
 * stack. `depth` is carried in `history.state`, so a screen opened directly by a link knows it has
 * nothing to pop and falls back to `parentRoute` instead of leaving the user staring at a dead
 * back button. Sheets register an interceptor and close instead of navigating.
 */

interface RouterValue {
  readonly route: Route;
  readonly depth: number;
  readonly push: (route: Route) => void;
  readonly replace: (route: Route) => void;
  readonly back: () => void;
  readonly canGoBack: boolean;
  readonly pushInterceptor: (handler: () => void) => () => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentRoute(): Route {
  return parseRoute(window.location.hash);
}

function currentDepth(): number {
  const state = window.history.state as { depth?: unknown } | null;
  return typeof state?.depth === "number" ? state.depth : 0;
}

function urlFor(route: Route): string {
  return `${window.location.pathname}${window.location.search}${routeHref(route)}`;
}

export function RouterProvider({ initialRoute, children }: { initialRoute?: Route | undefined; children: ReactNode }): ReactNode {
  const [route, setRoute] = useState<Route>(() => {
    const fromUrl = withoutLaunchParams(window.location.hash) ? currentRoute() : null;
    return fromUrl ?? initialRoute ?? DEFAULT_ROUTE;
  });
  const [depth, setDepth] = useState(currentDepth);
  const interceptors = useRef<Array<() => void>>([]);

  // The launch URL may carry no route at all: the menu button opens the bare app, and Telegram's
  // own launch parameters are not one. Stamp the resolved route in so a reload lands on the same
  // screen, `depth` starts at a known 0, and the parameter blob leaves the address bar.
  useEffect(() => {
    if (!withoutLaunchParams(window.location.hash)) window.history.replaceState({ depth: 0 }, "", urlFor(route));
    // Intentionally once, on mount: this is about the entry URL, not about later navigation.
  }, []);

  useEffect(() => {
    const sync = (): void => {
      setRoute(currentRoute());
      setDepth(currentDepth());
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const push = useCallback((next: Route) => {
    if (sameRoute(next, currentRoute())) return;
    const nextDepth = currentDepth() + 1;
    window.history.pushState({ depth: nextDepth }, "", urlFor(next));
    setRoute(next);
    setDepth(nextDepth);
  }, []);

  const replace = useCallback((next: Route) => {
    window.history.replaceState({ depth: currentDepth() }, "", urlFor(next));
    setRoute(next);
  }, []);

  const back = useCallback(() => {
    const interceptor = interceptors.current[interceptors.current.length - 1];
    if (interceptor) {
      interceptor();
      return;
    }
    if (currentDepth() > 0) {
      window.history.back();
      return;
    }
    const parent = parentRoute(currentRoute());
    if (parent) replace(parent);
  }, [replace]);

  const pushInterceptor = useCallback((handler: () => void) => {
    interceptors.current.push(handler);
    return () => {
      interceptors.current = interceptors.current.filter((item) => item !== handler);
    };
  }, []);

  const value = useMemo<RouterValue>(
    () => ({ route, depth, push, replace, back, canGoBack: depth > 0 || parentRoute(route) !== null, pushInterceptor }),
    [route, depth, push, replace, back, pushInterceptor],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("RouterProvider is missing above this component");
  return value;
}

export function useRoute(): Route {
  return useRouter().route;
}

export interface Navigator {
  readonly push: (route: Route) => void;
  readonly replace: (route: Route) => void;
  readonly back: () => void;
  readonly canGoBack: boolean;
}

export function useNavigate(): Navigator {
  const { push, replace, back, canGoBack } = useRouter();
  return useMemo(() => ({ push, replace, back, canGoBack }), [push, replace, back, canGoBack]);
}

/**
 * Takes over back — the native BackButton, the Android gesture and the shell's own arrow — while
 * the component is mounted. A sheet uses it to close instead of navigating away.
 */
export function useBackInterceptor(handler: (() => void) | null): void {
  const { pushInterceptor } = useRouter();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!handler) return;
    return pushInterceptor(() => handlerRef.current?.());
  }, [pushInterceptor, handler === null]);
}

/**
 * A link that navigates without a page load. It renders a real `<a href="#/…">`, so long-press and
 * «open in a new tab» still behave in a browser tab, and the fragment stays copyable.
 */
export function Link({
  to,
  replace,
  className,
  children,
  onNavigate,
}: {
  to: Route;
  replace?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
  onNavigate?: () => void;
}): ReactNode {
  const navigate = useNavigate();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    haptics.select();
    onNavigate?.();
    if (replace) navigate.replace(to);
    else navigate.push(to);
  };
  return (
    <a href={routeHref(to)} className={className} onClick={handleClick}>
      {children}
    </a>
  );
}

export { routePath };
