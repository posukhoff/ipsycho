import { useState, type ReactNode } from "react";
import type { ReminderRow } from "../../api/contracts.js";
import { useSettings, useTodayLocalDate } from "../../app/index.js";
import { useT, type Translator } from "../../i18n/index.js";
import { dayOffset, formatInstantTime, formatLocalDate, formatWeekday, instantToLocalDate, useInfiniteQuery, useMutation } from "../../lib/index.js";
import {
  Button,
  ConfirmSheet,
  DateField,
  EmptyState,
  ErrorState,
  InfiniteSentinel,
  ListRow,
  Pill,
  QuickChoices,
  Screen,
  ScreenHeader,
  Section,
  Sheet,
  SkeletonList,
  Stack,
  TimeField,
  useToast,
  useUndo,
} from "../../ui/index.js";

/**
 * The upcoming reminders, grouped by the day they will actually arrive.
 *
 * Two things this screen has to keep straight, because the bot's `remindersText` did and losing
 * either makes the list lie:
 *
 * - `scheduledFor` is when the message goes out; `intendedFor` is the moment it is *about*. Quiet
 *   hours and a snooze move the first and leave the second alone, so a row whose two differ says
 *   «было на …» rather than silently showing a time the user never asked for.
 * - The day heading comes from `localDate`, which the server computed in the row's own timezone.
 *   Re-deriving it here from the instant would put a 00:30 reminder on yesterday for a phone in a
 *   different zone (`primitives.ts`).
 *
 * Cancelling is the one action here that is not reversible — `DELETE /reminders/:deliveryId`
 * answers `{ cancelled }` and carries no `undoGroupId` — so it is confirmed first and then
 * announced with a plain toast. Snooze and repeat both answer with a group and offer Undo.
 */

interface SheetState {
  readonly row: ReminderRow;
  readonly mode: "actions" | "cancel";
}

export function RemindersScreen(): ReactNode {
  const t = useT();
  const settings = useSettings();
  const todayLocalDate = useTodayLocalDate();
  const list = useInfiniteQuery("reminders", { items: (data) => data.rows });
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const snoozedUntil = settings.notificationsSnoozedUntil;
  const snoozeNotice =
    snoozedUntil && new Date(snoozedUntil).getTime() > Date.now()
      ? t("reminders.notifications_snoozed", { until: formatInstantTime(snoozedUntil, settings.timezone, t.locale) })
      : null;

  return (
    <Screen header={<ScreenHeader title={t("reminders.title")} {...(snoozeNotice ? { subtitle: snoozeNotice } : {})} />}>
      {list.isLoading ? <SkeletonList /> : null}
      {!list.isLoading && list.error !== undefined && list.items.length === 0 ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}
      {!list.isLoading && list.error === undefined && list.items.length === 0 ? <EmptyState icon="🔔" title={t("reminders.empty")} body={t("reminders.hint")} /> : null}

      {groupByDay(list.items).map((day) => (
        <Section key={day.localDate} title={dayTitle(day.localDate, todayLocalDate, t)}>
          {day.rows.map((row) => (
            <ReminderListRow key={row.deliveryId} row={row} onOpenActions={() => setSheet({ row, mode: "actions" })} />
          ))}
        </Section>
      ))}

      <InfiniteSentinel hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} label={t("tasks.load_more")} />

      {sheet ? (
        <ReminderActions
          state={sheet}
          onClose={() => setSheet(null)}
          onAskCancel={() => setSheet({ row: sheet.row, mode: "cancel" })}
          onRefresh={() => {
            setSheet(null);
            list.refresh();
          }}
        />
      ) : null}
    </Screen>
  );
}

/**
 * The whole row opens the action sheet, and the task itself is one row inside it. Putting a link
 * and a menu button in the same row would nest one interactive element inside another — invalid
 * markup, and on a touch screen a tap that fires both.
 */
function ReminderListRow({ row, onOpenActions }: { row: ReminderRow; onOpenActions: () => void }): ReactNode {
  const t = useT();
  const todayLocalDate = useTodayLocalDate();
  const moved = row.intendedFor !== row.scheduledFor;

  return (
    <ListRow
      title={row.title}
      subtitle={
        <span className="ip-inline">
          <Pill>{purposeLabel(row, t)}</Pill>
          {row.followUp ? <Pill tone="accent">{t("reminders.follow_up")}</Pill> : null}
          {moved ? <span className="ip-muted ip-small">{t("reminders.intended_for", { when: intendedLabel(row, todayLocalDate, t) })}</span> : null}
        </span>
      }
      meta={formatInstantTime(row.scheduledFor, row.timezone, t.locale)}
      onClick={onOpenActions}
      chevron
    />
  );
}

