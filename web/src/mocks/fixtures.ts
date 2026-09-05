import type {
  ConsentResponse,
  GoalDetail,
  GoalsResponse,
  MemoryResponse,
  MeResponse,
  OccurrenceDetail,
  PausedSeriesResponse,
  ProfileResponse,
  RemindersResponse,
  RescheduleOptions,
  SettingsResponse,
  TaskDetail,
  TaskGroup,
  TaskListResponse,
  TaskListRow,
  TimezoneSearchResponse,
  TodayResponse,
  WeekResponse,
} from "../api/contracts.js";

/**
 * One coherent workspace, frozen on Saturday 5 September 2026 in Europe/Kyiv.
 *
 * These are not filler. Every schedule shape the contract can carry appears at least once — an
 * exact time, a window, a date with no clock time, a deadline, a fuzzy task with a review day, and
 * a weekly repeat with an end date and two skipped dates — because a screen that was only ever
 * built against «task at 10:00» breaks the first time it meets a task with no time at all.
 *
 * The overdue row, the in-progress row, the stale week pick and the sensitive memory entry are here
 * for the same reason: they are the states the bot's screens actually had to handle.
 */

export const TZ = "Europe/Kyiv";
export const TODAY = "2026-09-05";
/** Monday of the week a pick made today is for; `targetWeekStart("2026-09-05")`. */
export const WEEK_START = "2026-08-31";

const WORKSPACE_ID = "6f1a2c40-0000-4000-8000-000000000001";
const USER_ID = "6f1a2c40-0000-4000-8000-000000000002";

const ids = {
  standupTask: "11111111-1111-4111-8111-111111111101",
  standupOccurrence: "11111111-1111-4111-8111-111111111102",
  standupNext: "11111111-1111-4111-8111-111111111103",
  reviewTask: "22222222-2222-4222-8222-222222222201",
  reviewOccurrence: "22222222-2222-4222-8222-222222222202",
  taxTask: "33333333-3333-4333-8333-333333333301",
  taxOccurrence: "33333333-3333-4333-8333-333333333302",
  dentistTask: "44444444-4444-4444-8444-444444444401",
  dentistOccurrence: "44444444-4444-4444-8444-444444444402",
  bookTask: "55555555-5555-4555-8555-555555555501",
  gymTask: "66666666-6666-4666-8666-666666666601",
  callTask: "77777777-7777-4777-8777-777777777701",
  callOccurrence: "77777777-7777-4777-8777-777777777702",
  goalHealth: "88888888-8888-4888-8888-888888888801",
  goalMove: "88888888-8888-4888-8888-888888888802",
  goalDone: "88888888-8888-4888-8888-888888888803",
  deliveryStandup: "99999999-9999-4999-8999-999999999901",
  deliveryTax: "99999999-9999-4999-8999-999999999902",
  deliveryDentist: "99999999-9999-4999-8999-999999999903",
  ruleStandup: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
  ruleTax: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02",
  memorySleep: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01",
  memoryDoctor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02",
  memoryWorkStyle: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb03",
  undoGroup: "cccccccc-cccc-4ccc-8ccc-cccccccccc01",
  journalDone: "dddddddd-dddd-4ddd-8ddd-dddddddddd01",
  journalMoved: "dddddddd-dddd-4ddd-8ddd-dddddddddd02",
} as const;

const emptySchedule = { timezone: TZ, plannedStartAt: null, plannedEndAt: null, plannedLocalDate: null, dueAt: null, dueLocalDate: null } as const;

/* ------------------------------------------------------------------ rows */

/** An exact time, today, already in progress. */
const standupRow: TaskListRow = {
  taskId: ids.standupTask,
  taskVersion: 4,
  occurrenceId: ids.standupOccurrence,
  occurrenceVersion: 2,
  title: "Созвон с командой",
  importance: "required",
  kind: "event",
  taskStatus: "active",
  timeMode: "point",
  timezone: TZ,
  occurrenceStatus: "in_progress",
  schedule: { ...emptySchedule, plannedStartAt: "2026-09-05T07:00:00.000Z" },
  fuzzy: null,
  localDate: TODAY,
  overdue: false,
  recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR",
  recurrenceEndLocalDate: "2026-12-18",
  completedAt: null,
  completedLate: false,
  nextReminderAt: null,
};

