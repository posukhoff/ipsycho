import { formatLocalDateTime, formatLocalTime, scheduleLabel, type OccurrenceScheduleView } from "./time-presentation.js";
import { localDateAt } from "./timezone.js";
import type { Importance } from "./types.js";

/**
 * What the application actually persisted for one user turn. The AI reply is free prose and
 * may promise something the actions did not do; this report is rendered from stored results
 * only, so the user can verify every change without opening the task.
 */
export type AppliedReportItem =
  | {
    kind: "task_created";
    title: string;
    timezone: string;
    importance?: Importance;
    recurring?: boolean;
    schedule: OccurrenceScheduleView | null;
    fuzzyHorizonText?: string | null;
    reviewAt?: Date | null;
    reminderAt: Date | null;
    goalTitle?: string | null;
  }
  | { kind: "task_updated"; title: string; changes: TaskFieldChange[] }
  | { kind: "task_rescheduled"; title: string; before: OccurrenceScheduleView | null; after: OccurrenceScheduleView | null; reminderAt: Date | null; reason?: string | null; fromFuzzy?: string | null }
  | { kind: "occurrence"; title: string; operation: "done" | "start" | "skip" | "cancel" | "seen" | "record_blocker"; details?: string | null }
  | { kind: "reminder"; title: string; mode: "add" | "replace" | "clear"; schedule: OccurrenceScheduleView | null; reminderAt: Date | null }
  | { kind: "series"; title: string; operation: "pause" | "resume" | "stop" | "cancel" | "edit" }
  | { kind: "goal_created"; title: string }
  | { kind: "goal_updated"; title: string }
  | { kind: "goal_plan"; goalTitle: string; tasks: Array<Extract<AppliedReportItem, { kind: "task_created" }>> }
  | { kind: "goal_linked"; taskTitle: string; goalTitle: string }
  | { kind: "goal_unlinked"; taskTitle: string; goalTitle: string }
  | { kind: "memory"; operation: "saved" | "updated" | "deleted"; content: string }
  | { kind: "settings"; operation: "timezone" | "language" | "digest" | "weekly_review" | "quiet_hours" | "snooze" | "reminder_defaults" }
  | { kind: "generic"; title: string };

export interface TaskFieldChange {
  field: "title" | "why" | "nextAction" | "context" | "importance" | "checklist" | "habitMode" | "minimumAction" | "desiredAction" | "habitTrigger";
  before: string | null;
  after: string | null;
}

const FIELD_LABELS: Record<TaskFieldChange["field"], string> = {
  title: "Название", why: "Зачем", nextAction: "Следующий шаг", context: "Контекст", importance: "Важность", checklist: "Чеклист",
  habitMode: "Режим привычки", minimumAction: "Минимальное действие", desiredAction: "Желаемое действие", habitTrigger: "Триггер привычки",
};

const IMPORTANCE_LABELS: Record<Importance, string> = { normal: "обычная", required: "обязательная", critical: "критическая" };

const OCCURRENCE_LABELS: Record<Extract<AppliedReportItem, { kind: "occurrence" }>["operation"], string> = {
  done: "✅ Выполнено", start: "▶️ Начато", skip: "⏭ Пропущено", cancel: "🚫 Отменено", seen: "👀 Увидено", record_blocker: "🧱 Блокер записан",
};

const SERIES_LABELS: Record<Extract<AppliedReportItem, { kind: "series" }>["operation"], string> = {
  pause: "приостановлена", resume: "возобновлена", stop: "остановлена, текущая задача остаётся", cancel: "отменена", edit: "расписание изменено",
};

const SETTINGS_LABELS: Record<Extract<AppliedReportItem, { kind: "settings" }>["operation"], string> = {
  timezone: "часовой пояс", language: "язык интерфейса", digest: "дайджест", weekly_review: "недельный обзор",
  quiet_hours: "тихие часы", snooze: "пауза уведомлений", reminder_defaults: "напоминания по умолчанию",
};

