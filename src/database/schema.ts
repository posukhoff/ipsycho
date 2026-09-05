/**
 * Runtime Drizzle mapping for application queries. Raw SQL migrations are the
 * authoritative database contract. A small number of constraints that would
 * introduce declaration-order/circular-reference problems here (notably the
 * workspace-scoped source_action_group foreign keys on tasks/goals) live only
 * in migrations; keep schema.ts and migrations reviewed together.
 */
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userStatus = pgEnum("user_status", ["active", "disabled", "deletion_pending"]);
export const aiStatus = pgEnum("ai_status", ["enabled", "suspended"]);
export const taskKind = pgEnum("task_kind", ["task", "event"]);
export const importance = pgEnum("importance", ["normal", "required", "critical"]);
export const taskStatus = pgEnum("task_status", ["active", "paused", "closed", "cancelled"]);
export const timeMode = pgEnum("time_mode", ["point", "window", "deadline", "fuzzy"]);
export const occurrenceStatus = pgEnum("occurrence_status", ["scheduled", "open", "in_progress", "done", "skipped", "cancelled", "elapsed"]);
export const missPolicy = pgEnum("miss_policy", ["expire", "carry_over"]);
export const reminderTrigger = pgEnum("reminder_trigger", ["exact", "relative_timestamp", "local_date"]);
export const reminderPurpose = pgEnum("reminder_purpose", ["user_reminder", "follow_up", "planning_review"]);
export const quietPolicy = pgEnum("quiet_policy", ["respect", "bypass"]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "processing", "sent", "cancelled", "failed", "suppressed", "ambiguous"]);
export const suppressedReason = pgEnum("suppressed_reason", ["superseded", "user_cancelled", "access", "quiet_stale", "snooze_stale", "no_longer_applicable", "empty", "orphaned"]);
export const messageRole = pgEnum("message_role", ["user", "assistant"]);
export const actionGroupStatus = pgEnum("action_group_status", ["pending", "applying", "undoing", "applied", "undone", "cancelled", "expired", "failed"]);
export const topicStatus = pgEnum("topic_status", ["active", "paused", "resolved", "abandoned"]);
export const topicMode = pgEnum("topic_mode", ["normal", "analysis"]);
export const memoryItemType = pgEnum("memory_item_type", ["note", "decision", "preference", "context"]);
export const goalStatus = pgEnum("goal_status", ["active", "paused", "completed", "cancelled"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    status: userStatus("status").notNull().default("active"),
    aiStatus: aiStatus("ai_status").notNull().default("enabled"),
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("users_telegram_user_id_key").on(t.telegramUserId)],
);

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  timezone: varchar("timezone", { length: 128 }).notNull().default("Europe/Kyiv"),
  digestTimezone: varchar("digest_timezone", { length: 128 }).notNull().default("Europe/Kyiv"),
  quietHoursTimezone: varchar("quiet_hours_timezone", { length: 128 }).notNull().default("Europe/Kyiv"),
  pinnedLanguage: varchar("pinned_language", { length: 16 }),
  /** Last interface language Telegram reported; the fallback for pushes sent outside an update. */
  telegramLanguage: varchar("telegram_language", { length: 16 }),
  quietHoursEnabled: boolean("quiet_hours_enabled").notNull().default(true),
  weekdayQuietStart: varchar("weekday_quiet_start", { length: 5 }).notNull().default("22:00"),
  weekdayQuietEnd: varchar("weekday_quiet_end", { length: 5 }).notNull().default("08:00"),
  weekendQuietStart: varchar("weekend_quiet_start", { length: 5 }).notNull().default("23:00"),
  weekendQuietEnd: varchar("weekend_quiet_end", { length: 5 }).notNull().default("09:00"),
  notificationsSnoozedUntil: timestamp("notifications_snoozed_until", { withTimezone: true }),
  morningReferenceTime: varchar("morning_reference_time", { length: 5 }).notNull().default("09:00"),
  eveningReferenceTime: varchar("evening_reference_time", { length: 5 }).notNull().default("20:00"),
  morningDigestEnabled: boolean("morning_digest_enabled").notNull().default(false),
  eveningDigestEnabled: boolean("evening_digest_enabled").notNull().default(false),
  weeklyReviewEnabled: boolean("weekly_review_enabled").notNull().default(false),
  weeklyReviewWeekday: integer("weekly_review_weekday").notNull().default(7),
  weeklyReviewTime: varchar("weekly_review_time", { length: 5 }).notNull().default("20:00"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  /** Last optional invitation to build the durable personal profile. */
  profileInvitedAt: timestamp("profile_invited_at", { withTimezone: true }),
  aiMonthlyWarningUsd: numeric("ai_monthly_warning_usd", { precision: 10, scale: 2 }).notNull().default("5.00"),
  lastAiSpendWarningMonth: varchar("last_ai_spend_warning_month", { length: 7 }),
  eventReminderOffsetsMinutes: jsonb("event_reminder_offsets_minutes").notNull().default([-60, -15]),
  plannedTaskReminderOffsetMinutes: integer("planned_task_reminder_offset_minutes").notNull().default(0),
  criticalPostDueMinutes: integer("critical_post_due_minutes").notNull().default(60),
  seenNormalMinutes: integer("seen_normal_minutes").notNull().default(60),
  seenRequiredMinutes: integer("seen_required_minutes").notNull().default(30),
  seenCriticalMinutes: integer("seen_critical_minutes").notNull().default(15),
  pendingInput: jsonb("pending_input"),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull().default("personal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspaces_owner_kind_idx").on(t.ownerUserId, t.kind)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull().default("owner"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

/** One-time deep links that let a new Telegram account create its own workspace. */
export const registrationInvites = pgTable(
  "registration_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: varchar("token", { length: 64 }).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByUserId: uuid("used_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("registration_invites_token_key").on(t.token), index("registration_invites_open_idx").on(t.expiresAt)],
);

export const conversationTopics = pgTable(
  "conversation_topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    summary: text("summary").notNull(),
    status: topicStatus("status").notNull().default("active"),
    mode: topicMode("mode").notNull().default("normal"),
    clarificationCount: integer("clarification_count").notNull().default(0),
    reviewKind: varchar("review_kind", { length: 16 }),
    reviewState: jsonb("review_state").$type<unknown>(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    summaryExpiresAt: timestamp("summary_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("conversation_topics_workspace_id_id_uq").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "conversation_topics_user_membership_fk" }),
    index("conversation_topics_workspace_user_status_idx").on(t.workspaceId, t.userId, t.status, t.lastMessageAt),
    index("conversation_topics_expiry_idx").on(t.summaryExpiresAt),
  ],
);

export const memoryItems = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    type: memoryItemType("type").notNull(),
    content: text("content").notNull(),
    sensitive: boolean("sensitive").notNull().default(false),
    source: varchar("source", { length: 32 }).notNull(),
    sourceMessageId: uuid("source_message_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memory_items_workspace_id_id_uq").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "memory_items_user_membership_fk" }),
    index("memory_items_workspace_user_updated_idx").on(t.workspaceId, t.userId, t.updatedAt),
    index("memory_items_content_fts_idx").using("gin", sql`to_tsvector('simple', ${t.content})`),
  ],
);

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").notNull(),
    sourceActionGroupId: uuid("source_action_group_id"),
    title: varchar("title", { length: 500 }).notNull(),
    why: text("why"),
    status: goalStatus("status").notNull().default("active"),
    targetLocalDate: date("target_local_date"),
    reviewEnabled: boolean("review_enabled").notNull().default(true),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("goals_workspace_id_id_uq").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.createdByUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "goals_creator_membership_fk" }),
    index("goals_workspace_status_idx").on(t.workspaceId, t.status, t.updatedAt),
    index("goals_source_action_group_idx").on(t.workspaceId, t.sourceActionGroupId),
    foreignKey({ columns: [t.workspaceId, t.sourceActionGroupId], foreignColumns: [actionGroups.workspaceId, actionGroups.id], name: "goals_source_action_group_fk" }),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").notNull(),
    sourceActionGroupId: uuid("source_action_group_id"),
    title: text("title").notNull(),
    why: text("why"),
    nextAction: text("next_action"),
    context: text("context"),
    kind: taskKind("kind").notNull().default("task"),
    importance: importance("importance").notNull().default("normal"),
    status: taskStatus("status").notNull().default("active"),
    timeMode: timeMode("time_mode").notNull(),
    timezone: varchar("timezone", { length: 128 }).notNull(),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }),
    plannedLocalDate: date("planned_local_date"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    dueLocalDate: date("due_local_date"),
    fuzzyHorizonText: text("fuzzy_horizon_text"),
    reviewAt: timestamp("review_at", { withTimezone: true }),
    /** Monday of the week this task was taken for, as a local date. Null means it sits in the pool. */
    pickedWeekStart: date("picked_week_start"),
    recurrenceRule: text("recurrence_rule"),
    recurrenceTimezone: varchar("recurrence_timezone", { length: 128 }),
    recurrenceEndLocalDate: date("recurrence_end_local_date"),
    missPolicy: missPolicy("miss_policy"),
    habitMode: boolean("habit_mode").notNull().default(false),
    minimumAction: text("minimum_action"),
    desiredAction: text("desired_action"),
    habitTrigger: text("habit_trigger"),
    habitOfferSentAt: timestamp("habit_offer_sent_at", { withTimezone: true }),
    seriesRevision: integer("series_revision").notNull().default(1),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tasks_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.createdByUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "tasks_creator_membership_fk" }),
    index("tasks_workspace_status_idx").on(t.workspaceId, t.status),
    index("tasks_source_action_group_idx").on(t.workspaceId, t.sourceActionGroupId),
    foreignKey({ columns: [t.workspaceId, t.sourceActionGroupId], foreignColumns: [actionGroups.workspaceId, actionGroups.id], name: "tasks_source_action_group_fk" }),
    index("tasks_fts_idx").using("gin", sql`to_tsvector('simple', ${t.title} || ' ' || coalesce(${t.context}, ''))`),
    index("tasks_recurring_active_idx")
      .on(t.status)
      .where(sql`${t.recurrenceRule} IS NOT NULL`),
    index("tasks_week_pick_idx")
      .on(t.workspaceId, t.pickedWeekStart)
      .where(sql`${t.pickedWeekStart} IS NOT NULL`),
  ],
);