/** The next date of the same series: what the collapsed group hides. */
const standupNextRow: TaskListRow = {
  ...standupRow,
  occurrenceId: ids.standupNext,
  occurrenceVersion: 1,
  occurrenceStatus: "scheduled",
  schedule: { ...emptySchedule, plannedStartAt: "2026-09-07T07:00:00.000Z" },
  localDate: "2026-09-07",
  nextReminderAt: "2026-09-07T06:45:00.000Z",
};

/** A window: start plus end, one afternoon. */
const reviewRow: TaskListRow = {
  taskId: ids.reviewTask,
  taskVersion: 1,
  occurrenceId: ids.reviewOccurrence,
  occurrenceVersion: 1,
  title: "Разобрать почту за неделю",
  importance: "normal",
  kind: "task",
  taskStatus: "active",
  timeMode: "window",
  timezone: TZ,
  occurrenceStatus: "scheduled",
  schedule: { ...emptySchedule, plannedStartAt: "2026-09-05T11:00:00.000Z", plannedEndAt: "2026-09-05T13:00:00.000Z" },
  fuzzy: null,
  localDate: TODAY,
  overdue: false,
  recurrenceRule: null,
  recurrenceEndLocalDate: null,
  completedAt: null,
  completedLate: false,
  nextReminderAt: null,
};

/** A deadline with an exact hour, already past: the overdue state. */
const taxRow: TaskListRow = {
  taskId: ids.taxTask,
  taskVersion: 2,
  occurrenceId: ids.taxOccurrence,
  occurrenceVersion: 3,
  title: "Подать декларацию",
  importance: "critical",
  kind: "task",
  taskStatus: "active",
  timeMode: "deadline",
  timezone: TZ,
  occurrenceStatus: "open",
  schedule: { ...emptySchedule, dueAt: "2026-09-03T15:00:00.000Z" },
  fuzzy: null,
  localDate: "2026-09-03",
  overdue: true,
  recurrenceRule: null,
  recurrenceEndLocalDate: null,
  completedAt: null,
  completedLate: false,
  nextReminderAt: "2026-09-05T16:00:00.000Z",
};

/** A date with no clock time at all. */
const dentistRow: TaskListRow = {
  taskId: ids.dentistTask,
  taskVersion: 1,
  occurrenceId: ids.dentistOccurrence,
  occurrenceVersion: 1,
  title: "Записаться к стоматологу",
  importance: "normal",
  kind: "task",
  taskStatus: "active",
  timeMode: "window",
  timezone: TZ,
  occurrenceStatus: "scheduled",
  schedule: { ...emptySchedule, plannedLocalDate: "2026-09-09" },
  fuzzy: null,
  localDate: "2026-09-09",
  overdue: false,
  recurrenceRule: null,
  recurrenceEndLocalDate: null,
  completedAt: null,
  completedLate: false,
  nextReminderAt: "2026-09-09T06:00:00.000Z",
};

/** Fuzzy: a horizon in words and the day it comes back to be decided. No occurrence at all. */
const bookRow: TaskListRow = {
  taskId: ids.bookTask,
  taskVersion: 1,
  occurrenceId: null,
  occurrenceVersion: null,
  title: "Дочитать книгу про привычки",
  importance: "normal",
  kind: "task",
  taskStatus: "active",
  timeMode: "fuzzy",
  timezone: TZ,
  occurrenceStatus: null,
  schedule: null,
  fuzzy: { horizonText: "когда-нибудь в сентябре", reviewAt: "2026-09-15T06:00:00.000Z", timezone: TZ },
  localDate: null,
  overdue: false,
  recurrenceRule: null,
  recurrenceEndLocalDate: null,
  completedAt: null,
  completedLate: false,
  nextReminderAt: null,
};

