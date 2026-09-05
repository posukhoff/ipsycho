import { useEffect, useState, type ReactNode } from "react";
import { TEXT_LIMITS, type Importance, type TaskDetail, type TaskKind } from "../../api/contracts.js";
import { useBackInterceptor, useNavigate, useTodayLocalDate, type RouteOf } from "../../app/index.js";
import { useT } from "../../i18n/index.js";
import { useMutation, useQuery } from "../../lib/index.js";
import {
  AsyncContent,
  Button,
  ConfirmSheet,
  ConflictNotice,
  Field,
  IconButton,
  ListRow,
  MainAction,
  Screen,
  ScreenHeader,
  Section,
  SegmentedControl,
  Select,
  TextArea,
  TextInput,
  useToast,
  useUndo,
  type Option,
} from "../../ui/index.js";
import { RecurrenceEditor, recurrenceFromDraft, type RecurrenceDraft, EMPTY_RECURRENCE } from "./recurrence-editor.js";
import { RescheduleSheet } from "./reschedule-sheet.js";
import { WhenEditor, emptyWhenDraft, whenFromDraft, type WhenDraft } from "./when-editor.js";
import { recurrenceLine, scheduleLine } from "./schedule-text.js";

/**
 * Create and edit.
 *
 * They are one file and two screens because they are not the same form, and pretending otherwise
 * would be a lie about the contract: `CreateTaskRequest` carries the whole task including its time
 * and its repeat, while `UpdateTaskRequest` is a patch over the text fields and importance only —
 * moving a date is `POST /tasks/:id/reschedule`, and changing a rule is a series operation. So the
 * edit screen shows the schedule as a row that opens the reschedule sheet rather than as an input
 * that would silently do nothing.
 *
 * The other rule both screens share: `null` on a patch field means «leave it alone», so emptying
 * one is `clear`, never an empty string.
 */

interface TextDraft {
  readonly title: string;
  readonly why: string;
  readonly nextAction: string;
  readonly context: string;
  readonly checklist: readonly { text: string; done: boolean }[];
  readonly importance: Importance;
  readonly kind: TaskKind;
}

const EMPTY_TEXT: TextDraft = { title: "", why: "", nextAction: "", context: "", checklist: [], importance: "normal", kind: "task" };

function importanceOptions(t: ReturnType<typeof useT>): readonly Option<Importance>[] {
  return [
    { value: "normal", label: t("task.importance_normal") },
    { value: "required", label: t("task.importance_required") },
    { value: "critical", label: t("task.importance_critical") },
  ];
}

/* --------------------------------------------------------------- creation */

