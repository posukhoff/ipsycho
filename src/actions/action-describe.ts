import type { Reminder, ResolvedAction, ResolvedActionOf, When } from "../core/ai-contract.js";
import type { InterfaceLocale } from "../core/language.js";
import { buildSettingsPatch, type SettingsChange, type SettingsPatchFields } from "../core/settings-change.js";

/** Titles of the entities an action addresses, so a confirmation card can name what it is about. */
export interface ActionNames {
  tasks?: ReadonlyMap<string, string>;
  goals?: ReadonlyMap<string, string>;
  memory?: ReadonlyMap<string, string>;
}

type Locale = InterfaceLocale;

const C = {
  ru: {
    create: "Создать",
    plan: (goal: string, n: number) => `Создать цель «${goal}» и ${n} ${plural("ru", n, "задачу", "задачи", "задач")}`,
    updateTask: "Изменить задачу",
    titleTo: "название →",
    importanceTo: "важность →",
    importance: { critical: "критическая", required: "обязательная", normal: "обычная" },
    habitOn: "включить режим привычки",
    habitOff: "выключить режим привычки",
    checklist: "чеклист",
    why: "зачем",
    nextAction: "следующий шаг",
    context: "контекст",
    series: " (всю серию)",
    done: "Отметить выполненной",
    start: "Начать",
    skip: "Пропустить",
    cancel: "Отменить",
    rescheduleSeries: "Изменить расписание серии",
    reschedule: "Перенести",
    clearReminders: "Убрать напоминания",
    addReminder: "Добавить напоминание",
    replaceReminder: "Заменить напоминание",
    createGoal: "Создать цель",
    link: "Связать",
    withGoal: "с целью",
    unlink: "Отвязать",
    fromGoal: "от цели",
    goalTo: "Цель →",
    goalStatus: { completed: "завершена", paused: "на паузе", cancelled: "отменена", active: "активна" },
    updateGoal: "Изменить цель",
    deleteMemory: "Удалить запись из памяти",
    updateMemory: "Изменить запись в памяти",
    remember: "Запомнить",
    sensitive: " (чувствительное)",
    settings: "Изменить настройки",
    by: "до",
    min: "мин",
    bypass: " — игнорируя тихие часы",
    ofDue: "срока",
    ofEnd: "конца",
    ofStart: "начала",
    before: (n: number) => `за ${n} мин до`,
    after: (n: number) => `через ${n} мин после`,
    at: "в момент",
    atTime: "в",
    days: "дн",
    ops: {
      timezone: "часовой пояс →",
      language: "язык",
      digest: "сводка",
      weekly_review: "недельный обзор",
      quiet_hours: "тихие часы",
      snooze: "пауза уведомлений",
      reminder_defaults: "напоминания по умолчанию",
    },
  },
  uk: {
    create: "Створити",
    plan: (goal: string, n: number) => `Створити ціль «${goal}» і ${n} ${plural("uk", n, "завдання", "завдання", "завдань")}`,
    updateTask: "Змінити завдання",
    titleTo: "назва →",
    importanceTo: "важливість →",
    importance: { critical: "критична", required: "обов'язкова", normal: "звичайна" },
    habitOn: "увімкнути режим звички",
    habitOff: "вимкнути режим звички",
    checklist: "чекліст",
    why: "навіщо",
    nextAction: "наступний крок",
    context: "контекст",
    series: " (усю серію)",
    done: "Позначити виконаним",
    start: "Почати",
    skip: "Пропустити",
    cancel: "Скасувати",
    rescheduleSeries: "Змінити розклад серії",
    reschedule: "Перенести",
    clearReminders: "Прибрати нагадування",
    addReminder: "Додати нагадування",
    replaceReminder: "Замінити нагадування",
    createGoal: "Створити ціль",
    link: "Пов'язати",
    withGoal: "з ціллю",
    unlink: "Відв'язати",
    fromGoal: "від цілі",
    goalTo: "Ціль →",
    goalStatus: { completed: "завершена", paused: "на паузі", cancelled: "скасована", active: "активна" },
    updateGoal: "Змінити ціль",
    deleteMemory: "Видалити запис із пам'яті",
    updateMemory: "Змінити запис у пам'яті",
    remember: "Запам'ятати",
    sensitive: " (чутливе)",
    settings: "Змінити налаштування",
    by: "до",
    min: "хв",
    bypass: " — ігноруючи тихі години",
    ofDue: "терміну",
    ofEnd: "кінця",
    ofStart: "початку",
    before: (n: number) => `за ${n} хв до`,
    after: (n: number) => `через ${n} хв після`,
    at: "у момент",
    atTime: "о",
    days: "дн",
    ops: {
      timezone: "часовий пояс →",
      language: "мова",
      digest: "зведення",
      weekly_review: "тижневий огляд",
      quiet_hours: "тихі години",
      snooze: "пауза сповіщень",
      reminder_defaults: "нагадування за замовчуванням",
    },
  },
  en: {
    create: "Create",
    plan: (goal: string, n: number) => `Create goal “${goal}” with ${n} ${n === 1 ? "task" : "tasks"}`,
    updateTask: "Edit task",
    titleTo: "title →",
    importanceTo: "importance →",
    importance: { critical: "critical", required: "required", normal: "normal" },
    habitOn: "enable habit mode",
    habitOff: "disable habit mode",
    checklist: "checklist",
    why: "why",
    nextAction: "next step",
    context: "context",
    series: " (whole series)",
    done: "Mark done",
    start: "Start",
    skip: "Skip",
    cancel: "Cancel",
    rescheduleSeries: "Change the series schedule",
    reschedule: "Move",
    clearReminders: "Remove reminders",
    addReminder: "Add reminder",
    replaceReminder: "Replace reminder",
    createGoal: "Create goal",
    link: "Link",
    withGoal: "to goal",
    unlink: "Unlink",
    fromGoal: "from goal",
    goalTo: "Goal →",
    goalStatus: { completed: "completed", paused: "paused", cancelled: "cancelled", active: "active" },
    updateGoal: "Edit goal",
    deleteMemory: "Delete a memory note",
    updateMemory: "Edit a memory note",
    remember: "Remember",
    sensitive: " (sensitive)",
    settings: "Change settings",
    by: "by",
    min: "min",
    bypass: " — ignoring quiet hours",
    ofDue: "the deadline",
    ofEnd: "the end",
    ofStart: "the start",
    before: (n: number) => `${n} min before`,
    after: (n: number) => `${n} min after`,
    at: "at",
    atTime: "at",
    days: "d",
    ops: {
      timezone: "timezone →",
      language: "language",
      digest: "briefing",
      weekly_review: "weekly review",
      quiet_hours: "quiet hours",
      snooze: "notification pause",
      reminder_defaults: "default reminders",
    },
  },
} as const;