/** Diff of the stored mutable task fields, in the order the user reads them. */
export function taskFieldChanges(before: Record<string, unknown>, after: Record<string, unknown>): TaskFieldChange[] {
  const changes: TaskFieldChange[] = [];
  for (const field of Object.keys(FIELD_LABELS) as TaskFieldChange["field"][]) {
    const previous = describeFieldValue(field, before[field]);
    const next = describeFieldValue(field, after[field]);
    if (previous !== next) changes.push({ field, before: previous, after: next });
  }
  return changes;
}

function describeFieldValue(field: TaskFieldChange["field"], value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (field === "checklist") {
    if (!Array.isArray(value)) return null;
    const done = value.filter((item) => item && typeof item === "object" && (item as { done?: boolean }).done).length;
    return value.length ? `${value.length} ${plural(value.length, "пункт", "пункта", "пунктов")}${done ? `, выполнено ${done}` : ""}` : null;
  }
  if (field === "habitMode") return value === true ? "включён" : value === false ? "выключен" : null;
  if (field === "importance") return typeof value === "string" && value in IMPORTANCE_LABELS ? IMPORTANCE_LABELS[value as Importance] : String(value);
  if (typeof value === "string") return value.trim() || null;
  return String(value);
}

export function renderAppliedReport(items: readonly AppliedReportItem[], now: Date): string {
  const blocks: string[] = [];
  const createdTasks = items.filter((item): item is Extract<AppliedReportItem, { kind: "task_created" }> => item.kind === "task_created");
  if (createdTasks.length === 1) blocks.push(renderCreatedTask(createdTasks[0]!, now));
  if (createdTasks.length > 1) {
    blocks.push([`✅ Создано задач: ${createdTasks.length}`, ...createdTasks.map((task, index) => `${index + 1}. ${renderCreatedTaskLine(task, now)}`)].join("\n"));
  }
  for (const item of items) {
    if (item.kind === "task_created") continue;
    const block = renderItem(item, now);
    if (block) blocks.push(block);
  }
  return blocks.join("\n\n");
}

function renderItem(item: Exclude<AppliedReportItem, { kind: "task_created" }>, now: Date): string | null {
  switch (item.kind) {
    case "task_updated": {
      if (!item.changes.length) return `✏️ Задача «${item.title}» обновлена`;
      const lines = item.changes.map((change) => `• ${FIELD_LABELS[change.field]}: ${renderChange(change)}`);
      return [`✏️ Задача «${item.title}»`, ...lines].join("\n");
    }
    case "task_rescheduled": {
      const before = item.before ? scheduleLabel(item.before, now) : null;
      const after = item.after ? scheduleLabel(item.after, now) : null;
      const timezone = item.after?.timezone ?? item.before?.timezone;
      const head = `📅 Перенесено «${item.title}»: ${before ?? "—"} → ${after ?? "—"}${timezone ? ` (${timezone})` : ""}`;
      const extras: string[] = [];
      if (item.reminderAt && item.after) extras.push(`🔔 ${reminderLabel(item.reminderAt, item.after, now)}`);
      if (item.reason?.trim()) extras.push(`Причина: ${item.reason.trim()}`);
      return extras.length ? `${head}\n${extras.join("\n")}` : head;
    }
    case "occurrence":
      return `${OCCURRENCE_LABELS[item.operation]}: «${item.title}»${item.operation === "record_blocker" && item.details?.trim() ? ` — ${item.details.trim()}` : ""}`;
    case "reminder": {
      if (item.mode === "clear" || !item.reminderAt) return `🔕 Напоминаний для «${item.title}» больше нет`;
      const timezone = item.schedule?.timezone;
      const when = item.schedule ? reminderLabel(item.reminderAt, item.schedule, now, true) : formatLocalDateTime(item.reminderAt, timezone ?? "UTC", now);
      return `🔔 Напоминание «${item.title}»: ${when}${timezone ? ` (${timezone})` : ""}${item.mode === "add" ? " (добавлено к остальным)" : ""}`;
    }
    case "series":
      return `🔁 Серия «${item.title}»: ${SERIES_LABELS[item.operation]}`;
    case "goal_created":
      return `🎯 Цель создана: «${item.title}»`;
    case "goal_updated":
      return `🎯 Цель обновлена: «${item.title}»`;
    case "goal_plan":
      return [
        `🎯 Цель «${item.goalTitle}» и задач к ней: ${item.tasks.length}`,
        ...item.tasks.map((task, index) => `${index + 1}. ${renderCreatedTaskLine(task, now)}`),
      ].join("\n");
    case "goal_linked":
      return `🔗 «${item.taskTitle}» → цель «${item.goalTitle}»`;
    case "goal_unlinked":
      return `🎯 Отвязано от цели «${item.goalTitle}»: «${item.taskTitle}»`;
    case "memory":
      return `🧠 ${item.operation === "saved" ? "Запомнил" : item.operation === "updated" ? "Обновил в памяти" : "Убрал из памяти"}: «${truncate(item.content, 120)}»`;
    case "settings":
      return `⚙️ Настройки обновлены: ${SETTINGS_LABELS[item.operation]}`;
    case "generic":
      return `✅ ${item.title}`;
    default:
      return null;
  }
}

