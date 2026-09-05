import {
  API_ERROR_MESSAGES,
  API_PREFIX,
  ENDPOINTS,
  ErrorEnvelopeSchema,
  type ApiErrorCode,
  type EndpointBody,
  type EndpointName,
  type EndpointQuery,
  type EndpointResponse,
  type ErrorDetails,
} from "./contracts.js";

/**
 * The typed transport. Every call names an endpoint from `ENDPOINTS`, and the request body, the
 * query and the response type all follow from that name — so a screen cannot call `/tasks/:id`
 * without an id, or send a create body to the reschedule route.
 *
 * Three decisions worth knowing before you use it:
 *
 * - **Authorization is raw `initData`, on every request.** There is no session, no cookie and no
 *   refresh: the server verifies the Telegram signature each time and re-resolves the allowlist, so
 *   disabling a user takes effect on the next call. `initData` is a credential; it is never put in
 *   a URL, never logged, and never stored anywhere but memory.
 * - **The error envelope is parsed, not guessed.** A failure arrives as `ApiRequestError` with the
 *   code from the closed set, so a screen branches on `error.code === "conflict"` and never on a
 *   message. The message the server sends is diagnostic English; the sentence a user reads comes
 *   from the client dictionary.
 * - **Mock mode is a transport swap, not a code path.** With `VITE_API_MOCK=1` the same typed call
 *   is answered from `src/mocks/`, so groups 5–8 build every screen with no backend running and
 *   without a single `if (mock)` inside a component.
 */

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    readonly details?: ErrorDetails,
  ) {
    super(`${code}: ${API_ERROR_MESSAGES[code]}`);
    this.name = "ApiRequestError";
  }

  /** The one case a screen must handle rather than report: the row moved under it. */
  get isConflict(): boolean {
    return this.code === "conflict";
  }

  /** A deep link to somebody else's id is scoped away into a not-found, never an error screen. */
  get isNotFound(): boolean {
    return this.code === "not_found";
  }

  get currentVersion(): number | null {
    return this.details?.kind === "conflict" ? this.details.currentVersion : null;
  }
}

export type PathParams = Readonly<Record<string, string>>;

type HasKey<Name extends EndpointName, Key extends string> = Key extends keyof (typeof ENDPOINTS)[Name] ? true : false;

export type RequestOptions<Name extends EndpointName> = {
  /** Values for the `:segments` of the endpoint's path. */
  params?: PathParams;
  signal?: AbortSignal;
  /** Optional even where the endpoint declares one: every query schema has defaults. */
  query?: HasKey<Name, "query"> extends true ? EndpointQuery<Name> : undefined;
} & (HasKey<Name, "body"> extends true ? { body: EndpointBody<Name> } : { body?: undefined });

export interface ApiClientOptions {
  /** Returns the raw `initData` string. Null while the SDK has not produced one yet. */
  initData: () => string | null;
  /** Same-origin by default; `VITE_API_BASE` points a dev server at a remote API. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Parses every response against its schema. On in development, off in a production build. */
  validateResponses?: boolean;
}

export interface ApiClient {
  request<Name extends EndpointName>(name: Name, options?: RequestOptions<Name>): Promise<EndpointResponse<Name>>;
}

const MOCK_MODE = import.meta.env.VITE_API_MOCK === "1";

export function buildPath(template: string, params: PathParams = {}): string {
  return template.replace(/:([A-Za-z0-9_]+)/gu, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing path parameter ${key}`);
    return encodeURIComponent(value);
  });
}

export function buildQuery(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/u, "");
  const validate = options.validateResponses ?? import.meta.env.DEV;

  return {
    async request<Name extends EndpointName>(name: Name, request?: RequestOptions<Name>): Promise<EndpointResponse<Name>> {
      const endpoint = ENDPOINTS[name];
      const path = buildPath(endpoint.path, request?.params);
      const query = buildQuery(request?.query);

      if (MOCK_MODE) {
        const { mockRequest } = await import("../mocks/index.js");
        return (await mockRequest(name, { params: request?.params, query: request?.query, body: request?.body })) as EndpointResponse<Name>;
      }

      const initData = options.initData();
      if (!initData) throw new ApiRequestError("unauthorized", 401);

      const headers: Record<string, string> = { Authorization: `tma ${initData}`, Accept: "application/json" };
      const hasBody = request?.body !== undefined;
      if (hasBody) headers["Content-Type"] = "application/json";

      const response = await doFetch(`${baseUrl}${API_PREFIX}${path}${query}`, {
        method: endpoint.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(request?.body) } : {}),
        ...(request?.signal ? { signal: request.signal } : {}),
        // No cookie is ever sent: there is no session, and omitting them keeps the API immune to
        // anything a webview may have stored under this origin.
        credentials: "omit",
        cache: "no-store",
      });

      const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);

      if (!response.ok) throw toRequestError(payload, response.status);
      if (!validate) return payload as EndpointResponse<Name>;
      return endpoint.response.parse(payload) as EndpointResponse<Name>;
    },
  };
}

function toRequestError(payload: unknown, status: number): ApiRequestError {
  const parsed = ErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return new ApiRequestError(status === 401 ? "unauthorized" : "internal", status);
  const { code, details } = parsed.data.error;
  return new ApiRequestError(code, status, details);
}