export const taskRecurrenceExclusions = pgTable(
  "task_recurrence_exclusions",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    localDate: date("local_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.taskId, t.localDate] }),
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id], name: "task_recurrence_exclusions_task_workspace_fk" }).onDelete("cascade"),
  ],
);

export const taskGoals = pgTable(
  "task_goals",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    goalId: uuid("goal_id").notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    confidence: integer("confidence").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.taskId, t.goalId] }),
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id], name: "task_goals_task_workspace_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.workspaceId, t.goalId], foreignColumns: [goals.workspaceId, goals.id], name: "task_goals_goal_workspace_fk" }).onDelete("cascade"),
  ],
);

export const taskChecklistItems = pgTable(
  "task_checklist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    text: text("text").notNull(),
    sortOrder: integer("sort_order").notNull(),
    done: boolean("done").notNull().default(false),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id], name: "checklist_task_workspace_fk" }).onDelete("cascade"),
    index("checklist_task_idx").on(t.workspaceId, t.taskId),
  ],
);

export const taskOccurrences = pgTable(
  "task_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    recurrenceKey: varchar("recurrence_key", { length: 255 }),
    seriesRevision: integer("series_revision").notNull().default(1),
    status: occurrenceStatus("status").notNull(),
    timezone: varchar("timezone", { length: 128 }).notNull(),
    plannedStartAt: timestamp("planned_start_at", { withTimezone: true }),
    plannedEndAt: timestamp("planned_end_at", { withTimezone: true }),
    plannedLocalDate: date("planned_local_date"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    dueLocalDate: date("due_local_date"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    overdue: boolean("overdue").notNull().default(false),
    elapsedAt: timestamp("elapsed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedLate: boolean("completed_late").notNull().default(false),
    skipReason: varchar("skip_reason", { length: 64 }),
    dstAdjusted: boolean("dst_adjusted").notNull().default(false),
    needsReminderRebuild: boolean("needs_reminder_rebuild").notNull().default(false),
    defaultRemindersSuppressed: boolean("default_reminders_suppressed").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("task_occurrences_workspace_id_id_key").on(t.workspaceId, t.id),
    uniqueIndex("occurrence_series_recurrence_key_uq").on(t.taskId, t.seriesRevision, t.recurrenceKey),
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id], name: "occurrence_task_workspace_fk" }).onDelete("cascade"),
    index("occurrence_task_status_time_idx").on(t.workspaceId, t.taskId, t.status, t.plannedStartAt),
    index("occurrences_live_idx")
      .on(t.status)
      .where(sql`${t.status} IN ('scheduled', 'open', 'in_progress')`),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    occurrenceId: uuid("occurrence_id"),
    actorUserId: uuid("actor_user_id"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id], name: "task_events_task_workspace_fk" }).onDelete("cascade"),
    foreignKey({ columns: [t.workspaceId, t.occurrenceId], foreignColumns: [taskOccurrences.workspaceId, taskOccurrences.id], name: "task_events_occurrence_workspace_fk" }),
    foreignKey({ columns: [t.workspaceId, t.actorUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "task_events_actor_membership_fk" }),
    index("task_events_ws_occurrence_type_idx").on(t.workspaceId, t.occurrenceId, t.eventType, t.createdAt),
    index("task_events_ws_task_created_idx").on(t.workspaceId, t.taskId, t.createdAt),
    index("task_events_result_check_idx")
      .on(t.eventType, t.createdAt)
      .where(sql`${t.occurrenceId} IS NOT NULL`),
    index("task_events_details_purge_idx")
      .on(t.createdAt)
      .where(sql`${t.details} IS NOT NULL`),
  ],
);

