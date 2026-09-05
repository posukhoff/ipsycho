import { ApiRequestError, type ApiClient, type RequestOptions } from "../api/client.js";
import { ENDPOINTS, type EndpointName, type EndpointQuery, type EndpointResponse } from "../api/contracts.js";

/**
 * A small query cache: one entry per (endpoint, query, path params), shared by every component that
 * asks for it, with optimistic patching and rollback.
 *
 * It exists rather than a dependency because of the constraint in the proposal: every web package
 * lives in `devDependencies` so that `npm audit --omit=dev` and the production image stay
 * meaningful, and a data-fetching library is the kind of thing that quietly grows a runtime
 * dependency tree. What the screens actually need is four things — dedupe, a shared entry, an
 * optimistic patch with a rollback, and invalidation — and that is all this is.
 *
 * **Optimistic writes and Undo.** `patchEach` applies a change to every cached page of an endpoint
 * and hands back a rollback. A failed mutation calls it, so a row that could not be marked done
 * flips back rather than lying until the next refetch. That is also what makes the Undo snackbar
 * honest: the row moves at the tap, and `undoGroupId` from the response is what actually reverses
 * it on the server.
 *
 * **Retries.** Reads retry a network failure or a `503`; writes never do. A retried POST whose
 * outcome is unknown is exactly the ambiguity `AGENTS.md` forbids papering over — the screen
 * surfaces it and lets the user decide, and every write carries an expected version anyway, so a
 * duplicate would come back as a conflict rather than a second change.
 */

export type EntryStatus = "loading" | "success" | "error";

export interface CacheEntry<T = unknown> {
  readonly status: EntryStatus;
  readonly data: T | undefined;
  readonly error: unknown;
  /** True while a background refresh of an entry that already has data is in flight. */
  readonly refreshing: boolean;
  readonly updatedAt: number;
}

export interface QueryTarget<Name extends EndpointName = EndpointName> {
  /** Values for the `:segments` of the endpoint's path. */
  readonly params?: Readonly<Record<string, string>> | undefined;
  /**
   * The query string. `EndpointQuery<Name>` is the declared shape; the wider arm is what the
   * infinite hook needs when it adds a `page` to a query the caller built.
   */
  readonly query?: EndpointQuery<Name> | Readonly<Record<string, unknown>> | undefined;
}

type Listener = () => void;

interface InternalEntry {
  entry: CacheEntry;
  listeners: Set<Listener>;
  inFlight: Promise<unknown> | null;
}

/** Stable across key order, so `{scope, page}` and `{page, scope}` are one entry. */
function stable(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, item]) => `${key}=${stable(item)}`);
  return entries.join("&");
}

export function queryKey(name: EndpointName, target: QueryTarget<EndpointName> = {}): string {
  return `${name}|${stable(target.params)}|${stable(target.query)}`;
}

export interface RetryPolicy {
  /** Attempts after the first one. Reads only. */
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 2, baseDelayMs: 300, maxDelayMs: 4000 };

