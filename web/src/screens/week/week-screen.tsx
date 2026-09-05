import { useCallback, useRef, type ReactNode } from "react";
import type { WeekPickResponse, WeekPoolRow, WeekResponse } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { formatLocalDate, haptics, useInfiniteQuery, useMutation, useQuery, useQueryCache, type QueryCache } from "../../lib/index.js";
import { AsyncContent, Card, EmptyState, InfiniteSentinel, Screen, ScreenHeader, Section, SkeletonList, Spinner, Stack, useToast } from "../../ui/index.js";
import { useTakeToday } from "./take-today.js";
import { WeekPoolListRow } from "./week-row.js";

/**
 * The week plan (tasks 7.2 and 7.3): the pool, the current pick, and the stale pick.
 *
 * **The pick is not a client-side computation.** `picked` and `stale` arrive decided, from
 * `isPickLive` and `isPickStale` in `src/core/week-plan.ts`, because both need `targetWeekStart`,
 * which needs the user's timezone and the Sunday rule — a pick made on Sunday is for the week that
 * starts tomorrow. Recomputing that in the browser would be wrong for one day out of every seven.
 *
 * **The list never reorders under the finger.** `comparePoolRows` deliberately ranks a row by
 * overdue / stale / importance and never by whether it is picked, so that the row under the thumb
 * stays put across a tap. The client keeps that promise by patching the tapped row in place with
 * what the server answered instead of refetching the page: an invalidation here would re-sort the
 * list mid-gesture. Take-today is the exception — that row leaves the pool, so the read is redone.
 *
 * **A pick has no Undo, and that is the truth.** `POST`/`DELETE /week/pick/:taskId` answer without
 * an `undoGroupId` at all: the same checkbox is the reversal, the write is not journalled as an
 * action group, and a snackbar offering «вернуть» would be offering something the server cannot do.
 * Take-today *is* journalled through `ActionsService`, so that one carries the Undo snackbar.
 */

/** The head of the same paged read the pool below scrolls; one cache entry, one request. */
const HEAD = { query: { page: 0 } } as const;