export const reminderRules = pgTable(
  "reminder_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    occurrenceId: uuid("occurrence_id"),
    triggerKind: reminderTrigger("trigger_kind").notNull(),
    exactAt: timestamp("exact_at", { withTimezone: true }),
    anchor: varchar("anchor", { length: 32 }),
    offsetSeconds: integer("offset_seconds"),
    daysOffset: integer("days_offset"),
    localTime: varchar("local_time", { length: 5 }),
    purpose: reminderPurpose("purpose").notNull().default("user_reminder"),
    quietPolicy: quietPolicy("quiet_policy").notNull().default("respect"),
    origin: varchar("origin", { length: 16 }).notNull().default("default"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("reminder_rules_workspace_id_id_key").on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id], name: "reminder_rules_task_workspace_fk" }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.occurrenceId],
      foreignColumns: [taskOccurrences.workspaceId, taskOccurrences.id],
      name: "reminder_rules_occurrence_workspace_fk",
    }).onDelete("cascade"),
    index("reminder_rules_ws_task_idx")
      .on(t.workspaceId, t.taskId)
      .where(sql`${t.active}`),
    index("reminder_rules_ws_occurrence_idx")
      .on(t.workspaceId, t.occurrenceId)
      .where(sql`${t.active}`),
  ],
);

