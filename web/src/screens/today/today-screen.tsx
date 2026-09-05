import { useCallback, useState, type ReactNode } from "react";
import { TEXT_LIMITS, type EndpointName, type OccurrenceState, type TaskGroup, type TodayResponse } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { formatLocalDate, formatWeekday, haptics, useInfiniteQuery, useMutation, useQuery, type QueryCache } from "../../lib/index.js";
import {
  AsyncContent,
  Button,
  Card,
  EmptyState,
  Field,
  InfiniteSentinel,
  ListRow,
  Screen,
  ScreenHeader,
  Section,
  Sheet,
  SkeletonList,
  Spinner,
  Stack,
  TextArea,
  useToast,
  useUndo,
} from "../../ui/index.js";
import { useTakeToday } from "../week/take-today.js";
import { leadRow, TodayGroupRow } from "./today-row.js";

/**
 * Today (task 7.1): the day's occurrences, grouped, with done / start / skip on the row itself.
 *
 * This is where the morning card's launch button lands, which decides two things about it.
 *
 * **It must be readable the instant it opens.** `AsyncContent` renders cached data before it
 * renders a skeleton, and the cache keeps the entry across a trip to a task and back, so returning
 * to Today never flashes a spinner over content that is already known. The refresh that follows is
 * a small spinner in the header, not a blank screen.
 *
 * **The two hooks read one cache entry.** `useQuery("today", { query: { page: 0 } })` and the
 * infinite list's own page 0 build the same key (`queryKey` sorts the query object), so the header
 * counts and the rows come from a single request. The head query is also what `AsyncContent`
 * branches on, which is what keeps the not-found path from being forgotten.
 *
 * **Nothing here asks the device what day it is.** `localDate` and `timezone` come from the
 * response; `useTodayLocalDate()` from the shell would do as well, but the response's own value is
 * the one the rows were selected against, and using the row's answer for the row's own screen is
 * the rule that keeps a task dated «today» in Kyiv from reading as yesterday's on a phone in UTC-5.
 */

/** The head of the same paged read the list below scrolls. */
const HEAD = { query: { page: 0 } } as const;

/**
 * What one occurrence's state change touches. `week` is in the list because the pool is defined by
 * `POOL_MEMBERSHIP` — a one-off with an overdue occurrence is *in* the pool, and closing it takes
 * it out again.
 */
const TOUCHED: readonly EndpointName[] = ["today", "taskList", "task", "week"];

const TOAST_KEY = {
  done: "state.done_toast",
  started: "state.started_toast",
  seen: "state.seen_toast",
  skipped: "state.skipped_toast",
  cancelled: "state.cancelled_toast",
} as const;