function ReminderActions({ state, onClose, onAskCancel, onRefresh }: { state: SheetState; onClose: () => void; onAskCancel: () => void; onRefresh: () => void }): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();
  const todayLocalDate = useTodayLocalDate();
  const { row } = state;

  const [repeatOpen, setRepeatOpen] = useState(false);
  const [date, setDate] = useState<string | null>(todayLocalDate);
  const [time, setTime] = useState<string | null>(null);

  const snooze = useMutation("snoozeReminder", {
    invalidate: ["reminders"],
    onSuccess: (data) => undo.offer(t("reminders.snoozed_toast"), data.undoGroupId, ["reminders"]),
    onError: () => toast.show(t("reminders.failed_toast"), { tone: "error" }),
  });

  const repeat = useMutation("repeatReminder", {
    invalidate: ["reminders"],
    onSuccess: (data) => undo.offer(t("reminders.snoozed_toast"), data.undoGroupId, ["reminders"]),
    onError: () => toast.show(t("reminders.failed_toast"), { tone: "error" }),
  });

  const cancel = useMutation("cancelReminder", {
    // The row leaves the list at the tap and comes back if the request fails: `patchEach` reaches
    // every loaded page, so a cancel from page three does not need the list refetched to look right.
    optimistic: (_vars, queryCache) =>
      queryCache.patchEach("reminders", (data) => {
        if (!data.rows.some((item) => item.deliveryId === row.deliveryId)) return data;
        return { ...data, rows: data.rows.filter((item) => item.deliveryId !== row.deliveryId), page: { ...data.page, total: Math.max(0, data.page.total - 1) } };
      }),
    invalidate: ["reminders"],
    // No `undoGroupId` in `ReminderCancelResponse`: a cancelled delivery is gone, so the snackbar
    // says so and offers nothing. An Undo button here would be a button that cannot work.
    onSuccess: () => undo.offer(t("reminders.cancelled_toast"), null),
    onError: () => toast.show(t("reminders.failed_toast"), { tone: "error" }),
  });

  if (state.mode === "cancel") {
    return (
      <ConfirmSheet
        open
        destructive
        onClose={onClose}
        pending={cancel.isPending}
        title={t("reminders.cancel")}
        description={row.title}
        confirmLabel={t("common.delete")}
        onConfirm={() => {
          void cancel.mutate({ params: { deliveryId: row.deliveryId } }).then(() => onClose());
        }}
      />
    );
  }

  return (
    <Sheet open onClose={onClose} title={row.title}>
      <Stack>
        <p className="ip-muted ip-small">
          {formatLocalDate(row.localDate, t.locale, { todayLocalDate })} · {formatInstantTime(row.scheduledFor, row.timezone, t.locale)}
        </p>

        <ListRow title={t("reminders.open_task")} subtitle={row.title} to={{ name: "task", id: row.taskId }} chevron />

        <div className="ip-field__label">{t("reminders.snooze")}</div>
        <QuickChoices
          disabled={snooze.isPending}
          options={[
            { value: "15m", label: t("reminders.snooze_15m") },
            { value: "1h", label: t("reminders.snooze_1h") },
          ]}
          onPick={(choice) => {
            void snooze.mutate({ params: { deliveryId: row.deliveryId }, body: { choice } }).then((result) => {
              if (result) onRefresh();
            });
          }}
        />

        {repeatOpen ? (
          <Stack gap={2}>
            <div className="ip-field__label">{t("reminders.repeat_title")}</div>
            <DateField value={date} todayLocalDate={todayLocalDate} onChange={setDate} />
            <TimeField value={time} allowEmpty={false} onChange={setTime} />
            <Button
              block
              variant="primary"
              disabled={!date || !time}
              loading={repeat.isPending}
              onClick={() => {
                if (!date || !time) return;
                void repeat.mutate({ params: { deliveryId: row.deliveryId }, body: { date, time } }).then((result) => {
                  if (result) onRefresh();
                });
              }}
            >
              {t("common.confirm")}
            </Button>
          </Stack>
        ) : (
          <Button block variant="secondary" onClick={() => setRepeatOpen(true)}>
            {t("reminders.repeat")}
          </Button>
        )}

        <Button block variant="danger" onClick={onAskCancel}>
          {t("reminders.cancel")}
        </Button>
      </Stack>
    </Sheet>
  );
}

interface DayGroup {
  readonly localDate: string;
  readonly rows: ReminderRow[];
}

/** Rows arrive ordered by `scheduledFor`; the headings follow that order rather than re-sorting. */
function groupByDay(rows: readonly ReminderRow[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.localDate === row.localDate) last.rows.push(row);
    else groups.push({ localDate: row.localDate, rows: [row] });
  }
  return groups;
}

function dayTitle(localDate: string, todayLocalDate: string, t: Translator): string {
  const offset = dayOffset(localDate, todayLocalDate);
  if (offset === "today") return t("reminders.day_today");
  if (offset === "tomorrow") return t("reminders.day_tomorrow");
  return `${formatWeekday(localDate, t.locale)}, ${formatLocalDate(localDate, t.locale, { todayLocalDate })}`;
}

/**
 * «было на 3 сент. 19:00» — the day is named whenever the delivery was moved off the day it was
 * about, which is the case quiet hours and a snooze produce and the one a bare time would hide.
 */
function intendedLabel(row: ReminderRow, todayLocalDate: string, t: Translator): string {
  const time = formatInstantTime(row.intendedFor, row.timezone, t.locale);
  const intendedDate = instantToLocalDate(row.intendedFor, row.timezone);
  if (intendedDate === row.localDate) return time;
  return `${formatLocalDate(intendedDate, t.locale, { todayLocalDate })} ${time}`;
}

function purposeLabel(row: ReminderRow, t: Translator): string {
  if (row.purpose === "follow_up") return t("reminders.purpose_follow_up");
  if (row.purpose === "planning_review") return t("reminders.purpose_planning");
  return t("reminders.purpose_user");
}