/** Pending-confirmation wording: what will happen if the user taps Confirm, naming the target when its title is known. */
export function describeAction(action: ResolvedAction, locale: Locale = "ru", names: ActionNames = {}): string {
  const c = C[locale];
  const q = (title: string) => (locale === "en" ? `“${title}”` : `«${title}»`);
  const taskName = (id: string) => {
    const title = names.tasks?.get(id);
    return title ? ` ${q(title)}` : "";
  };
  const goalName = (id: string | null) => {
    const title = id ? names.goals?.get(id) : undefined;
    return title ? ` ${q(title)}` : "";
  };
  switch (action.type) {
    case "create_task":
      return `${c.create} ${q(action.body.title.trim())}${describeWhen(action.body.when, locale)}`;
    case "plan":
      return c.plan(action.goal.title, action.tasks.length);
    case "update_task": {
      const patch = action.patch;
      const parts: string[] = [];
      if (patch.title !== null) parts.push(`${c.titleTo} ${q(patch.title)}`);
      if (patch.importance !== null) parts.push(`${c.importanceTo} ${c.importance[patch.importance]}`);
      if (patch.habit !== null) parts.push("minimumAction" in patch.habit ? c.habitOn : c.habitOff);
      if (patch.checklist !== null) parts.push(`${c.checklist} (${patch.checklist.length})`);
      if (patch.why !== null) parts.push(c.why);
      if (patch.nextAction !== null) parts.push(c.nextAction);
      if (patch.context !== null) parts.push(c.context);
      const head = `${c.updateTask}${taskName(action.taskId)}`;
      return parts.length ? `${head}: ${parts.join(", ")}` : head;
    }
    case "set_task_state": {
      const target = taskName(action.target.taskId);
      const series = action.target.kind === "series" ? c.series : "";
      if (action.state === "done") return `${c.done}${target}`;
      if (action.state === "started") return `${c.start}${target}`;
      if (action.state === "skipped") return `${c.skip}${target}`;
      return `${c.cancel}${target}${series}`;
    }
    case "reschedule":
      return `${action.target.kind === "series" ? c.rescheduleSeries : c.reschedule}${taskName(action.target.taskId)}${describeWhen(action.when, locale)}${action.reason ? ` (${action.reason})` : ""}`;
    case "set_reminder": {
      const target = taskName(action.target.taskId);
      if (action.mode === "clear") return `${c.clearReminders}${target}`;
      return `${action.mode === "add" ? c.addReminder : c.replaceReminder}${target}${action.reminder ? describeReminder(action.reminder, locale) : ""}`;
    }
    case "goal":
      if (action.op === "create") return `${c.createGoal} ${q(action.title ?? "")}`;
      if (action.op === "link") return `${c.link}${action.taskId ? taskName(action.taskId) : ""} ${c.withGoal}${goalName(action.goalId)}`.replace(/\s+/g, " ").trim();
      if (action.op === "unlink") return `${c.unlink}${action.taskId ? taskName(action.taskId) : ""} ${c.fromGoal}${goalName(action.goalId)}`.replace(/\s+/g, " ").trim();
      return action.status ? `${c.goalTo}${goalName(action.goalId)} ${c.goalStatus[action.status]}`.replace(/\s+/g, " ") : `${c.updateGoal}${goalName(action.goalId)}`;
    case "memory":
      if (action.op === "delete")
        return `${c.deleteMemory}${action.memoryId && names.memory?.get(action.memoryId) ? `: ${q(names.memory.get(action.memoryId)!.slice(0, 80))}` : ""}`;
      if (action.op === "update") return action.content ? `${c.updateMemory}: ${q(action.content.trim().slice(0, 120))}` : c.updateMemory;
      return `${c.remember}${action.sensitive ? c.sensitive : ""}: ${q((action.content ?? "").trim().slice(0, 120))}`;
    case "settings":
      return `${c.settings}: ${settingsOperationLabel(action, locale)}`;
  }
}

