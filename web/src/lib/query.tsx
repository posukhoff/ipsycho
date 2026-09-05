import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ApiRequestError, type ApiClient, type RequestOptions } from "../api/client.js";
import type { EndpointName, EndpointResponse, PageInfo } from "../api/contracts.js";
import { QueryCache, queryKey, type CacheEntry, type QueryTarget } from "./query-cache.js";
import { haptics } from "./telegram.js";

/**
 * The React face of the cache: `useQuery`, `useInfiniteQuery`, `useMutation`.
 *
 * Screens never touch `ApiClient` directly. They name an endpoint and get back a state machine
 * that is already shared with every other component asking for the same thing, so the today screen
 * and the tab badge do not fetch the list twice.
 */

interface ApiContextValue {
  readonly client: ApiClient;
  readonly cache: QueryCache;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }): ReactNode {
  const value = useMemo<ApiContextValue>(() => ({ client, cache: new QueryCache(client) }), [client]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

function useApiContext(): ApiContextValue {
  const value = useContext(ApiContext);
  if (!value) throw new Error("ApiProvider is missing above this component");
  return value;
}

export function useApiClient(): ApiClient {
  return useApiContext().client;
}

export function useQueryCache(): QueryCache {
  return useApiContext().cache;
}

const EMPTY_ENTRY: CacheEntry = { status: "loading", data: undefined, error: undefined, refreshing: false, updatedAt: 0 };

export interface QueryResult<Name extends EndpointName> {
  readonly data: EndpointResponse<Name> | undefined;
  readonly error: unknown;
  /** No data yet and a request is in flight. A skeleton belongs here. */
  readonly isLoading: boolean;
  /** Data is on screen and a refresh is in flight. A spinner in the header belongs here. */
  readonly isRefreshing: boolean;
  /**
   * The deep link named something this workspace cannot see. A screen renders `<NotFound/>` — not
   * an error state: the fragment is attacker-influenced, and server scoping is what answered.
   */
  readonly isNotFound: boolean;
  readonly refetch: () => Promise<void>;
}

/**
 * One endpoint, one entry. `target` may be rebuilt on every render; only its contents matter.
 * `enabled: false` holds the request back — a detail screen that has no id yet, for instance.
 */
export function useQuery<Name extends EndpointName>(name: Name, target?: QueryTarget<Name>, options: { enabled?: boolean | undefined } = {}): QueryResult<Name> {
  const { cache } = useApiContext();
  const enabled = options.enabled !== false;
  const key = queryKey(name, target);

  const targetRef = useRef(target);
  targetRef.current = target;

  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(name, targetRef.current, listener),
    // `key` is the identity of the entry; `target` itself is a fresh object every render.
    [cache, name, key],
  );

  const entry = useSyncExternalStore(
    subscribe,
    () => cache.peek(name, targetRef.current) ?? EMPTY_ENTRY,
    () => EMPTY_ENTRY,
  );

  useEffect(() => {
    if (!enabled) return;
    void cache.load(name, targetRef.current).catch(() => undefined);
  }, [cache, name, key, enabled]);

  const refetch = useCallback(async () => {
    await cache.load(name, targetRef.current, { force: true }).catch(() => undefined);
  }, [cache, name, key]);

  return {
    data: entry.data as EndpointResponse<Name> | undefined,
    error: entry.error,
    isLoading: enabled && entry.data === undefined && entry.status !== "error",
    isRefreshing: entry.refreshing && entry.data !== undefined,
    isNotFound: entry.error instanceof ApiRequestError && entry.error.isNotFound,
    refetch,
  };
}

/* --------------------------------------------------------------- infinite */

/** Every paged endpoint answers with a `page: PageInfo`; only those can be scrolled infinitely. */
export type PagedEndpointName = { [Name in EndpointName]: EndpointResponse<Name> extends { page: PageInfo } ? Name : never }[EndpointName];

export interface InfiniteResult<Item> {
  readonly items: readonly Item[];
  readonly page: PageInfo | undefined;
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly isLoadingMore: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly refresh: () => void;
}

/**
 * The infinite list behind the tasks, reminders, goals and memory screens.
 *
 * Each page is an ordinary cache entry, which is what makes an optimistic patch work on a list the
 * user has scrolled: `patchEach` reaches page 4 the same way it reaches page 0.
 */
export function useInfiniteQuery<Name extends PagedEndpointName, Item>(
  name: Name,
  options: { query?: Record<string, unknown>; items: (data: EndpointResponse<Name>) => readonly Item[]; enabled?: boolean | undefined },
): InfiniteResult<Item> {
  const { cache } = useApiContext();
  const enabled = options.enabled !== false;
  const baseKey = queryKey(name, { query: options.query });
  const [pageCount, setPageCount] = useState(1);
  const [, bump] = useReducer((tick: number) => tick + 1, 0);

  const queryRef = useRef(options.query);
  queryRef.current = options.query;
  const itemsRef = useRef(options.items);
  itemsRef.current = options.items;

  const targetFor = useCallback((page: number): QueryTarget<Name> => ({ query: { ...queryRef.current, page } }), []);

  useEffect(() => {
    setPageCount(1);
  }, [baseKey]);

  useEffect(() => {
    if (!enabled) return;
    const offs: Array<() => void> = [];
    for (let page = 0; page < pageCount; page += 1) {
      offs.push(cache.subscribe(name, targetFor(page), bump));
      void cache.load(name, targetFor(page)).catch(() => undefined);
    }
    return () => {
      for (const off of offs) off();
    };
  }, [cache, name, baseKey, pageCount, enabled, targetFor]);

  const entries: Array<CacheEntry<EndpointResponse<Name>>> = [];
  for (let page = 0; page < pageCount; page += 1) entries.push(cache.peek(name, targetFor(page)) ?? (EMPTY_ENTRY as CacheEntry<EndpointResponse<Name>>));

  const items: Item[] = [];
  let lastPage: PageInfo | undefined;
  for (const entry of entries) {
    if (entry.data === undefined) continue;
    items.push(...itemsRef.current(entry.data));
    lastPage = (entry.data as { page: PageInfo }).page;
  }

  const first = entries[0];
  const last = entries[entries.length - 1];

  const loadMore = useCallback(() => {
    setPageCount((count) => {
      const current = cache.peek(name, targetFor(count - 1));
      const info = current?.data === undefined ? undefined : (current.data as { page: PageInfo }).page;
      return info?.hasMore ? count + 1 : count;
    });
  }, [cache, name, targetFor]);

  const refresh = useCallback(() => {
    setPageCount(1);
    void cache.load(name, targetFor(0), { force: true }).catch(() => undefined);
  }, [cache, name, targetFor]);

  return {
    items,
    page: lastPage,
    error: first?.error ?? last?.error,
    isLoading: enabled && items.length === 0 && first?.data === undefined && first?.status !== "error",
    isLoadingMore: pageCount > 1 && last?.data === undefined,
    hasMore: lastPage?.hasMore ?? false,
    loadMore,
    refresh,
  };
}

/* --------------------------------------------------------------- mutations */

export interface MutationOptions<Name extends EndpointName> {
  /**
   * Applies the change to the cache before the request leaves, and returns the rollback. Use
   * `cache.patchEach` inside it; the rollback runs automatically when the request fails.
   */
  readonly optimistic?: (vars: RequestOptions<Name>, cache: QueryCache) => (() => void) | void;
  /** Endpoints whose cached entries are refetched after a success. */
  readonly invalidate?: readonly EndpointName[];
  readonly onSuccess?: (data: EndpointResponse<Name>, vars: RequestOptions<Name>) => void;
  readonly onError?: (error: unknown, vars: RequestOptions<Name>) => void;
  /** A success or failure buzz. On by default; turn it off for a write the user did not initiate. */
  readonly haptic?: boolean | undefined;
}

export interface MutationResult<Name extends EndpointName> {
  /** Resolves with the response, or with `undefined` when the write failed — it never rejects. */
  readonly mutate: (vars: RequestOptions<Name>) => Promise<EndpointResponse<Name> | undefined>;
  readonly isPending: boolean;
  readonly error: unknown;
  /** The conflict the version guard produced, if the last failure was one. */
  readonly conflict: ApiRequestError | null;
  readonly reset: () => void;
}

/**
 * A write.
 *
 * `mutate` resolves rather than rejects, so a fire-and-forget tap on a list row cannot become an
 * unhandled rejection in the webview. The failure is in `error`, was passed to `onError`, and the
 * optimistic patch has already been rolled back by the time either is observed.
 */
export function useMutation<Name extends EndpointName>(name: Name, options: MutationOptions<Name> = {}): MutationResult<Name> {
  const { client, cache } = useApiContext();
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mutate = useCallback(
    async (vars: RequestOptions<Name>): Promise<EndpointResponse<Name> | undefined> => {
      const current = optionsRef.current;
      const rollback = current.optimistic?.(vars, cache) ?? undefined;
      setPending(true);
      setError(undefined);
      try {
        const data = await client.request(name, vars);
        if (current.invalidate?.length) cache.invalidate(current.invalidate);
        if (current.haptic !== false) haptics.notify("success");
        current.onSuccess?.(data, vars);
        return data;
      } catch (cause: unknown) {
        rollback?.();
        setError(cause);
        if (current.haptic !== false) haptics.notify("error");
        current.onError?.(cause, vars);
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [client, cache, name],
  );

  const reset = useCallback(() => setError(undefined), []);

  return { mutate, isPending, error, conflict: error instanceof ApiRequestError && error.isConflict ? error : null, reset };
}