/** In the pool with no date, taken for the week and never started: the stale pick. */
const callRow: TaskListRow = {
  taskId: ids.callTask,
  taskVersion: 5,
  occurrenceId: ids.callOccurrence,
  occurrenceVersion: 1,
  title: "Позвонить маме",
  importance: "normal",
  kind: "task",
  taskStatus: "active",
  timeMode: "window",
  timezone: TZ,
  occurrenceStatus: "scheduled",
  schedule: { ...emptySchedule, plannedLocalDate: "2026-09-06" },
  fuzzy: null,
  localDate: "2026-09-06",
  overdue: false,
  recurrenceRule: null,
  recurrenceEndLocalDate: null,
  completedAt: null,
  completedLate: false,
  nextReminderAt: null,
};

function group(rows: TaskListRow[], overrides: Partial<TaskGroup> = {}): TaskGroup {
  const lead = rows[0]!;
  return {
    key: lead.occurrenceId ?? lead.taskId,
    title: lead.title,
    importance: lead.importance,
    recurrenceRule: lead.recurrenceRule,
    rows,
    leadIndex: 0,
    pastCount: rows.filter((row) => row.overdue).length,
    ...overrides,
  };
}

/* -------------------------------------------------------------- settings */

export const settings: SettingsResponse = {
  version: 12,
  timezone: TZ,
  digestTimezone: TZ,
  pinnedLanguage: null,
  telegramLanguage: "ru",
  resolvedLocale: "ru",
  morningDigest: { enabled: true, time: "09:00" },
  eveningReferenceTime: "20:00",
  weeklyReview: { enabled: true, weekday: 7, time: "20:00" },
  quietHours: { enabled: true, weekdayStart: "22:00", weekdayEnd: "08:00", weekendStart: "23:00", weekendEnd: "09:00", timezone: TZ },
  notificationsSnoozedUntil: null,
  reminderDefaults: { eventOffsetsMinutes: [-60, -15], plannedTaskOffsetMinutes: 0, criticalPostDueMinutes: 60 },
  escalationMinutes: { normal: 60, required: 30, critical: 15 },
  onboardingCompletedAt: "2026-04-11T08:12:00.000Z",
  historyMessageCount: 34,
};

export const consents: ConsentResponse = {
  consents: [
    { scope: "text", granted: true, provider: "openai", version: "2026-08-voice" },
    { scope: "voice", granted: false, provider: "openai", version: "2026-08-voice" },
  ],
};

export const me: MeResponse = {
  access: { userId: USER_ID, workspaceId: WORKSPACE_ID, status: "active", isOwner: true },
  locale: "ru",
  timezone: TZ,
  todayLocalDate: TODAY,
  ai: { status: "enabled", configured: true, provider: "openai", rateLimited: false },
  consents: consents.consents,
  settings,
  commit: "0a1b2c3",
  deletionGraceDays: 14,
};

/* ----------------------------------------------------------------- lists */

const COUNTS = { overdue: 1, today: 3, week: 5, month: 6, all: 6, nodate: 1 } as const;

/**
 * `scopeMatches` keeps anything already past in every window and drops an undated task from all of
 * them but `nodate`. A mock that answered the same five groups to every tab would let a screen ship
 * without ever meeting the empty-tab or fuzzy-row case.
 */
const GROUPS_BY_SCOPE: Record<string, TaskGroup[]> = {
  overdue: [group([taxRow])],
  today: [group([taxRow]), group([standupRow, standupNextRow]), group([reviewRow])],
  week: [group([taxRow]), group([standupRow, standupNextRow]), group([reviewRow]), group([callRow]), group([dentistRow])],
  month: [group([taxRow]), group([standupRow, standupNextRow]), group([reviewRow]), group([callRow]), group([dentistRow]), group([bookRow])],
  all: [group([taxRow]), group([standupRow, standupNextRow]), group([reviewRow]), group([callRow]), group([dentistRow]), group([bookRow])],
  nodate: [group([bookRow])],
};

