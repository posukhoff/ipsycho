import type { z } from "zod";
import { AccountDeleteRequestSchema, AccountDeleteResponseSchema, ClearHistoryResponseSchema, ConsentRequestSchema, ConsentResponseSchema } from "./settings.js";
import { SettingsMutationResponseSchema, SettingsPatchRequestSchema, SettingsResponseSchema, TimezoneSearchQuerySchema, TimezoneSearchResponseSchema } from "./settings.js";
import { MemoryDeleteRequestSchema, MemoryMutationResponseSchema, MemoryPatchRequestSchema, MemoryQuerySchema, MemoryResponseSchema, ProfileResponseSchema } from "./memory.js";
import { MeResponseSchema } from "./me.js";
import {
  ChecklistWriteRequestSchema,
  CreateTaskRequestSchema,
  OccurrenceStateRequestSchema,
  PausedSeriesResponseSchema,
  RescheduleOptionsSchema,
  RescheduleRequestSchema,
  SeriesRequestSchema,
  TaskDetailSchema,
  TaskListQuerySchema,
  TaskListResponseSchema,
  TaskMutationResponseSchema,
  TodayResponseSchema,
  UndoRequestSchema,
  UndoResponseSchema,
  UpdateTaskRequestSchema,
} from "./tasks.js";
import {
  CreateGoalRequestSchema,
  GoalDetailSchema,
  GoalLinkRequestSchema,
  GoalMutationResponseSchema,
  GoalsQuerySchema,
  GoalsResponseSchema,
  UpdateGoalRequestSchema,
} from "./goals.js";
import { WeekPickResponseSchema, WeekQuerySchema, WeekResponseSchema, WeekTakeTodayRequestSchema, WeekTakeTodayResponseSchema } from "./week.js";
import {
  ReminderCancelResponseSchema,
  ReminderMutationResponseSchema,
  ReminderRepeatRequestSchema,
  ReminderSnoozeRequestSchema,
  RemindersQuerySchema,
  RemindersResponseSchema,
} from "./reminders.js";
import { PageQuerySchema } from "./primitives.js";

/**
 * The route table.
 *
 * Every endpoint the Mini App will ever call is listed here once, with the schema of what goes in
 * and what comes back. Three things read it and so cannot drift apart: the controllers (group 1–4),
 * the typed client in `web/src/api/client.ts`, and the mock server in `web/src/mocks/`.
 *
 * `group` records which parallel agent owns the implementation, so an endpoint whose controller is
 * still a stub is visibly reserved rather than missing.
 *
 * The prefix is a constant rather than `app.setGlobalPrefix`, because a global prefix would also
 * move `/health` and `/ready` — which Docker's healthcheck and group 9's Caddyfile both name.
 */
export const API_PREFIX = "/api/v1";

/** A path template; `:id` segments are filled by the client's `buildPath`. */
export type EndpointDefinition = {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly group: 1 | 2 | 3 | 4;
  readonly query?: z.ZodTypeAny;
  readonly body?: z.ZodTypeAny;
  readonly response: z.ZodTypeAny;
};