export const reminderDeliveries = pgTable(
  "reminder_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recipientUserId: uuid("recipient_user_id").notNull(),
    reminderRuleId: uuid("reminder_rule_id").notNull(),
    taskId: uuid("task_id").notNull(),
    occurrenceId: uuid("occurrence_id"),
    intendedFor: timestamp("intended_for", { withTimezone: true }).notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    suppressedReason: suppressedReason("suppressed_reason"),
    deduplicationKey: varchar("deduplication_key", { length: 255 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("reminder_deliveries_deduplication_key_key").on(t.deduplicationKey),
    foreignKey({
      columns: [t.workspaceId, t.recipientUserId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "reminder_delivery_recipient_membership_fk",
    }),
    foreignKey({ columns: [t.workspaceId, t.taskId], foreignColumns: [tasks.workspaceId, tasks.id], name: "reminder_delivery_task_workspace_fk" }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.occurrenceId],
      foreignColumns: [taskOccurrences.workspaceId, taskOccurrences.id],
      name: "reminder_delivery_occurrence_workspace_fk",
    }).onDelete("cascade"),
    foreignKey({ columns: [t.workspaceId, t.reminderRuleId], foreignColumns: [reminderRules.workspaceId, reminderRules.id], name: "reminder_delivery_rule_workspace_fk" }).onDelete(
      "cascade",
    ),
    index("reminder_delivery_due_idx").on(t.status, t.scheduledFor),
    index("reminder_deliveries_ws_occurrence_idx")
      .on(t.workspaceId, t.occurrenceId)
      .where(sql`${t.status} IN ('pending', 'processing')`),
    index("reminder_deliveries_ws_rule_idx")
      .on(t.workspaceId, t.reminderRuleId)
      .where(sql`${t.status} IN ('pending', 'processing')`),
    index("reminder_deliveries_recipient_sched_idx").on(t.recipientUserId, t.status, t.scheduledFor),
    index("reminder_deliveries_ws_task_idx").on(t.workspaceId, t.taskId),
  ],
);

export const briefingDeliveries = pgTable(
  "briefing_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recipientUserId: uuid("recipient_user_id").notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    localDate: date("local_date").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    suppressedReason: suppressedReason("suppressed_reason"),
    deduplicationKey: varchar("deduplication_key", { length: 255 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("briefing_deliveries_deduplication_key_key").on(t.deduplicationKey),
    foreignKey({
      columns: [t.workspaceId, t.recipientUserId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
      name: "briefing_delivery_recipient_membership_fk",
    }),
    index("briefing_delivery_due_idx").on(t.status, t.scheduledFor),
    index("briefing_delivery_user_date_idx").on(t.recipientUserId, t.localDate, t.kind),
  ],
);

export const telegramUpdates = pgTable(
  "telegram_updates",
  {
    botIdentity: varchar("bot_identity", { length: 64 }).notNull(),
    telegramUpdateId: bigint("telegram_update_id", { mode: "number" }).notNull(),
    chatId: bigint("chat_id", { mode: "number" }),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    status: varchar("status", { length: 32 }).notNull().default("received"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.botIdentity, t.telegramUpdateId] }),
    index("telegram_updates_created_at_idx").on(t.createdAt),
    uniqueIndex("telegram_chat_message_uq")
      .on(t.botIdentity, t.chatId, t.telegramMessageId)
      .where(sql`telegram_message_id IS NOT NULL`),
  ],
);