export function describeWhen(when: When, locale: Locale = "ru"): string {
  const c = C[locale];
  const date = (value: string) => value.split("-").slice(1).reverse().join(".");
  switch (when.mode) {
    case "fuzzy":
      return ` — ${when.horizonText}`;
    case "deadline":
      return ` — ${c.by} ${date(when.date)}${when.time ? ` ${when.time}` : ""}`;
    case "date":
      return ` — ${date(when.date)}`;
    case "exact":
      return ` — ${date(when.date)} ${when.time}${when.durationMinutes ? ` (${when.durationMinutes} ${c.min})` : ""}`;
  }
}

function describeReminder(reminder: Reminder, locale: Locale): string {
  const c = C[locale];
  const bypass = reminder.quiet === "bypass" ? c.bypass : "";
  if (reminder.kind === "at") return ` ${reminder.date.split("-").slice(1).reverse().join(".")} ${reminder.time}${bypass}`;
  if (reminder.kind === "offset") {
    const anchor = reminder.anchor === "due" ? c.ofDue : reminder.anchor === "end" ? c.ofEnd : c.ofStart;
    const offset = reminder.minutes < 0 ? c.before(Math.abs(reminder.minutes)) : reminder.minutes > 0 ? c.after(reminder.minutes) : c.at;
    return ` ${offset} ${anchor}${bypass}`;
  }
  return ` ${c.atTime} ${reminder.time}${reminder.daysOffset ? ` (${reminder.daysOffset > 0 ? "+" : ""}${reminder.daysOffset} ${c.days})` : ""}${bypass}`;
}

