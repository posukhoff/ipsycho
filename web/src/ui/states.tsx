import type { ReactNode } from "react";
import { ApiRequestError } from "../api/client.js";
import { useT } from "../i18n/index.js";
import type { QueryResult } from "../lib/query.js";
import type { EndpointName, EndpointResponse } from "../api/contracts.js";
import { Button } from "./primitives.js";

/**
 * Empty, error, not-found and loading.
 *
 * The distinction the whole change turns on is between **not found** and **error**. A fragment is
 * attacker-influenced whenever a link is shared (design.md § 1), so a request for somebody else's
 * id comes back as `not_found` — by design, so the API cannot be used to enumerate what exists.
 * The client must render that as «ничего нет», calmly, because for the user it usually means the
 * thing was deleted. An error screen with a retry button would be both wrong and alarming.
 */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode | undefined;
  title: ReactNode;
  body?: ReactNode | undefined;
  action?: ReactNode | undefined;
}): ReactNode {
  return (
    <div className="ip-empty">
      {icon ? <div className="ip-empty__icon">{icon}</div> : null}
      <h2 className="ip-empty__title">{title}</h2>
      {body ? <p className="ip-empty__body">{body}</p> : null}
      {action}
    </div>
  );
}

/** Everything that is not a not-found: offline, 500, a refused write. Always offers a retry. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }): ReactNode {
  const t = useT();
  return (
    <EmptyState
      icon="⚠️"
      title={t("error.title")}
      body={t.error(error)}
      action={
        onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {t("error.retry")}
          </Button>
        ) : null
      }
    />
  );
}

export function NotFoundState({ action }: { action?: ReactNode | undefined }): ReactNode {
  const t = useT();
  return <EmptyState icon="🕳" title={t("error.not_found_title")} body={t("error.not_found_body")} action={action} />;
}

/** The version guard fired: the row moved under the screen. Refetch, do not merge silently. */
export function ConflictNotice({ onReload }: { onReload: () => void }): ReactNode {
  const t = useT();
  return (
    <div className="ip-card ip-card--padded ip-stack">
      <strong>{t("error.conflict_title")}</strong>
      <span className="ip-muted ip-small">{t("error.conflict_body")}</span>
      <Button variant="primary" onClick={onReload}>
        {t("error.conflict_reload")}
      </Button>
    </div>
  );
}

export function Skeleton({ width = "100%", height = 16, radius }: { width?: number | string; height?: number | string; radius?: number | undefined }): ReactNode {
  return <div className="ip-skeleton" style={{ width, height, ...(radius === undefined ? {} : { borderRadius: radius }) }} />;
}

export function SkeletonList({ rows = 5 }: { rows?: number | undefined }): ReactNode {
  return (
    <div className="ip-card">
      <div className="ip-row-group">
        {Array.from({ length: rows }, (_, index) => (
          <div className="ip-row" key={index}>
            <div className="ip-row__main ip-stack" style={{ gap: "var(--space-2)" }}>
              <Skeleton width={`${55 + ((index * 13) % 35)}%`} />
              <Skeleton width="35%" height={12} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The four states of a read, in one place.
 *
 * ```tsx
 * <AsyncContent query={task}>{(data) => <TaskCard task={data} />}</AsyncContent>
 * ```
 *
 * A screen that renders this cannot forget the not-found path, which is exactly the failure the
 * deep-link rule is about.
 */
export function AsyncContent<Name extends EndpointName>({
  query,
  children,
  skeleton,
  notFound,
}: {
  query: QueryResult<Name>;
  children: (data: EndpointResponse<Name>) => ReactNode;
  skeleton?: ReactNode | undefined;
  notFound?: ReactNode | undefined;
}): ReactNode {
  if (query.data !== undefined) return children(query.data);
  if (query.isNotFound) return notFound ?? <NotFoundState />;
  if (query.error !== undefined) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.isLoading) return skeleton ?? <SkeletonList />;
  return null;
}

/** True when a failure should be shown as «ничего нет» rather than as a problem. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.isNotFound;
}