export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: varchar("action", { length: 64 }).notNull(),
  targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    role: messageRole("role").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("processed"),
    topicId: uuid("topic_id"),
    content: text("content").notNull(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    aiRetryCount: integer("ai_retry_count").notNull().default(0),
    aiNextRetryAt: timestamp("ai_next_retry_at", { withTimezone: true }),
    aiLastErrorAt: timestamp("ai_last_error_at", { withTimezone: true }),
    /** The proposal card this assistant message carries; a bare "да" confirms it. */
    pendingGroupId: uuid("pending_group_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "messages_user_membership_fk" }),
    foreignKey({ columns: [t.workspaceId, t.topicId], foreignColumns: [conversationTopics.workspaceId, conversationTopics.id], name: "messages_topic_workspace_fk" }),
    foreignKey({ columns: [t.workspaceId, t.pendingGroupId], foreignColumns: [actionGroups.workspaceId, actionGroups.id], name: "messages_pending_group_workspace_fk" }).onDelete(
      "set null",
    ),
    uniqueIndex("messages_workspace_chat_message_uq").on(t.workspaceId, t.telegramChatId, t.telegramMessageId),
    index("messages_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("messages_waiting_retry_idx")
      .on(t.status, t.aiNextRetryAt, t.createdAt)
      .where(sql`status = 'waiting_ai'`),
    index("messages_workspace_user_role_created_idx").on(t.workspaceId, t.userId, t.role, t.createdAt),
    index("messages_user_role_created_idx").on(t.userId, t.role, t.createdAt.desc()),
    index("messages_ws_pending_group_idx")
      .on(t.workspaceId, t.pendingGroupId)
      .where(sql`${t.pendingGroupId} IS NOT NULL`),
  ],
);

export const aiProviderConsents = pgTable(
  "ai_provider_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull(),
    consentVersion: varchar("consent_version", { length: 32 }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [unique("ai_provider_consents_user_id_provider_consent_version_key").on(t.userId, t.provider, t.consentVersion)],
);

export const actionGroups = pgTable(
  "action_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").notNull(),
    sourceMessageId: uuid("source_message_id").references((): AnyPgColumn => messages.id, { onDelete: "set null" }),
    status: actionGroupStatus("status").notNull(),
    requiresConfirmation: boolean("requires_confirmation").notNull().default(false),
    undoExpiresAt: timestamp("undo_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (t) => [
    unique("action_groups_workspace_id_id_key").on(t.workspaceId, t.id),
    uniqueIndex("action_groups_active_source_message_uq")
      .on(t.sourceMessageId)
      .where(sql`${t.sourceMessageId} IS NOT NULL AND ${t.status} IN ('pending', 'applying', 'undoing', 'applied')`),
    foreignKey({ columns: [t.workspaceId, t.actorUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "action_groups_actor_membership_fk" }),
    index("action_groups_workspace_status_idx").on(t.workspaceId, t.status, t.createdAt),
  ],
);

export const pendingActions = pgTable(
  "pending_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    actionType: varchar("action_type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.groupId], foreignColumns: [actionGroups.workspaceId, actionGroups.id], name: "pending_actions_group_workspace_fk" }).onDelete(
      "cascade",
    ),
    foreignKey({ columns: [t.workspaceId, t.actorUserId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "pending_actions_actor_membership_fk" }),
    index("pending_actions_group_idx").on(t.workspaceId, t.groupId),
    index("pending_actions_expiry_idx").on(t.expiresAt),
  ],
);

export const actionEvents = pgTable(
  "action_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull(),
    actionType: varchar("action_type", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    postVersion: integer("post_version"),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.groupId], foreignColumns: [actionGroups.workspaceId, actionGroups.id], name: "action_events_group_workspace_fk" }).onDelete("cascade"),
    index("action_events_group_idx").on(t.workspaceId, t.groupId, t.createdAt),
  ],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    providerRequestId: varchar("provider_request_id", { length: 255 }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    attempts: integer("attempts").notNull().default(1),
    latencyMs: integer("latency_ms").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    pricingRevision: varchar("pricing_revision", { length: 64 }),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.workspaceId, t.userId], foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId], name: "ai_usage_user_membership_fk" }),
    index("ai_usage_user_created_idx").on(t.userId, t.createdAt),
  ],
);