export function taskListForScope(scope: string): TaskListResponse {
  const key = scope in GROUPS_BY_SCOPE ? scope : "week";
  const groups = GROUPS_BY_SCOPE[key]!;
  return {
    scope: key as TaskListResponse["scope"],
    groups,
    page: { page: 0, pages: 1, pageSize: 30, total: groups.length, hasMore: false },
    counts: { ...COUNTS },
    pausedCount: 1,
    todayLocalDate: TODAY,
    timezone: TZ,
  };
}

export const taskList: TaskListResponse = taskListForScope("week");

export const today: TodayResponse = {
  localDate: TODAY,
  timezone: TZ,
  groups: [group([standupRow, standupNextRow]), group([reviewRow])],
  page: { page: 0, pages: 1, pageSize: 30, total: 2, hasMore: false },
  staleCount: 1,
  completedCount: 2,
};

export const pausedSeries: PausedSeriesResponse = {
  rows: [
    {
      taskId: ids.gymTask,
      version: 3,
      title: "Зал",
      importance: "normal",
      recurrence: {
        rule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH",
        frequency: "weekly",
        interval: 1,
        weekdays: ["TU", "TH"],
        monthDays: [],
        localTimes: ["19:00"],
        timezone: TZ,
        endLocalDate: null,
        excludedLocalDates: [],
        missPolicy: "expire",
      },
      recurrenceRule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH",
      recurrenceEndLocalDate: null,
      missPolicy: "expire",
      pausedAt: "2026-08-14T18:20:00.000Z",
    },
  ],
  page: { page: 0, pages: 1, pageSize: 30, total: 1, hasMore: false },
};

/* ---------------------------------------------------------------- detail */

const standupOccurrenceDetail: OccurrenceDetail = {
  id: ids.standupOccurrence,
  version: 2,
  status: "in_progress",
  schedule: { ...emptySchedule, plannedStartAt: "2026-09-05T07:00:00.000Z" },
  overdue: false,
  localDate: TODAY,
  expiresAt: null,
  elapsedAt: null,
  completedAt: null,
  completedLate: false,
  skipReason: null,
  recurrenceKey: "2026-09-05T10:00",
  dstAdjusted: false,
};

export const taskDetail: TaskDetail = {
  id: ids.standupTask,
  version: 4,
  title: "Созвон с командой",
  why: "Синхронизация по спринту — без неё неделя расходится",
  nextAction: "Открыть доску и выписать три пункта на обсуждение",
  context: null,
  kind: "event",
  importance: "required",
  status: "active",
  timeMode: "point",
  timezone: TZ,
  occurrence: standupOccurrenceDetail,
  fuzzy: null,
  recurrence: {
    rule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR",
    frequency: "weekly",
    interval: 1,
    weekdays: ["MO", "WE", "FR"],
    monthDays: [],
    localTimes: ["10:00"],
    timezone: TZ,
    endLocalDate: "2026-12-18",
    // A repeat with an end date and two dates it skips: the shape the create form has to round-trip.
    excludedLocalDates: ["2026-10-12", "2026-11-02"],
    missPolicy: "expire",
  },
  siblingOccurrences: [
    {
      ...standupOccurrenceDetail,
      id: ids.standupNext,
      version: 1,
      status: "scheduled",
      schedule: { ...emptySchedule, plannedStartAt: "2026-09-07T07:00:00.000Z" },
      localDate: "2026-09-07",
      recurrenceKey: "2026-09-07T10:00",
    },
  ],
  checklist: [
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01", text: "Собрать вопросы", done: true },
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02", text: "Проверить прошлые решения", done: false },
  ],
  goal: { id: ids.goalMove, title: "Довести проект до релиза", version: 2 },
  reminders: [
    {
      ruleId: ids.ruleStandup,
      purpose: "user_reminder",
      origin: "default",
      quietPolicy: "respect",
      nextAt: "2026-09-07T06:45:00.000Z",
      label: { kind: "offset", anchor: "planned_start", offsetMinutes: -15 },
    },
  ],
  nextReminderAt: "2026-09-07T06:45:00.000Z",
  journal: [
    {
      id: ids.journalMoved,
      eventType: "occurrence:rescheduled",
      occurrenceId: ids.standupOccurrence,
      at: "2026-09-04T09:10:00.000Z",
      details: "Перенос: ждал ответа",
      byUser: true,
    },
    { id: ids.journalDone, eventType: "occurrence:done", occurrenceId: ids.standupNext, at: "2026-09-02T07:35:00.000Z", details: null, byUser: true },
  ],
  rescheduleReasonRequired: true,
  pickedWeekStart: null,
  canPauseSeries: false,
  createdAt: "2026-04-20T09:00:00.000Z",
  updatedAt: "2026-09-04T09:10:00.000Z",
};