export function WeekScreen(): ReactNode {
  const t = useT();
  const toast = useToast();
  const cache = useQueryCache();
  const takeToday = useTakeToday();

  const head = useQuery("week", HEAD);
  const list = useInfiniteQuery("week", { items: (data: WeekResponse) => data.rows });

  /** One rollback per task: `full` and `not_found` are successful responses that undo the tap. */
  const rollbacks = useRef(new Map<string, () => void>());
  const pickLimit = head.data?.pickLimit ?? 0;
  const pickedCount = head.data?.pickedCount ?? 0;

  const settle = useCallback(
    (data: WeekPickResponse, taskId: string | undefined) => {
      if (taskId === undefined) return;
      const rollback = rollbacks.current.get(taskId);
      rollbacks.current.delete(taskId);

      if (data.result === "full") {
        rollback?.();
        haptics.notify("warning");
        // Not an error: the tap was legal and the cap is a product rule, so the sentence says so.
        toast.show(t("week.limit_reached", { limit: pickLimit }));
        return;
      }
      if (data.result === "not_found") {
        rollback?.();
        haptics.notify("error");
        toast.show(t("week.gone_toast"), { tone: "error" });
        return;
      }

      const row = data.row;
      cache.patchEach("week", (page) => {
        if (!page.rows.some((candidate) => candidate.taskId === taskId)) return page;
        return {
          ...page,
          pickedCount: data.pickedCount,
          rows: row ? page.rows.map((candidate) => (candidate.taskId === taskId ? row : candidate)) : page.rows,
        };
      });
      haptics.notify("success");
      toast.show(t(data.result === "picked" ? "week.picked_toast" : "week.released_toast"));
    },
    [cache, pickLimit, t, toast],
  );

  const onFailure = useCallback(
    (error: unknown, taskId: string | undefined) => {
      if (taskId !== undefined) rollbacks.current.delete(taskId);
      haptics.notify("error");
      toast.show(t.error(error), { tone: "error" });
    },
    [t, toast],
  );

  const pick = useMutation("pickWeek", {
    haptic: false,
    optimistic: (vars, patchCache) => remember(rollbacks.current, vars.params?.taskId, patchPick(patchCache, vars.params?.taskId, true)),
    onSuccess: (data, vars) => settle(data, vars.params?.taskId),
    onError: (error, vars) => onFailure(error, vars.params?.taskId),
  });

  const release = useMutation("releaseWeek", {
    haptic: false,
    optimistic: (vars, patchCache) => remember(rollbacks.current, vars.params?.taskId, patchPick(patchCache, vars.params?.taskId, false)),
    onSuccess: (data, vars) => settle(data, vars.params?.taskId),
    onError: (error, vars) => onFailure(error, vars.params?.taskId),
  });

  const pickMutate = pick.mutate;
  const releaseMutate = release.mutate;

  const toggle = useCallback(
    (row: WeekPoolRow) => {
      const vars = { params: { taskId: row.taskId } };
      if (row.picked) void releaseMutate(vars);
      else void pickMutate(vars);
    },
    [pickMutate, releaseMutate],
  );

  const take = takeToday.take;
  const onTakeToday = useCallback((row: WeekPoolRow) => take({ taskId: row.taskId, version: row.version }), [take]);

  const full = pickLimit > 0 && pickedCount >= pickLimit;

  return (
    <Screen
      header={
        <ScreenHeader
          title={t("week.title")}
          subtitle={head.data ? t("week.target_week", { monday: formatLocalDate(head.data.targetWeekStart, t.locale, { todayLocalDate: head.data.todayLocalDate }) }) : undefined}
          actions={head.isRefreshing ? <Spinner label={t("common.loading")} /> : undefined}
        />
      }
    >
      <AsyncContent query={head} skeleton={<SkeletonList rows={5} />}>
        {(data) => (
          <Stack>
            <Card>
              <Stack gap={1}>
                <span>{t("week.summary", { done: data.summary.done, stale: data.summary.takenNotStarted })}</span>
                <span className="ip-small ip-muted">
                  {t("week.previous", {
                    start: formatLocalDate(data.previousWeek.start, t.locale, { todayLocalDate: data.todayLocalDate }),
                    end: formatLocalDate(data.previousWeek.end, t.locale, { todayLocalDate: data.todayLocalDate }),
                  })}
                </span>
              </Stack>
            </Card>

            {list.items.length === 0 ? (
              <EmptyState icon="🗂" title={t("week.pool_empty")} body={t("week.pool_hint")} />
            ) : (
              <Section
                title={t("week.picked", { count: data.pickedCount, limit: data.pickLimit })}
                footer={full ? t("week.limit_reached", { limit: data.pickLimit }) : t("week.pool_hint")}
              >
                {list.items.map((row) => (
                  <WeekPoolListRow key={row.taskId} row={row} pickDisabled={full && !row.picked} takeDisabled={takeToday.isPending} onToggle={toggle} onTakeToday={onTakeToday} />
                ))}
              </Section>
            )}

            <InfiniteSentinel hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} label={t("tasks.load_more")} />
          </Stack>
        )}
      </AsyncContent>
    </Screen>
  );
}

/**
 * The tick moves at the tap.
 *
 * `pickedWeekStart` is set from the response's own `targetWeekStart` rather than from anything
 * computed here, and `stale` clears when the row is taken again — which is exactly what taking a
 * stale row means: the decision that was left open last week has now been made.
 */
export function patchPick(cache: QueryCache, taskId: string | undefined, picked: boolean): () => void {
  if (taskId === undefined) return () => undefined;
  return cache.patchEach("week", (data) => {
    if (!data.rows.some((row) => row.taskId === taskId)) return data;
    return {
      ...data,
      pickedCount: Math.max(0, data.pickedCount + (picked ? 1 : -1)),
      rows: data.rows.map((row) => (row.taskId === taskId ? { ...row, picked, stale: picked ? false : row.stale, pickedWeekStart: picked ? data.targetWeekStart : null } : row)),
    };
  });
}

function remember(rollbacks: Map<string, () => void>, taskId: string | undefined, rollback: () => void): () => void {
  if (taskId !== undefined) rollbacks.set(taskId, rollback);
  return rollback;
}