export function TodayScreen(): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();
  const takeToday = useTakeToday();

  const head = useQuery("today", HEAD);
  const list = useInfiniteQuery("today", { items: (data: TodayResponse) => data.groups });

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [blockerFor, setBlockerFor] = useState<TaskGroup | null>(null);
  const [note, setNote] = useState("");

  const stateChange = useMutation("setTaskState", {
    // Buzzed by hand: a refusal must not buzz "success" on its way to an error toast.
    haptic: false,
    invalidate: TOUCHED,
    optimistic: (vars, cache) => {
      const occurrenceId = vars.params?.id;
      return occurrenceId ? patchToday(cache, occurrenceId, vars.body.state) : undefined;
    },
    onSuccess: (data, vars) => {
      haptics.notify("success");
      // `undoGroupId` is null when the change cannot be truthfully reversed; the snackbar then
      // carries no Undo button rather than one that lies.
      undo.offer(t(TOAST_KEY[vars.body.state]), data.undoGroupId, TOUCHED);
    },
    onError: (error) => {
      haptics.notify("error");
      toast.show(t.error(error), { tone: "error" });
    },
  });

  const { mutate } = stateChange;

  const act = useCallback(
    (group: TaskGroup, next: OccurrenceState, blocker: string | null = null) => {
      const lead = leadRow(group);
      // A fuzzy review row has no occurrence, and `setOccurrenceStatus` has nothing to write.
      if (lead.occurrenceId === null || lead.occurrenceVersion === null) return;
      void mutate({
        params: { id: lead.occurrenceId },
        body: { state: next, expectedVersion: lead.occurrenceVersion, note: blocker },
      });
    },
    [mutate],
  );

  const closeBlocker = useCallback(() => {
    setBlockerFor(null);
    setNote("");
  }, []);

  const submitBlocker = useCallback(() => {
    if (blockerFor) act(blockerFor, "seen", note.trim() || null);
    closeBlocker();
  }, [act, blockerFor, closeBlocker, note]);

  const subtitle = head.data ? `${formatWeekday(head.data.localDate, t.locale, "long")}, ${formatLocalDate(head.data.localDate, t.locale)}` : undefined;
  const busy = stateChange.isPending || takeToday.isPending;

  return (
    <Screen header={<ScreenHeader title={t("today.title")} subtitle={subtitle} actions={head.isRefreshing ? <Spinner label={t("common.loading")} /> : undefined} />}>
      <AsyncContent query={head} skeleton={<SkeletonList rows={4} />}>
        {(data) => (
          <Stack>
            {data.staleCount > 0 ? (
              <Section>
                <ListRow title={t("today.stale", { count: data.staleCount })} to={{ name: "tasks", scope: "overdue" }} chevron />
              </Section>
            ) : null}

            <MainCallout groups={list.items} />

            {list.items.length === 0 ? (
              <EmptyState icon="🌤" title={t("today.empty")} body={t("today.empty_hint")} />
            ) : (
              <Section>
                {list.items.map((group) => (
                  <TodayGroupRow
                    key={group.key}
                    group={group}
                    todayLocalDate={data.localDate}
                    expanded={expandedKey === group.key}
                    busy={busy}
                    onToggle={() => setExpandedKey((current) => (current === group.key ? null : group.key))}
                    onAct={(next) => act(group, next)}
                    onBlocker={() => setBlockerFor(group)}
                    onTakeToday={() => takeToday.take({ taskId: leadRow(group).taskId, version: leadRow(group).taskVersion })}
                  />
                ))}
              </Section>
            )}

            <InfiniteSentinel hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} label={t("tasks.load_more")} />

            {data.completedCount > 0 ? (
              <Section>
                <ListRow title={t("today.completed", { count: data.completedCount })} muted />
              </Section>
            ) : null}
          </Stack>
        )}
      </AsyncContent>

      <Sheet
        open={blockerFor !== null}
        onClose={closeBlocker}
        title={t("state.blocker_note")}
        footer={
          <Button block variant="primary" onClick={submitBlocker}>
            {t("state.mark_seen")}
          </Button>
        }
      >
        <Field hint={t("common.optional")}>
          <TextArea value={note} onChange={setNote} placeholder={t("state.blocker_placeholder")} maxLength={TEXT_LIMITS.blockerNote} />
        </Field>
      </Sheet>
    </Screen>
  );
}

/** «Главное»: the one thing the day is actually about, when the day has one. */
function MainCallout({ groups }: { groups: readonly TaskGroup[] }): ReactNode {
  const t = useT();
  // The bot picked the first non-normal group and fell back to the first row. Falling back would
  // put a label saying «главное» on an ordinary task, and repeating a day that holds one thing
  // says nothing at all, so this appears only when something in a list actually stands out.
  const main = groups.length > 1 ? groups.find((group) => group.importance !== "normal") : undefined;
  if (!main) return null;
  return (
    <Card>
      <Stack gap={1}>
        <span className="ip-small ip-muted">{t("today.section_main")}</span>
        <span className="ip-strong">{main.title}</span>
      </Stack>
    </Card>
  );
}

/**
 * The row moves at the tap, and the server is what actually reverses it.
 *
 * `started` and `seen` change the row in place. `done`, `skipped` and `cancelled` take it off the
 * day, because that is what the next read will do: `listTodayGroupedForTelegram` lists actionable
 * occurrences only, and leaving a ticked row behind until the refetch lands would make the list
 * flicker rather than settle. A failed write rolls all of it back.
 */
export function patchToday(cache: QueryCache, occurrenceId: string, next: OccurrenceState): () => void {
  return cache.patchEach("today", (data) => {
    if (!data.groups.some((group) => group.rows.some((row) => row.occurrenceId === occurrenceId))) return data;

    if (next === "started" || next === "seen") {
      const status = next === "started" ? "in_progress" : "open";
      return {
        ...data,
        groups: data.groups.map((group) => ({
          ...group,
          rows: group.rows.map((row) => (row.occurrenceId === occurrenceId ? { ...row, occurrenceStatus: status } : row)),
        })),
      };
    }

    const groups = data.groups
      .map((group) => {
        const rows = group.rows.filter((row) => row.occurrenceId !== occurrenceId);
        // `leadIndex` points into `rows`; dropping a row can leave it past the end.
        return { ...group, rows, leadIndex: Math.min(group.leadIndex, Math.max(0, rows.length - 1)) };
      })
      .filter((group) => group.rows.length > 0);

    return { ...data, groups, completedCount: next === "done" ? data.completedCount + 1 : data.completedCount };
  });
}