export const rescheduleOptions: RescheduleOptions = {
  reasonRequired: true,
  presets: ["1h", "evening", "tomorrow"],
  presetTimes: { "1h": "2026-09-05T08:00:00.000Z", evening: "2026-09-05T17:00:00.000Z", tomorrow: "2026-09-06T07:00:00.000Z" },
  timezone: TZ,
  hasSeries: true,
};

/* ----------------------------------------------------------------- goals */

export const goals: GoalsResponse = {
  scope: "active",
  goals: [
    {
      id: ids.goalMove,
      version: 2,
      title: "Довести проект до релиза",
      why: "Иначе он будет тянуться ещё квартал",
      status: "active",
      targetLocalDate: "2026-11-30",
      reviewEnabled: true,
      nextReviewAt: "2026-09-13T17:00:00.000Z",
      taskCount: 3,
      idleDays: 2,
      updatedAt: "2026-09-03T16:40:00.000Z",
    },
    {
      id: ids.goalHealth,
      version: 1,
      title: "Вернуть режим сна",
      why: null,
      status: "active",
      targetLocalDate: null,
      reviewEnabled: true,
      nextReviewAt: null,
      taskCount: 0,
      // Nothing has moved it for three weeks: the goal the weekly card raises.
      idleDays: 21,
      updatedAt: "2026-08-15T20:00:00.000Z",
    },
  ],
  page: { page: 0, pages: 1, pageSize: 30, total: 2, hasMore: false },
  counts: { active: 2, paused: 0, completed: 1 },
};

export const goalDetail: GoalDetail = {
  goal: goals.goals[0]!,
  tasks: [
    {
      taskId: ids.standupTask,
      occurrenceId: ids.standupOccurrence,
      title: "Созвон с командой",
      detail: "Открыть доску и выписать три пункта",
      dueLocalDate: null,
      importance: "required",
      status: "active",
      overdue: false,
    },
    {
      taskId: ids.reviewTask,
      occurrenceId: ids.reviewOccurrence,
      title: "Разобрать почту за неделю",
      detail: null,
      dueLocalDate: null,
      importance: "normal",
      status: "active",
      overdue: false,
    },
    {
      taskId: ids.bookTask,
      occurrenceId: null,
      title: "Дочитать книгу про привычки",
      detail: "когда-нибудь в сентябре",
      dueLocalDate: null,
      importance: "normal",
      status: "active",
      overdue: false,
    },
  ],
};

/* ------------------------------------------------------------------ week */

export const week: WeekResponse = {
  targetWeekStart: WEEK_START,
  todayLocalDate: TODAY,
  timezone: TZ,
  rows: [
    { taskId: ids.taxTask, version: 2, title: "Подать декларацию", importance: "critical", pickedWeekStart: WEEK_START, picked: true, stale: false, overdue: true },
    { taskId: ids.callTask, version: 5, title: "Позвонить маме", importance: "normal", pickedWeekStart: "2026-08-24", picked: false, stale: true, overdue: false },
    { taskId: ids.bookTask, version: 1, title: "Дочитать книгу про привычки", importance: "normal", pickedWeekStart: null, picked: false, stale: false, overdue: false },
    { taskId: ids.dentistTask, version: 1, title: "Записаться к стоматологу", importance: "normal", pickedWeekStart: null, picked: false, stale: false, overdue: false },
  ],
  page: { page: 0, pages: 1, pageSize: 30, total: 4, hasMore: false },
  pickLimit: 7,
  pickedCount: 1,
  summary: { done: 4, takenNotStarted: 1 },
  previousWeek: { start: "2026-08-24", end: "2026-08-30" },
};