function settingsOperationLabel(action: ResolvedActionOf<"settings">, locale: Locale): string {
  const c = C[locale];
  const values: string[] = [];
  switch (action.operation) {
    case "timezone":
      return `${c.ops.timezone} ${action.timezone ?? ""}`;
    case "language":
      return `${c.ops.language}${action.language ? ` → ${action.language}` : ""}`;
    case "digest":
      if (action.digestKind) values.push(action.digestKind);
      if (action.enabled !== null) values.push(action.enabled ? "on" : "off");
      if (action.time) values.push(action.time);
      return `${c.ops.digest}${values.length ? ` → ${values.join(" ")}` : ""}`;
    case "weekly_review":
      if (action.enabled !== null) values.push(action.enabled ? "on" : "off");
      if (action.weekday !== null) values.push(`${c.days}${action.weekday}`);
      if (action.time) values.push(action.time);
      return `${c.ops.weekly_review}${values.length ? ` → ${values.join(" ")}` : ""}`;
    case "quiet_hours":
      if (action.enabled !== null) values.push(action.enabled ? "on" : "off");
      if (action.weekdayStart && action.weekdayEnd) values.push(`${action.weekdayStart}–${action.weekdayEnd}`);
      if (action.weekendStart && action.weekendEnd) values.push(`${action.weekendStart}–${action.weekendEnd}`);
      return `${c.ops.quiet_hours}${values.length ? ` → ${values.join(", ")}` : ""}`;
    case "snooze":
      return `${c.ops.snooze}${action.snoozeUntilDate ? ` → ${action.snoozeUntilDate.split("-").slice(1).reverse().join(".")}${action.snoozeUntilTime ? ` ${action.snoozeUntilTime}` : ""}` : ""}`;
    case "reminder_defaults":
      return c.ops.reminder_defaults;
  }
}

function plural(locale: "ru" | "uk", count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return locale === "uk" ? many : many;
}

/** The user_settings patch for a resolved settings action, through the same builder the commands use. */
export function settingsPatchForAction(action: ResolvedActionOf<"settings">, current: { timezone: string }, snoozeUntil: Date | null): { patch: SettingsPatchFields } {
  return { patch: buildSettingsPatch(settingsChangeFromAction(action, snoozeUntil), current) };
}

export function settingsChangeFromAction(action: ResolvedActionOf<"settings">, snoozeUntil: Date | null): SettingsChange {
  switch (action.operation) {
    case "timezone":
      return { operation: "timezone", timezone: action.timezone, applyTo: action.applyTimezoneTo === "all" ? "all" : "profile_only" };
    case "language":
      return { operation: "language", language: action.language };
    case "digest":
      return { operation: "digest", kind: action.digestKind ?? "morning", enabled: action.enabled ?? true, time: action.time };
    case "weekly_review":
      return { operation: "weekly_review", enabled: action.enabled ?? true, weekday: action.weekday, time: action.time };
    case "quiet_hours":
      return {
        operation: "quiet_hours",
        enabled: action.enabled ?? true,
        weekdayStart: action.weekdayStart,
        weekdayEnd: action.weekdayEnd,
        weekendStart: action.weekendStart,
        weekendEnd: action.weekendEnd,
      };
    case "snooze":
      return { operation: "snooze", until: snoozeUntil };
    case "reminder_defaults":
      return {
        operation: "reminder_defaults",
        eventOffsets: action.eventOffsets,
        plannedTaskOffsetMinutes: action.plannedTaskOffsetMinutes,
        criticalPostDueMinutes: action.criticalPostDueMinutes,
      };
  }
}