export const ENDPOINTS = {
  /* group 1 — initData auth */
  me: { method: "GET", path: "/me", group: 1, response: MeResponseSchema },

  /* group 2 — tasks and goals */
  taskList: { method: "GET", path: "/tasks", group: 2, query: TaskListQuerySchema, response: TaskListResponseSchema },
  today: { method: "GET", path: "/tasks/today", group: 2, query: PageQuerySchema, response: TodayResponseSchema },
  pausedSeries: { method: "GET", path: "/tasks/paused", group: 2, query: PageQuerySchema, response: PausedSeriesResponseSchema },
  task: { method: "GET", path: "/tasks/:id", group: 2, response: TaskDetailSchema },
  createTask: { method: "POST", path: "/tasks", group: 2, body: CreateTaskRequestSchema, response: TaskMutationResponseSchema },
  updateTask: { method: "PATCH", path: "/tasks/:id", group: 2, body: UpdateTaskRequestSchema, response: TaskMutationResponseSchema },
  setTaskState: { method: "POST", path: "/tasks/:id/state", group: 2, body: OccurrenceStateRequestSchema, response: TaskMutationResponseSchema },
  rescheduleOptions: { method: "GET", path: "/tasks/:id/reschedule", group: 2, response: RescheduleOptionsSchema },
  reschedule: { method: "POST", path: "/tasks/:id/reschedule", group: 2, body: RescheduleRequestSchema, response: TaskMutationResponseSchema },
  checklist: { method: "POST", path: "/tasks/:id/checklist", group: 2, body: ChecklistWriteRequestSchema, response: TaskMutationResponseSchema },
  pauseSeries: { method: "POST", path: "/tasks/:id/series/pause", group: 2, body: SeriesRequestSchema, response: TaskMutationResponseSchema },
  resumeSeries: { method: "POST", path: "/tasks/:id/series/resume", group: 2, body: SeriesRequestSchema, response: TaskMutationResponseSchema },
  undo: { method: "POST", path: "/undo", group: 2, body: UndoRequestSchema, response: UndoResponseSchema },
  goals: { method: "GET", path: "/goals", group: 2, query: GoalsQuerySchema, response: GoalsResponseSchema },
  goal: { method: "GET", path: "/goals/:id", group: 2, response: GoalDetailSchema },
  createGoal: { method: "POST", path: "/goals", group: 2, body: CreateGoalRequestSchema, response: GoalMutationResponseSchema },
  updateGoal: { method: "PATCH", path: "/goals/:id", group: 2, body: UpdateGoalRequestSchema, response: GoalMutationResponseSchema },
  linkGoal: { method: "POST", path: "/goals/:id/tasks", group: 2, body: GoalLinkRequestSchema, response: GoalMutationResponseSchema },
  unlinkGoal: { method: "DELETE", path: "/goals/:id/tasks/:taskId", group: 2, response: GoalMutationResponseSchema },

  /* group 3 — reminders, settings, memory */
  reminders: { method: "GET", path: "/reminders", group: 3, query: RemindersQuerySchema, response: RemindersResponseSchema },
  snoozeReminder: { method: "POST", path: "/reminders/:deliveryId/snooze", group: 3, body: ReminderSnoozeRequestSchema, response: ReminderMutationResponseSchema },
  repeatReminder: { method: "POST", path: "/reminders/:deliveryId/repeat", group: 3, body: ReminderRepeatRequestSchema, response: ReminderMutationResponseSchema },
  cancelReminder: { method: "DELETE", path: "/reminders/:deliveryId", group: 3, response: ReminderCancelResponseSchema },
  settings: { method: "GET", path: "/settings", group: 3, response: SettingsResponseSchema },
  patchSettings: { method: "PATCH", path: "/settings", group: 3, body: SettingsPatchRequestSchema, response: SettingsMutationResponseSchema },
  timezoneSearch: { method: "GET", path: "/settings/timezones", group: 3, query: TimezoneSearchQuerySchema, response: TimezoneSearchResponseSchema },
  memory: { method: "GET", path: "/memory", group: 3, query: MemoryQuerySchema, response: MemoryResponseSchema },
  patchMemory: { method: "PATCH", path: "/memory/:id", group: 3, body: MemoryPatchRequestSchema, response: MemoryMutationResponseSchema },
  deleteMemory: { method: "DELETE", path: "/memory/:id", group: 3, body: MemoryDeleteRequestSchema, response: MemoryMutationResponseSchema },
  profile: { method: "GET", path: "/profile", group: 3, response: ProfileResponseSchema },
  clearHistory: { method: "POST", path: "/chat/history/clear", group: 3, response: ClearHistoryResponseSchema },
  consents: { method: "GET", path: "/consent", group: 3, response: ConsentResponseSchema },
  grantConsent: { method: "POST", path: "/consent/grant", group: 3, body: ConsentRequestSchema, response: ConsentResponseSchema },
  revokeConsent: { method: "POST", path: "/consent/revoke", group: 3, body: ConsentRequestSchema, response: ConsentResponseSchema },
  deleteAccount: { method: "POST", path: "/account/delete", group: 3, body: AccountDeleteRequestSchema, response: AccountDeleteResponseSchema },

  /* group 4 — week plan */
  week: { method: "GET", path: "/week", group: 4, query: WeekQuerySchema, response: WeekResponseSchema },
  pickWeek: { method: "POST", path: "/week/pick/:taskId", group: 4, response: WeekPickResponseSchema },
  releaseWeek: { method: "DELETE", path: "/week/pick/:taskId", group: 4, response: WeekPickResponseSchema },
  takeToday: { method: "POST", path: "/week/take-today/:taskId", group: 4, body: WeekTakeTodayRequestSchema, response: WeekTakeTodayResponseSchema },
} as const satisfies Record<string, EndpointDefinition>;

export type EndpointName = keyof typeof ENDPOINTS;
export type EndpointResponse<Name extends EndpointName> = z.infer<(typeof ENDPOINTS)[Name]["response"]>;
export type EndpointBody<Name extends EndpointName> = (typeof ENDPOINTS)[Name] extends { body: infer Schema extends z.ZodTypeAny } ? z.infer<Schema> : undefined;
export type EndpointQuery<Name extends EndpointName> = (typeof ENDPOINTS)[Name] extends { query: infer Schema extends z.ZodTypeAny } ? z.input<Schema> : undefined;
