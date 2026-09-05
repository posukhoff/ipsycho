import { useState, type ReactNode } from "react";
import type { TaskGroup, TaskListRow, TaskScope } from "../../api/contracts.js";
import { useNavigate, type RouteOf } from "../../app/index.js";
import { useT, type Translator } from "../../i18n/index.js";
import { useInfiniteQuery, useQuery } from "../../lib/index.js";
import { Button, EmptyState, ErrorState, IconButton, InfiniteSentinel, ListRow, Pill, Screen, ScreenHeader, Section, SkeletonList, Tabs, type TabItem } from "../../ui/index.js";
import { TASK_SCOPE_KEYS, importanceText, occurrenceStatusText, scheduleLine } from "./schedule-text.js";

/**
 * The task list.
 *
 * Three things it does that `/tasks` in the chat could not:
 *
 * - **It scrolls.** The bot paged eight lines at a time because a message has a size; a list does
 *   not. `useInfiniteQuery` keeps every page as its own cache entry, so an optimistic patch made on
 *   page four survives the same way one made on page one does.
 * - **A tab knows what the other tabs hold.** `counts` comes from the server with the page, so the
 *   badges say what «просрочено» contains without loading it.
 * - **A repeat expands in place.** `groupTaskRows` is still the only implementation of the
 *   grouping; the bot drew the group as one line with a «▸ ещё N», and this draws the same group
 *   with its dates underneath.
 *
 * Paused series get a row of their own rather than a tab: they sit in no date window at all, which
 * is exactly why the bot hid them behind a separate screen.
 */

const SCOPES: readonly TaskScope[] = ["overdue", "today", "week", "month", "all", "nodate"];

export function TasksScreen({ route }: { route: RouteOf<"tasks"> }): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<readonly string[]>([]);

  const query = { scope: route.scope };
  // The same cache entry the infinite list's first page uses, so the badges cost no extra request.
  const head = useQuery("taskList", { query: { ...query, page: 0 } });
  const list = useInfiniteQuery("taskList", { query, items: (data) => data.groups });

  const counts = head.data?.counts;
  const tabs: readonly TabItem<TaskScope>[] = SCOPES.map((scope) => ({
    value: scope,
    label: t(TASK_SCOPE_KEYS[scope]),
    count: counts?.[scope],
    alarming: scope === "overdue",
  }));

  const todayLocalDate = head.data?.todayLocalDate;
  const pausedCount = head.data?.pausedCount ?? 0;

  return (
    <Screen header={<ScreenHeader title={t("tasks.title")} actions={<IconButton label={t("tasks.new")} icon="＋" onClick={() => navigate.push({ name: "taskNew" })} />} />}>
      <Tabs value={route.scope} items={tabs} onChange={(scope) => navigate.replace({ name: "tasks", scope })} />

      {pausedCount > 0 ? (
        <Section>
          <ListRow title={t("tasks.paused_series", { count: pausedCount })} to={{ name: "pausedSeries" }} chevron />
        </Section>
      ) : null}

      {list.isLoading ? <SkeletonList /> : null}

      {!list.isLoading && list.items.length === 0 && list.error !== undefined ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}

      {!list.isLoading && list.items.length === 0 && list.error === undefined ? (
        <EmptyState
          icon="📭"
          title={t("tasks.empty_scope")}
          action={
            <Button variant="primary" onClick={() => navigate.push({ name: "taskNew" })}>
              {t("tasks.new")}
            </Button>
          }
        />
      ) : null}

      {list.items.length > 0 && todayLocalDate ? (
        <Section>
          {list.items.map((group) => (
            <GroupRows
              key={group.key}
              group={group}
              todayLocalDate={todayLocalDate}
              expanded={expanded.includes(group.key)}
              onToggle={() => setExpanded((keys) => (keys.includes(group.key) ? keys.filter((key) => key !== group.key) : [...keys, group.key]))}
              t={t}
            />
          ))}
        </Section>
      ) : null}

      <InfiniteSentinel hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} label={t("tasks.load_more")} />
    </Screen>
  );
}

function GroupRows({
  group,
  todayLocalDate,
  expanded,
  onToggle,
  t,
}: {
  group: TaskGroup;
  todayLocalDate: string;
  expanded: boolean;
  onToggle: () => void;
  t: Translator;
}): ReactNode {
  const lead = group.rows[group.leadIndex] ?? group.rows[0];
  if (!lead) return null;
  const hidden = group.rows.length - 1;

  return (
    <>
      <TaskRow row={lead} todayLocalDate={todayLocalDate} t={t} {...(group.recurrenceRule && !expanded && hidden > 0 ? { prefix: t("tasks.group_next") } : {})} />
      {expanded ? group.rows.filter((row) => row !== lead).map((row) => <TaskRow key={row.occurrenceId ?? row.taskId} row={row} todayLocalDate={todayLocalDate} t={t} />) : null}
      {hidden > 0 ? <ListRow title={expanded ? t("tasks.group_collapse") : t("tasks.group_dates", { count: hidden })} onClick={onToggle} muted /> : null}
    </>
  );
}

function TaskRow({ row, todayLocalDate, t, prefix }: { row: TaskListRow; todayLocalDate: string; t: Translator; prefix?: string | undefined }): ReactNode {
  const schedule = scheduleLine(row, todayLocalDate, t);
  const subtitle = [prefix, schedule].filter(Boolean).join(" ");

  return (
    <ListRow
      title={row.title}
      subtitle={subtitle}
      muted={row.occurrenceStatus === "done" || row.occurrenceStatus === "cancelled" || row.occurrenceStatus === "skipped"}
      meta={
        <>
          {row.overdue ? <Pill tone="danger">{t("task.overdue")}</Pill> : null}
          {row.importance === "normal" ? null : <Pill tone={row.importance === "critical" ? "danger" : "accent"}>{importanceText(row.importance, t)}</Pill>}
          {row.occurrenceStatus && row.occurrenceStatus !== "scheduled" && row.occurrenceStatus !== "open" ? (
            <span className="ip-small ip-muted">{occurrenceStatusText(row.occurrenceStatus, t)}</span>
          ) : null}
        </>
      }
      to={{ name: "task", id: row.occurrenceId ?? row.taskId }}
      chevron
    />
  );
}