function renderCreatedTask(task: Extract<AppliedReportItem, { kind: "task_created" }>, now: Date): string {
  const lines = [`✅ Создана задача «${task.title}»${taskBadges(task)}`];
  const when = createdWhen(task, now);
  if (when) lines.push(when);
  if (task.goalTitle) lines.push(`🎯 Цель: «${task.goalTitle}»`);
  return lines.join("\n");
}

function renderCreatedTaskLine(task: Extract<AppliedReportItem, { kind: "task_created" }>, now: Date): string {
  const when = createdWhen(task, now);
  const goal = task.goalTitle ? ` · 🎯 «${task.goalTitle}»` : "";
  return `«${task.title}»${taskBadges(task)}${when ? ` — ${when}` : ""}${goal}`;
}

function taskBadges(task: Extract<AppliedReportItem, { kind: "task_created" }>): string {
  const badges = [task.importance === "critical" ? "🔴" : task.importance === "required" ? "🟡" : "", task.recurring ? "🔁" : ""].filter(Boolean);
  return badges.length ? ` ${badges.join("")}` : "";
}

function createdWhen(task: Extract<AppliedReportItem, { kind: "task_created" }>, now: Date): string | null {
  if (task.schedule) {
    const reminder = task.reminderAt ? `🔔 ${reminderLabel(task.reminderAt, task.schedule, now)}` : "🔕 без напоминания";
    return `📅 ${scheduleLabel(task.schedule, now)} (${task.schedule.timezone}) · ${reminder}`;
  }
  if (task.fuzzyHorizonText) {
    const review = task.reviewAt ? ` · пересмотр ${formatLocalDateTime(task.reviewAt, task.timezone, now)}` : "";
    return `🫧 ${task.fuzzyHorizonText}${review} (${task.timezone})`;
  }
  return null;
}

function renderChange(change: TaskFieldChange): string {
  if (change.before === null) return `«${change.after ?? ""}»`;
  if (change.after === null) return `«${change.before}» → убрано`;
  return `«${change.before}» → «${change.after}»`;
}

/** Reminder relative to the displayed anchor: same minute, same day, or a full timestamp. */
function reminderLabel(reminderAt: Date, schedule: OccurrenceScheduleView, now: Date, alwaysFull = false): string {
  const anchor = schedule.plannedStartAt ?? schedule.dueAt ?? schedule.plannedEndAt;
  if (!alwaysFull && anchor && Math.floor(anchor.getTime() / 60_000) === Math.floor(reminderAt.getTime() / 60_000)) return "в момент начала";
  const anchorDate = anchor ? localDateAt(anchor, schedule.timezone) : schedule.plannedLocalDate ?? schedule.dueLocalDate;
  if (!alwaysFull && anchorDate && localDateAt(reminderAt, schedule.timezone) === anchorDate) return formatLocalTime(reminderAt, schedule.timezone);
  return formatLocalDateTime(reminderAt, schedule.timezone, now);
}

function truncate(value: string, max: number): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