/* ------------------------------------------------------------- reminders */

export const reminders: RemindersResponse = {
  rows: [
    {
      deliveryId: ids.deliveryTax,
      taskId: ids.taxTask,
      occurrenceId: ids.taxOccurrence,
      title: "Подать декларацию",
      scheduledFor: "2026-09-05T16:00:00.000Z",
      intendedFor: "2026-09-03T16:00:00.000Z",
      timezone: TZ,
      localDate: TODAY,
      purpose: "follow_up",
      followUp: true,
    },
    {
      deliveryId: ids.deliveryDentist,
      taskId: ids.dentistTask,
      occurrenceId: ids.dentistOccurrence,
      title: "Записаться к стоматологу",
      scheduledFor: "2026-09-09T06:00:00.000Z",
      intendedFor: "2026-09-09T06:00:00.000Z",
      timezone: TZ,
      localDate: "2026-09-09",
      purpose: "user_reminder",
      followUp: false,
    },
    {
      deliveryId: ids.deliveryStandup,
      taskId: ids.standupTask,
      occurrenceId: ids.standupNext,
      title: "Созвон с командой",
      scheduledFor: "2026-09-07T06:45:00.000Z",
      intendedFor: "2026-09-07T06:45:00.000Z",
      timezone: TZ,
      localDate: "2026-09-07",
      purpose: "user_reminder",
      followUp: false,
    },
  ],
  page: { page: 0, pages: 1, pageSize: 30, total: 3, hasMore: false },
  timezone: TZ,
  todayLocalDate: TODAY,
  notificationsSnoozedUntil: null,
};

/* ---------------------------------------------------------------- memory */

export const memory: MemoryResponse = {
  rows: [
    {
      id: ids.memoryWorkStyle,
      version: 2,
      type: "preference",
      content: "Не ставить встречи до 10:00",
      sensitive: false,
      source: "ai",
      updatedAt: "2026-08-30T11:00:00.000Z",
      createdAt: "2026-05-02T08:00:00.000Z",
    },
    {
      id: ids.memoryDoctor,
      version: 1,
      type: "note",
      content: "Приём у врача раз в полгода, следующий в ноябре",
      sensitive: true,
      source: "ai",
      updatedAt: "2026-08-20T19:30:00.000Z",
      createdAt: "2026-08-20T19:30:00.000Z",
    },
    {
      id: ids.memorySleep,
      version: 3,
      type: "decision",
      content: "Ложиться до полуночи в будни",
      sensitive: false,
      source: "user",
      updatedAt: "2026-08-01T21:00:00.000Z",
      createdAt: "2026-06-14T21:00:00.000Z",
    },
  ],
  page: { page: 0, pages: 1, pageSize: 30, total: 3, hasMore: false },
  sensitiveCount: 1,
};

export const profile: ProfileResponse = {
  rows: [
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb04",
      version: 1,
      type: "context",
      content: "Работаю из дома, самые продуктивные часы — утро",
      sensitive: false,
      source: "onboarding",
      updatedAt: "2026-04-11T08:20:00.000Z",
      createdAt: "2026-04-11T08:20:00.000Z",
    },
  ],
  invitedAt: "2026-04-11T08:15:00.000Z",
};

export const timezoneSearch: TimezoneSearchResponse = {
  suggestions: [
    { id: "Europe/Kyiv", offsetMinutes: 180, localTime: "10:00" },
    { id: "Europe/Berlin", offsetMinutes: 120, localTime: "09:00" },
    { id: "Europe/Lisbon", offsetMinutes: 60, localTime: "08:00" },
  ],
};

export const undoGroupId = ids.undoGroup;
export const taskIds = ids;
