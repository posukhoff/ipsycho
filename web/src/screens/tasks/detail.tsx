import { useState, type ReactNode } from "react";
import { TEXT_LIMITS, type CancelScope, type ChecklistItem, type OccurrenceState, type TaskDetail } from "../../api/contracts.js";
import { useNavigate, useTodayLocalDate, type RouteOf } from "../../app/index.js";
import { useT, type CopyKey, type Translator } from "../../i18n/index.js";
import { formatInstantTime, instantToLocalDate, useMutation, useQuery } from "../../lib/index.js";
import {
  AsyncContent,
  Button,
  Card,
  Checkbox,
  ConfirmSheet,
  ConflictNotice,
  Field,
  IconButton,
  Inline,
  ListRow,
  MainAction,
  Pill,
  Screen,
  ScreenHeader,
  Section,
  SegmentedControl,
  Sheet,
  Stack,
  TextArea,
  TextInput,
  useToast,
  useUndo,
  type Option,
} from "../../ui/index.js";
import { RescheduleSheet } from "./reschedule-sheet.js";
import { dayText, importanceText, journalText, occurrenceStatusText, recurrenceLine, scheduleLine, scheduleTimeText } from "./schedule-text.js";

/**
 * One task, and everything that used to be spread across four chat cards.
 *
 * The bot's card had six buttons and a «⚙️ Ещё» that swapped the keyboard in place; the two-step
 * flows behind it — cancel, pause a series, pick an arbitrary date, choose a reason — are the ones
 * design.md § 2 moves here wholesale. What the card keeps is what answers the message in the
 * moment: done, snooze, the three quick moves.
 *
 * Two rules this screen exists to honour:
 *
 * - **A version conflict is not an error.** Every write carries the version it read, and a 409
 *   means the row moved — almost always because the same person just changed it in the chat. It
 *   renders as `ConflictNotice` with a reload, never as a red toast.
 * - **Undo is offered only when the server says the change is reversible.** `undoGroupId` is passed
 *   through untouched, except for resuming a series, which the domain deliberately does not
 *   journal as reversible.
 */

const STATE_TOASTS: Record<OccurrenceState, CopyKey> = {
  done: "state.done_toast",
  started: "state.started_toast",
  seen: "state.seen_toast",
  skipped: "state.skipped_toast",
  cancelled: "state.cancelled_toast",
};

const TASK_STATUS_KEYS = {
  active: "task.status_active",
  paused: "task.status_paused",
  closed: "task.status_closed",
  cancelled: "task.status_cancelled",
} as const satisfies Record<TaskDetail["status"], CopyKey>;

const REMINDER_PURPOSE_KEYS = {
  user_reminder: "reminders.purpose_user",
  follow_up: "reminders.purpose_follow_up",
  planning_review: "reminders.purpose_planning",
} as const satisfies Record<TaskDetail["reminders"][number]["purpose"], CopyKey>;

const TERMINAL = ["done", "skipped", "cancelled"] as const;

export function TaskScreen({ route }: { route: RouteOf<"task"> }): ReactNode {
  const t = useT();
  const task = useQuery("task", { params: { id: route.id } });

  return (
    <Screen header={<ScreenHeader title={task.data?.title ?? t("nav.tasks")} />}>
      <AsyncContent query={task}>{(data) => <TaskBody task={data} reload={() => void task.refetch()} />}</AsyncContent>
    </Screen>
  );
}