/** Transport failures and «try again later», never a refusal the user has to act on. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ApiRequestError) return error.code === "unavailable" || error.code === "internal";
  // A `TypeError` from `fetch` is the network being gone: the webview lost the connection while a
  // screen was open, which is the single most common failure in a Mini App.
  return error instanceof TypeError;
}

function delayFor(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * policy.baseDelayMs;
  return Math.min(exponential + jitter, policy.maxDelayMs);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class QueryCache {
  private readonly entries = new Map<string, InternalEntry>();

  constructor(
    private readonly client: ApiClient,
    private readonly policy: RetryPolicy = DEFAULT_RETRY,
  ) {}

  peek<Name extends EndpointName>(name: Name, target?: QueryTarget<Name>): CacheEntry<EndpointResponse<Name>> | undefined {
    return this.entries.get(queryKey(name, target))?.entry as CacheEntry<EndpointResponse<Name>> | undefined;
  }

  subscribe(name: EndpointName, target: QueryTarget<EndpointName> | undefined, listener: Listener): () => void {
    const key = queryKey(name, target);
    const internal = this.ensure(key);
    internal.listeners.add(listener);
    return () => {
      internal.listeners.delete(listener);
    };
  }

  /**
   * Reads an entry, fetching when it is missing or stale. Concurrent callers share one request.
   * `force` refetches an entry that already has data, keeping the old data visible meanwhile.
   */
  async load<Name extends EndpointName>(name: Name, target?: QueryTarget<Name>, options: { force?: boolean } = {}): Promise<EndpointResponse<Name>> {
    const key = queryKey(name, target);
    const internal = this.ensure(key);

    if (internal.inFlight) return internal.inFlight as Promise<EndpointResponse<Name>>;
    if (!options.force && internal.entry.status === "success") return internal.entry.data as EndpointResponse<Name>;

    const hasData = internal.entry.data !== undefined;
    this.write(key, { status: hasData ? "success" : "loading", data: internal.entry.data, error: undefined, refreshing: true, updatedAt: internal.entry.updatedAt });

    const request = this.fetchWithRetry(name, target)
      .then((data) => {
        this.write(key, { status: "success", data, error: undefined, refreshing: false, updatedAt: Date.now() });
        return data;
      })
      .catch((cause: unknown) => {
        this.write(key, { status: "error", data: internal.entry.data, error: cause, refreshing: false, updatedAt: Date.now() });
        throw cause;
      })
      .finally(() => {
        internal.inFlight = null;
      });

    internal.inFlight = request;
    return request;
  }

  /** Replaces one entry's data outright, e.g. with the object a mutation answered with. */
  set<Name extends EndpointName>(name: Name, target: QueryTarget<Name> | undefined, data: EndpointResponse<Name>): void {
    this.write(queryKey(name, target), { status: "success", data, error: undefined, refreshing: false, updatedAt: Date.now() });
  }

  /**
   * Applies `update` to every cached entry of `name` — every page of a list included — and returns
   * the rollback. `update` may return the value it was given to leave that entry alone.
   */
  patchEach<Name extends EndpointName>(name: Name, update: (data: EndpointResponse<Name>) => EndpointResponse<Name>): () => void {
    const prefix = `${name}|`;
    const previous: Array<[string, CacheEntry]> = [];

    for (const [key, internal] of this.entries) {
      if (!key.startsWith(prefix) || internal.entry.data === undefined) continue;
      const next = update(internal.entry.data as EndpointResponse<Name>);
      if (next === internal.entry.data) continue;
      previous.push([key, internal.entry]);
      this.write(key, { ...internal.entry, data: next, updatedAt: Date.now() });
    }

    return () => {
      for (const [key, entry] of previous) this.write(key, entry);
    };
  }

  /** Marks entries stale and refetches the ones somebody is watching. */
  invalidate(names: readonly EndpointName[]): void {
    for (const name of names) {
      const prefix = `${name}|`;
      for (const [key, internal] of this.entries) {
        if (!key.startsWith(prefix)) continue;
        if (internal.listeners.size === 0) {
          this.entries.delete(key);
          continue;
        }
        void this.reload(name, key).catch(() => undefined);
      }
    }
  }

  /** Drops everything. Used when the identity behind the requests may have changed. */
  clear(): void {
    for (const [key, internal] of this.entries) {
      internal.entry = { status: "loading", data: undefined, error: undefined, refreshing: false, updatedAt: 0 };
      for (const listener of internal.listeners) listener();
      if (internal.listeners.size === 0) this.entries.delete(key);
    }
  }

  private async reload(name: EndpointName, key: string): Promise<void> {
    const target = this.targets.get(key);
    await this.load(name, target, { force: true });
  }

  /** The `params`/`query` an entry was created with, so `invalidate` can refetch it. */
  private readonly targets = new Map<string, QueryTarget<EndpointName> | undefined>();

  private ensure(key: string): InternalEntry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const created: InternalEntry = {
      entry: { status: "loading", data: undefined, error: undefined, refreshing: false, updatedAt: 0 },
      listeners: new Set(),
      inFlight: null,
    };
    this.entries.set(key, created);
    return created;
  }

  private write(key: string, entry: CacheEntry): void {
    const internal = this.ensure(key);
    internal.entry = entry;
    for (const listener of internal.listeners) listener();
  }

  private async fetchWithRetry<Name extends EndpointName>(name: Name, target?: QueryTarget<Name>): Promise<EndpointResponse<Name>> {
    this.targets.set(queryKey(name, target), target);
    const idempotent = ENDPOINTS[name].method === "GET";
    let attempt = 0;

    for (;;) {
      try {
        return await this.client.request(name, this.toRequest(target));
      } catch (cause) {
        if (!idempotent || attempt >= this.policy.retries || !isRetryable(cause)) throw cause;
        await sleep(delayFor(attempt, this.policy));
        attempt += 1;
      }
    }
  }

  private toRequest<Name extends EndpointName>(target?: QueryTarget<Name>): RequestOptions<Name> {
    // Reads never carry a body, and every read endpoint's query schema has defaults, so the cast is
    // over the optionality of the fields rather than over their types.
    return { ...(target?.params ? { params: target.params } : {}), ...(target?.query !== undefined ? { query: target.query } : {}) } as RequestOptions<Name>;
  }
}