export function TaskNewScreen(): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();
  const navigate = useNavigate();
  const todayLocalDate = useTodayLocalDate();

  const [text, setText] = useState<TextDraft>(EMPTY_TEXT);
  const [when, setWhen] = useState<WhenDraft>(() => emptyWhenDraft(todayLocalDate));
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>(EMPTY_RECURRENCE);
  const [goalId, setGoalId] = useState<string>("");
  const [discarding, setDiscarding] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const goals = useQuery("goals", { query: { scope: "active" } });

  const dirty = text.title.trim().length > 0;
  useBackInterceptor(dirty && !leaving ? () => setDiscarding(true) : null);
  useEffect(() => {
    if (leaving) navigate.back();
  }, [leaving, navigate]);

  const create = useMutation("createTask", {
    invalidate: ["taskList", "today", "week", "goals", "goal", "reminders"],
    onSuccess: (data) => {
      undo.offer(t("common.saved"), data.undoGroupId, ["taskList", "today", "week"]);
      navigate.replace({ name: "task", id: data.task.occurrence?.id ?? data.task.id });
    },
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const compiledWhen = whenFromDraft(when);
  const canSubmit = text.title.trim().length > 0 && compiledWhen !== null;

  const submit = (): void => {
    if (!compiledWhen) return;
    void create.mutate({
      body: {
        title: text.title.trim(),
        why: text.why.trim() || null,
        nextAction: text.nextAction.trim() || null,
        context: text.context.trim() || null,
        checklist: text.checklist.length > 0 ? text.checklist.map((item) => ({ text: item.text, done: item.done })) : null,
        importance: text.importance,
        kind: text.kind,
        when: compiledWhen,
        recurrence: recurrenceFromDraft(recurrence, text.kind),
        // Reminders follow the user's defaults; the app changes them on the settings screen.
        reminder: null,
        // Null means «the profile timezone», which is what a task created here always wants.
        timezone: null,
        goalId: goalId === "" ? null : goalId,
      },
    });
  };

  const goalOptions: readonly Option<string>[] = [{ value: "", label: t("task.goal_none") }, ...(goals.data?.goals ?? []).map((goal) => ({ value: goal.id, label: goal.title }))];

  return (
    <Screen header={<ScreenHeader title={t("tasks.new")} />} footer={<MainAction label={t("form.create")} disabled={!canSubmit} loading={create.isPending} onClick={submit} />}>
      <Section title={t("task.title_label")}>
        <div className="ip-row">
          <div className="ip-row__main">
            <TextInput value={text.title} boxed autoFocus maxLength={TEXT_LIMITS.title} placeholder={t("task.title_label")} onChange={(title) => setText({ ...text, title })} />
          </div>
        </div>
      </Section>

      <Section title={t("task.schedule")}>
        <div className="ip-row">
          <div className="ip-row__main">
            <Field label={t("task.kind")}>
              <SegmentedControl
                value={text.kind}
                options={[
                  { value: "task", label: t("task.kind_task") },
                  { value: "event", label: t("task.kind_event") },
                ]}
                onChange={(kind) => setText({ ...text, kind })}
              />
            </Field>
            <WhenEditor value={when} onChange={setWhen} todayLocalDate={todayLocalDate} />
            {when.shape === "fuzzy" ? null : <RecurrenceEditor value={recurrence} onChange={setRecurrence} kind={text.kind} todayLocalDate={todayLocalDate} />}
          </div>
        </div>
      </Section>

      <Section title={t("task.importance")}>
        <div className="ip-row">
          <div className="ip-row__main">
            <SegmentedControl value={text.importance} options={importanceOptions(t)} onChange={(importance) => setText({ ...text, importance })} />
          </div>
        </div>
      </Section>

      <DetailFields value={text} onChange={setText} />

      <Section title={t("task.goal")}>
        <div className="ip-row">
          <div className="ip-row__main">
            <Select value={goalId} options={goalOptions} onChange={setGoalId} />
          </div>
        </div>
      </Section>

      <ConfirmSheet
        open={discarding}
        onClose={() => setDiscarding(false)}
        onConfirm={() => {
          setDiscarding(false);
          setLeaving(true);
        }}
        title={t("form.discard_title")}
        confirmLabel={t("form.discard")}
        destructive
      />
    </Screen>
  );
}

/* ------------------------------------------------------------------ edit */

export function TaskEditScreen({ route }: { route: RouteOf<"taskEdit"> }): ReactNode {
  const t = useT();
  const task = useQuery("task", { params: { id: route.id } });

  return (
    <Screen header={<ScreenHeader title={t("task.edit")} subtitle={task.data?.title} />}>
      <AsyncContent query={task}>{(data) => <EditForm task={data} reload={() => void task.refetch()} />}</AsyncContent>
    </Screen>
  );
}

function EditForm({ task, reload }: { task: TaskDetail; reload: () => void }): ReactNode {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const todayLocalDate = useTodayLocalDate();

  const [text, setText] = useState<TextDraft>(() => ({
    title: task.title,
    why: task.why ?? "",
    nextAction: task.nextAction ?? "",
    context: task.context ?? "",
    checklist: task.checklist.map((item) => ({ text: item.text, done: item.done })),
    importance: task.importance,
    kind: task.kind,
  }));
  const [rescheduling, setRescheduling] = useState(false);

  const update = useMutation("updateTask", {
    invalidate: ["task", "taskList", "today", "week", "goal"],
    onSuccess: () => {
      toast.show(t("common.saved"));
      navigate.back();
    },
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const cleared = (["why", "nextAction", "context"] as const).filter((field) => (task[field] ?? "") !== "" && text[field].trim() === "");
  const checklistCleared = task.checklist.length > 0 && text.checklist.length === 0;

  const save = (): void => {
    void update.mutate({
      params: { id: task.id },
      body: {
        expectedVersion: task.version,
        title: text.title.trim() === task.title ? null : text.title.trim(),
        why: text.why.trim() || null,
        nextAction: text.nextAction.trim() || null,
        context: text.context.trim() || null,
        checklist: text.checklist.length > 0 ? text.checklist.map((item) => ({ text: item.text, done: item.done })) : null,
        importance: text.importance === task.importance ? null : text.importance,
        clear: cleared.length > 0 || checklistCleared ? [...cleared, ...(checklistCleared ? (["checklist"] as const) : [])] : null,
      },
    });
  };

  return (
    <>
      {update.conflict ? (
        <ConflictNotice
          onReload={() => {
            update.reset();
            reload();
          }}
        />
      ) : null}

      <Section title={t("task.title_label")}>
        <div className="ip-row">
          <div className="ip-row__main">
            <TextInput value={text.title} boxed maxLength={TEXT_LIMITS.title} onChange={(title) => setText({ ...text, title })} />
          </div>
        </div>
      </Section>

      <Section
        title={t("task.schedule")}
        footer={t("recurrence.label") + (task.recurrence ? `: ${recurrenceLine(task.recurrence, t, { todayLocalDate })}` : `: ${t("recurrence.none")}`)}
      >
        <ListRow
          title={scheduleLine({ schedule: task.occurrence?.schedule ?? null, fuzzy: task.fuzzy, localDate: task.occurrence?.localDate ?? null }, todayLocalDate, t)}
          subtitle={t("reschedule.title")}
          onClick={() => setRescheduling(true)}
          chevron
        />
      </Section>

      <Section title={t("task.importance")}>
        <div className="ip-row">
          <div className="ip-row__main">
            <SegmentedControl value={text.importance} options={importanceOptions(t)} onChange={(importance) => setText({ ...text, importance })} />
          </div>
        </div>
      </Section>

      <DetailFields value={text} onChange={setText} />

      <MainAction label={t("common.save")} disabled={text.title.trim().length === 0} loading={update.isPending} onClick={save} />

      <RescheduleSheet
        open={rescheduling}
        onClose={() => setRescheduling(false)}
        id={task.occurrence?.id ?? task.id}
        expectedVersion={task.occurrence?.version ?? task.version}
        schedule={task.occurrence?.schedule ?? null}
        fuzzy={task.fuzzy}
        todayLocalDate={todayLocalDate}
        onDone={reload}
      />
    </>
  );
}

/* ---------------------------------------------------------- shared fields */

function DetailFields({ value, onChange }: { value: TextDraft; onChange: (next: TextDraft) => void }): ReactNode {
  const t = useT();
  const [item, setItem] = useState("");

  return (
    <>
      <Section>
        <div className="ip-row">
          <div className="ip-row__main">
            <Field label={t("task.why")} hint={t("common.optional")}>
              <TextArea value={value.why} maxLength={TEXT_LIMITS.why} onChange={(why) => onChange({ ...value, why })} />
            </Field>
            <Field label={t("task.next_action")} hint={t("common.optional")}>
              <TextArea value={value.nextAction} rows={2} maxLength={TEXT_LIMITS.nextAction} onChange={(nextAction) => onChange({ ...value, nextAction })} />
            </Field>
            <Field label={t("task.context")} hint={t("common.optional")}>
              <TextArea value={value.context} rows={2} maxLength={TEXT_LIMITS.context} onChange={(context) => onChange({ ...value, context })} />
            </Field>
          </div>
        </div>
      </Section>

      <Section title={`${t("task.checklist")} · ${t("task.checklist_progress", { done: value.checklist.filter((entry) => entry.done).length, total: value.checklist.length })}`}>
        {value.checklist.length === 0 ? <ListRow title={t("task.checklist_empty")} muted /> : null}
        {value.checklist.map((entry, index) => (
          <div className="ip-row" key={index}>
            <div className="ip-row__main">
              <TextInput
                value={entry.text}
                boxed
                maxLength={TEXT_LIMITS.checklistItem}
                onChange={(text) => onChange({ ...value, checklist: value.checklist.map((current, position) => (position === index ? { ...current, text } : current)) })}
              />
            </div>
            <div className="ip-row__trailing">
              <IconButton
                label={t("common.delete")}
                icon="✕"
                onClick={() => onChange({ ...value, checklist: value.checklist.filter((_current, position) => position !== index) })}
              />
            </div>
          </div>
        ))}
        {value.checklist.length < TEXT_LIMITS.checklistItems ? (
          <div className="ip-row">
            <div className="ip-row__main">
              <TextInput value={item} boxed maxLength={TEXT_LIMITS.checklistItem} placeholder={t("task.checklist_add")} onChange={setItem} />
            </div>
            <div className="ip-row__trailing">
              <Button
                small
                variant="secondary"
                disabled={item.trim().length === 0}
                onClick={() => {
                  onChange({ ...value, checklist: [...value.checklist, { text: item.trim(), done: false }] });
                  setItem("");
                }}
              >
                {t("common.add")}
              </Button>
            </div>
          </div>
        ) : null}
      </Section>
    </>
  );
}