function TaskBody({ task, reload }: { task: TaskDetail; reload: () => void }): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();
  const navigate = useNavigate();
  const todayLocalDate = useTodayLocalDate();

  const [confirming, setConfirming] = useState<"skipped" | "cancelled" | "pause" | "resume" | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const [editing, setEditing] = useState<EditableField | null>(null);

  const invalidate = ["task", "taskList", "today", "week", "reminders", "goal", "pausedSeries"] as const;

  const setState = useMutation("setTaskState", {
    invalidate,
    onSuccess: (data, vars) => {
      setConfirming(null);
      setBlocker(null);
      undo.offer(t(STATE_TOASTS[vars.body.state]), data.undoGroupId, ["task", "taskList", "today", "reminders"]);
    },
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const pause = useMutation("pauseSeries", {
    invalidate,
    onSuccess: (data) => {
      setConfirming(null);
      undo.offer(t("task.series_paused_toast"), data.undoGroupId, ["task", "taskList", "today", "pausedSeries"]);
    },
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const resume = useMutation("resumeSeries", {
    invalidate,
    onSuccess: () => {
      setConfirming(null);
      // Resuming re-materialises future dates outside the journal: there is nothing to roll back.
      undo.offer(t("task.series_resumed_toast"), null);
    },
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const update = useMutation("updateTask", {
    invalidate,
    onSuccess: () => {
      setEditing(null);
      toast.show(t("common.saved"));
    },
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const checklist = useMutation("checklist", {
    invalidate,
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const conflict = setState.conflict ?? pause.conflict ?? resume.conflict ?? update.conflict ?? checklist.conflict;

  const occurrence = task.occurrence;
  // Every occurrence-scoped write names the occurrence, even when the link carried the task id:
  // «готово» on a series has to say which date it closed.
  const actionId = occurrence?.id ?? task.id;
  const occurrenceVersion = occurrence?.version ?? task.version;
  const isTerminal = occurrence ? (TERMINAL as readonly string[]).includes(occurrence.status) : false;
  const canAct = task.status === "active" && occurrence !== null && !isTerminal;
  const canComplete = task.status === "active" && occurrence !== null && (!isTerminal || occurrence.status === "elapsed");
  const canSkip = canAct && task.kind === "task" && task.recurrence !== null;

  /**
   * `scope` is only ever sent with `cancelled`, and it decides which row's version travels: the
   * occurrence for this date, the task for the whole repeat. The contract's table is the authority;
   * sending the occurrence version for a series cancel would be a conflict every time.
   */
  const changeState = (state: OccurrenceState, note?: string, scope?: CancelScope): void => {
    const expectedVersion = scope === "series" ? task.version : occurrence?.version;
    if (expectedVersion === undefined) return;
    void setState.mutate({
      params: { id: actionId },
      body: { state, expectedVersion, ...(note === undefined ? {} : { note }), ...(scope ? { scope } : {}) },
    });
  };

  const writeChecklist = (items: readonly ChecklistItem[]): void => {
    void checklist.mutate({
      params: { id: task.id },
      body: { expectedVersion: task.version, items: items.map((item) => ({ text: item.text, done: item.done })) },
    });
  };

  const doneCount = task.checklist.filter((item) => item.done).length;

  return (
    <>
      {conflict ? (
        <ConflictNotice
          onReload={() => {
            setState.reset();
            pause.reset();
            resume.reset();
            update.reset();
            checklist.reset();
            reload();
          }}
        />
      ) : null}

      <Card>
        <Stack gap={2}>
          <Inline>
            <Pill tone={task.importance === "critical" ? "danger" : task.importance === "required" ? "accent" : "neutral"}>{importanceText(task.importance, t)}</Pill>
            <Pill>{t(task.kind === "event" ? "task.kind_event" : "task.kind_task")}</Pill>
            <Pill>{t(TASK_STATUS_KEYS[task.status])}</Pill>
            {occurrence ? <Pill>{occurrenceStatusText(occurrence.status, t)}</Pill> : null}
            {occurrence?.overdue ? <Pill tone="danger">{t("task.overdue")}</Pill> : null}
            {occurrence?.completedLate ? <Pill tone="accent">{t("task.completed_late")}</Pill> : null}
          </Inline>

          <div className="ip-strong">
            {occurrence
              ? scheduleLine({ schedule: occurrence.schedule, fuzzy: null, localDate: occurrence.localDate }, todayLocalDate, t)
              : scheduleLine({ schedule: null, fuzzy: task.fuzzy, localDate: null }, todayLocalDate, t)}
          </div>

          {task.recurrence ? <div className="ip-small ip-muted">{recurrenceLine(task.recurrence, t, { todayLocalDate })}</div> : null}
          <div className="ip-small ip-muted">{t("task.timezone", { timezone: task.timezone })}</div>
          {occurrence?.dstAdjusted ? <div className="ip-small ip-muted">{t("task.dst_adjusted")}</div> : null}
          {occurrence?.expiresAt ? (
            <div className="ip-small ip-muted">{t("task.expires_at", { when: whenText(occurrence.expiresAt, task.timezone, todayLocalDate, t) })}</div>
          ) : null}
          {task.nextReminderAt ? (
            <div className="ip-small ip-muted">{t("task.next_reminder", { when: whenText(task.nextReminderAt, task.timezone, todayLocalDate, t) })}</div>
          ) : null}
        </Stack>
      </Card>

      <Inline>
        {canAct && occurrence?.status !== "in_progress" ? (
          <Button variant="secondary" small loading={setState.isPending} onClick={() => changeState("started")}>
            {t("state.mark_started")}
          </Button>
        ) : null}
        {canAct ? (
          <Button variant="secondary" small onClick={() => setBlocker("")}>
            {t("state.mark_seen")}
          </Button>
        ) : null}
        {task.status === "active" ? (
          <Button variant="secondary" small onClick={() => setRescheduling(true)}>
            {t("reschedule.title")}
          </Button>
        ) : null}
        {canSkip ? (
          <Button variant="secondary" small onClick={() => setConfirming("skipped")}>
            {t("state.mark_skipped")}
          </Button>
        ) : null}
        {canAct ? (
          <Button variant="danger" small onClick={() => setConfirming("cancelled")}>
            {t("state.mark_cancelled")}
          </Button>
        ) : null}
        {task.canPauseSeries && task.status === "active" ? (
          <Button variant="secondary" small onClick={() => setConfirming("pause")}>
            {t("task.pause_series")}
          </Button>
        ) : null}
        {task.status === "paused" ? (
          <Button variant="primary" small onClick={() => setConfirming("resume")}>
            {t("task.resume_series")}
          </Button>
        ) : null}
      </Inline>

      <Section title={t("task.title_label")}>
        <ListRow title={task.title} onClick={() => setEditing("title")} chevron />
        <ListRow title={t("task.why")} subtitle={task.why ?? t("common.nothing_here")} onClick={() => setEditing("why")} muted={!task.why} chevron />
        <ListRow title={t("task.next_action")} subtitle={task.nextAction ?? t("common.nothing_here")} onClick={() => setEditing("nextAction")} muted={!task.nextAction} chevron />
        <ListRow title={t("task.context")} subtitle={task.context ?? t("common.nothing_here")} onClick={() => setEditing("context")} muted={!task.context} chevron />
      </Section>

      <Section title={t("task.importance")}>
        <div className="ip-row">
          <div className="ip-row__main">
            <SegmentedControl
              value={task.importance}
              options={
                [
                  { value: "normal", label: t("task.importance_normal") },
                  { value: "required", label: t("task.importance_required") },
                  { value: "critical", label: t("task.importance_critical") },
                ] as readonly Option<TaskDetail["importance"]>[]
              }
              onChange={(importance) =>
                void update.mutate({
                  params: { id: task.id },
                  body: { expectedVersion: task.version, title: null, why: null, nextAction: null, context: null, checklist: null, importance, clear: null },
                })
              }
            />
          </div>
        </div>
      </Section>

      <Section title={`${t("task.checklist")} · ${t("task.checklist_progress", { done: doneCount, total: task.checklist.length })}`}>
        {task.checklist.length === 0 ? <ListRow title={t("task.checklist_empty")} muted /> : null}
        {task.checklist.map((item, index) => (
          <ListRow
            key={item.id ?? `${index}-${item.text}`}
            title={item.text}
            muted={item.done}
            leading={
              <Checkbox
                checked={item.done}
                label={item.text}
                disabled={checklist.isPending}
                onChange={(done) => writeChecklist(task.checklist.map((entry, position) => (position === index ? { ...entry, done } : entry)))}
              />
            }
            meta={
              <IconButton
                label={t("common.delete")}
                icon="✕"
                disabled={checklist.isPending}
                onClick={() => writeChecklist(task.checklist.filter((_entry, position) => position !== index))}
              />
            }
          />
        ))}
        {task.checklist.length < TEXT_LIMITS.checklistItems ? (
          <ChecklistAdder onAdd={(text) => writeChecklist([...task.checklist, { id: null, text, done: false }])} disabled={checklist.isPending} />
        ) : null}
      </Section>

      <Section title={t("task.goal")}>
        {task.goal ? (
          <ListRow title={task.goal.title} to={{ name: "goal", id: task.goal.id }} chevron />
        ) : (
          <ListRow title={t("task.goal_none")} muted onClick={() => navigate.push({ name: "goals", scope: "active" })} chevron />
        )}
      </Section>

      {task.siblingOccurrences.length > 0 ? (
        <Section title={t("task.other_dates")}>
          {task.siblingOccurrences.map((sibling) => (
            <ListRow
              key={sibling.id}
              title={dayText(sibling.localDate, todayLocalDate, t)}
              subtitle={scheduleTimeText(sibling.schedule, null, t)}
              meta={occurrenceStatusText(sibling.status, t)}
              to={{ name: "task", id: sibling.id }}
              chevron
            />
          ))}
        </Section>
      ) : null}

      <Section title={t("task.reminders")}>
        {task.reminders.length === 0 ? <ListRow title={t("task.reminders_none")} muted /> : null}
        {task.reminders.map((reminder) => (
          <ListRow
            key={reminder.ruleId}
            title={t(REMINDER_PURPOSE_KEYS[reminder.purpose])}
            meta={reminder.nextAt ? whenText(reminder.nextAt, task.timezone, todayLocalDate, t) : null}
          />
        ))}
      </Section>

      <Section title={t("task.journal")} footer={t("task.created", { when: dayText(instantToLocalDate(task.createdAt, task.timezone), todayLocalDate, t) })}>
        {task.journal.length === 0 ? <ListRow title={t("task.journal_empty")} muted /> : null}
        {task.journal.map((entry) => (
          <ListRow
            key={entry.id}
            title={journalText(entry.eventType, t)}
            subtitle={entry.details ?? (entry.byUser ? undefined : t("journal.by_system"))}
            meta={whenText(entry.at, task.timezone, todayLocalDate, t)}
          />
        ))}
      </Section>

      <MainAction label={t("state.mark_done")} hidden={!canComplete} loading={setState.isPending} onClick={() => changeState("done")} />

      <ConfirmSheet
        open={confirming === "skipped"}
        onClose={() => setConfirming(null)}
        onConfirm={() => changeState("skipped")}
        title={t("state.mark_skipped")}
        description={t("task.skip_one_confirm")}
        confirmLabel={t("state.mark_skipped")}
        pending={setState.isPending}
      />

      {/*
        A repeat has two answers to «отмени» and the bot's single button only ever gave one, so a
        cancelled occurrence left the rule producing the next date. The sheet asks which, the same
        way the reschedule sheet does, and a one-off keeps the single confirmation — cancelling its
        only date closes the task with it.
      */}
      <ConfirmSheet
        open={confirming === "cancelled" && task.recurrence === null}
        onClose={() => setConfirming(null)}
        onConfirm={() => changeState("cancelled")}
        title={t("state.mark_cancelled")}
        description={
          <>
            {task.title}
            <br />
            {t("task.cancel_one_confirm")}
          </>
        }
        confirmLabel={t("state.mark_cancelled")}
        destructive
        pending={setState.isPending}
      />

      <Sheet open={confirming === "cancelled" && task.recurrence !== null} onClose={() => setConfirming(null)} title={t("state.mark_cancelled")}>
        <Stack>
          <p className="ip-muted">{task.title}</p>
          <Button block variant="danger" loading={setState.isPending} onClick={() => changeState("cancelled", undefined, "occurrence")}>
            {t("reschedule.scope_occurrence")}
          </Button>
          <Button block variant="danger" loading={setState.isPending} onClick={() => changeState("cancelled", undefined, "series")}>
            {t("reschedule.scope_series")}
          </Button>
          <Button block variant="ghost" onClick={() => setConfirming(null)}>
            {t("common.cancel")}
          </Button>
        </Stack>
      </Sheet>

      <ConfirmSheet
        open={confirming === "pause"}
        onClose={() => setConfirming(null)}
        onConfirm={() => void pause.mutate({ params: { id: task.id }, body: { expectedVersion: task.version } })}
        title={t("task.pause_series")}
        description={recurrenceLine(task.recurrence, t, { todayLocalDate })}
        confirmLabel={t("task.pause_series")}
        pending={pause.isPending}
      />

      <ConfirmSheet
        open={confirming === "resume"}
        onClose={() => setConfirming(null)}
        onConfirm={() => void resume.mutate({ params: { id: task.id }, body: { expectedVersion: task.version } })}
        title={t("task.resume_series")}
        description={recurrenceLine(task.recurrence, t, { todayLocalDate })}
        confirmLabel={t("task.resume_series")}
        pending={resume.isPending}
      />

      <Sheet open={blocker !== null} onClose={() => setBlocker(null)} title={t("state.blocker_note")}>
        <Stack>
          <Field hint={t("common.optional")}>
            <TextInput value={blocker ?? ""} boxed maxLength={TEXT_LIMITS.blockerNote} placeholder={t("state.blocker_placeholder")} onChange={(value) => setBlocker(value)} />
          </Field>
          <Button block variant="primary" loading={setState.isPending} onClick={() => changeState("seen", (blocker ?? "").trim() || undefined)}>
            {t("state.mark_seen")}
          </Button>
        </Stack>
      </Sheet>

      <RescheduleSheet
        open={rescheduling}
        onClose={() => setRescheduling(false)}
        id={actionId}
        expectedVersion={occurrenceVersion}
        schedule={occurrence?.schedule ?? null}
        fuzzy={task.fuzzy}
        todayLocalDate={todayLocalDate}
        onDone={reload}
      />

      <FieldEditSheet
        field={editing}
        task={task}
        pending={update.isPending}
        onClose={() => setEditing(null)}
        onSave={(field, value) => {
          const trimmed = value.trim();
          void update.mutate({
            params: { id: task.id },
            body: {
              expectedVersion: task.version,
              title: field === "title" ? trimmed : null,
              why: field === "why" && trimmed ? trimmed : null,
              nextAction: field === "nextAction" && trimmed ? trimmed : null,
              context: field === "context" && trimmed ? trimmed : null,
              checklist: null,
              importance: null,
              // `null` on a field means «leave it alone», so emptying one has to say so explicitly.
              clear: field !== "title" && !trimmed ? [field] : null,
            },
          });
        }}
      />
    </>
  );
}

type EditableField = "title" | "why" | "nextAction" | "context";

const FIELD_KEYS: Record<EditableField, CopyKey> = {
  title: "task.title_label",
  why: "task.why",
  nextAction: "task.next_action",
  context: "task.context",
};

const FIELD_LIMITS: Record<EditableField, number> = {
  title: TEXT_LIMITS.title,
  why: TEXT_LIMITS.why,
  nextAction: TEXT_LIMITS.nextAction,
  context: TEXT_LIMITS.context,
};

function FieldEditSheet({
  field,
  task,
  pending,
  onClose,
  onSave,
}: {
  field: EditableField | null;
  task: TaskDetail;
  pending: boolean;
  onClose: () => void;
  onSave: (field: EditableField, value: string) => void;
}): ReactNode {
  const t = useT();
  const [value, setValue] = useState("");
  const [openFor, setOpenFor] = useState<EditableField | null>(null);

  if (field !== openFor) {
    setOpenFor(field);
    setValue(field ? (task[field] ?? "") : "");
  }

  return (
    <Sheet open={field !== null} onClose={onClose} title={field ? t(FIELD_KEYS[field]) : ""}>
      <Stack>
        <Field {...(field === "title" ? { required: true } : { hint: t("common.optional") })}>
          {field === "title" ? (
            <TextInput value={value} boxed maxLength={FIELD_LIMITS.title} onChange={setValue} />
          ) : (
            <TextArea value={value} rows={4} maxLength={field ? FIELD_LIMITS[field] : undefined} onChange={setValue} />
          )}
        </Field>
        <Button block variant="primary" loading={pending} disabled={field === "title" && value.trim().length === 0} onClick={() => field && onSave(field, value)}>
          {t("common.save")}
        </Button>
      </Stack>
    </Sheet>
  );
}

function ChecklistAdder({ onAdd, disabled }: { onAdd: (text: string) => void; disabled: boolean }): ReactNode {
  const t = useT();
  const [text, setText] = useState("");
  return (
    <div className="ip-row">
      <div className="ip-row__main">
        <TextInput value={text} boxed maxLength={TEXT_LIMITS.checklistItem} placeholder={t("task.checklist_add")} onChange={setText} disabled={disabled} />
      </div>
      <div className="ip-row__trailing">
        <Button
          small
          variant="secondary"
          disabled={disabled || text.trim().length === 0}
          onClick={() => {
            onAdd(text.trim());
            setText("");
          }}
        >
          {t("common.add")}
        </Button>
      </div>
    </div>
  );
}

/**
 * An instant as «завтра 10:30», in the row's own timezone.
 *
 * The day is derived from the instant *with the task's zone*, never with the device's, and then
 * compared against the local today the server sent — the rule `primitives.ts` states.
 */
function whenText(instant: string, timezone: string, todayLocalDate: string, t: Translator): string {
  return `${dayText(instantToLocalDate(instant, timezone), todayLocalDate, t)} ${formatInstantTime(instant, timezone, t.locale)}`;
}
