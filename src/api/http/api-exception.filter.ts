import { Catch, HttpException, type ArgumentsHost } from "@nestjs/common";
import { BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import { ZodError } from "zod";
import { API_ERROR_STATUS, API_PREFIX, ErrorEnvelopeSchema, type ApiErrorCode } from "../contracts/index.js";
import { isDomainRuleError } from "../../core/errors.js";
import { logger } from "../../observability/logger.js";
import { safeError } from "../../observability/safe-error.js";
import { ApiError, buildEnvelope, safeFieldPath } from "./api-error.js";

/**
 * One error shape for `/api/v1`, and the framework's own shape for everything else.
 *
 * The delegation is the point. This filter is registered inside `ApiModule`, and a Nest filter
 * registered through `APP_FILTER` is application-wide however narrowly it is declared — so without
 * the path check, turning `WEBAPP_ENABLED` on would quietly change what `/ready` returns to Docker's
 * healthcheck. Anything outside the API prefix goes straight to `BaseExceptionFilter`, unchanged.
 *
 * Nothing derived from the exception's own message reaches the client. A `DomainRuleError` becomes
 * its code and nothing else; every other failure becomes a bare `internal`. The message is logged,
 * through `safeError`, which is where it is useful and where it is already redacted.
 */
@Catch()
export class ApiExceptionFilter extends BaseExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const adapter = this.adapterHost.httpAdapter;
    const request = http.getRequest<unknown>();
    const path = requestPath(adapter.getRequestUrl(request));

    if (!path.startsWith(API_PREFIX)) {
      super.catch(exception, host);
      return;
    }

    const { code, envelope } = translate(exception);
    const status = API_ERROR_STATUS[code];
    if (status >= 500) logger.error("api request failed", { path, code, status, error: safeError(exception) });
    else logger.warn("api request refused", { path, code, status });

    adapter.reply(http.getResponse<unknown>(), envelope, status);
  }
}

function requestPath(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

function translate(exception: unknown): { code: ApiErrorCode; envelope: ReturnType<typeof buildEnvelope> } {
  if (exception instanceof ApiError) return { code: exception.code, envelope: buildEnvelope(exception.code, exception.details) };

  // A zod error that escaped the pipe: a presenter built a response the contract refuses. That is a
  // server fault, not the caller's, so it is a 500 — but the field paths still help the log.
  if (exception instanceof ZodError) {
    logger.error("api response failed its own contract", { fields: exception.issues.map((issue) => safeFieldPath(issue.path.join("."))).filter(Boolean) });
    return { code: "internal", envelope: buildEnvelope("internal") };
  }

  if (isDomainRuleError(exception)) {
    const error = ApiError.domainRule(exception.code ?? "domain_rule");
    return { code: error.code, envelope: buildEnvelope(error.code, error.details) };
  }

  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    // A controller may already have produced the envelope (ApiError does); pass it through as is.
    const parsed = ErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) return { code: parsed.data.error.code, envelope: parsed.data };
    const code = codeForStatus(exception.getStatus());
    return { code, envelope: buildEnvelope(code) };
  }

  return { code: "internal", envelope: buildEnvelope("internal") };
}

/** A framework exception (a 404 from the router, a 413 from the body parser) gets our vocabulary. */
function codeForStatus(status: number): ApiErrorCode {
  if (status === 400 || status === 413 || status === 415 || status === 422) return "validation_failed";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  return "internal";
}
