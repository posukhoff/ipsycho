import { useState, type ReactNode } from "react";
import type { PausedSeriesRow } from "../../api/contracts.js";
import { useT, type Translator } from "../../i18n/index.js";
import { instantToLocalDate, useInfiniteQuery, useMutation } from "../../lib/index.js";
import { ConfirmSheet, EmptyState, ErrorState, InfiniteSentinel, ListRow, Screen, ScreenHeader, Section, SkeletonList, useToast, useUndo } from "../../ui/index.js";
import { useTodayLocalDate } from "../../app/index.js";
import { dayText, recurrenceLine } from "./schedule-text.js";

/**
 * The paused series.
 *
 * They have their own screen for the same reason the bot gave them one: a paused series sits in no
 * date window at all — the parent task is `paused` and its future dates were cancelled — so no
 * filter on the task list would ever show it, and a series nobody can find is a series that stays
 * paused for a year.
 *
 * Resume is offered with **no Undo**, deliberately. Resuming re-materialises future dates outside
 * the action journal, so an Undo would restore the paused parent and leave those dates live and
 * reminding: the button would lie. Pausing again is the way back, and it is one tap away.
 */

export function PausedSeriesScreen(): ReactNode {
  const t = useT();
  const todayLocalDate = useTodayLocalDate();
  const list = useInfiniteQuery("pausedSeries", { items: (data) => data.rows });

  return (
    <Screen header={<ScreenHeader title={t("tasks.paused_series_title")} />}>
      {list.isLoading ? <SkeletonList /> : null}
      {!list.isLoading && list.items.length === 0 && list.error !== undefined ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}
      {!list.isLoading && list.items.length === 0 && list.error === undefined ? <EmptyState icon="⏸" title={t("tasks.paused_series_empty")} /> : null}

      {list.items.length > 0 ? (
        <Section>
          {list.items.map((row) => (
            <PausedRow key={row.taskId} row={row} todayLocalDate={todayLocalDate} t={t} />
          ))}
        </Section>
      ) : null}

      <InfiniteSentinel hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} label={t("tasks.load_more")} />
    </Screen>
  );
}

function PausedRow({ row, todayLocalDate, t }: { row: PausedSeriesRow; todayLocalDate: string; t: Translator }): ReactNode {
  const toast = useToast();
  const undo = useUndo();
  const [asking, setAsking] = useState(false);

  const resume = useMutation("resumeSeries", {
    invalidate: ["pausedSeries", "taskList", "today", "task", "week"],
    onSuccess: () => {
      setAsking(false);
      // `null` on purpose: the resume is not reversible, so the snackbar carries no Undo button.
      undo.offer(t("task.series_resumed_toast"), null);
    },
    onError: () => {
      setAsking(false);
      toast.show(t("state.failed_toast"), { tone: "error" });
    },
  });

  const rhythm = recurrenceLine(row.recurrence, t, { todayLocalDate });
  const since = row.pausedAt ? t("tasks.paused_since", { date: dayText(instantToLocalDate(row.pausedAt, row.recurrence?.timezone ?? "UTC"), todayLocalDate, t) }) : "";

  return (
    <>
      <ListRow title={row.title} subtitle={[rhythm, since].filter(Boolean).join(" · ")} to={{ name: "task", id: row.taskId }} chevron />
      <ListRow title={t("task.resume_series")} onClick={() => setAsking(true)} muted />
      <ConfirmSheet
        open={asking}
        onClose={() => setAsking(false)}
        onConfirm={() => void resume.mutate({ params: { id: row.taskId }, body: { expectedVersion: row.version } })}
        title={t("task.resume_series")}
        description={row.title}
        confirmLabel={t("task.resume_series")}
        pending={resume.isPending}
      />
    </>
  );
}
