import { randomUUID } from "node:crypto";
import { defaultReminderTemplates } from "../core/reminder-defaults.js";
import { defaultRuleSpecs, type ReminderRuleSpec } from "../core/reminder-planning.js";
import type { TaskDefinition } from "../core/types.js";
import type { reminderRules, userSettings } from "../database/schema.js";
import { reminderSettingsFromRow } from "./task-record-mappers.js";

/** A user-requested reminder replaces the default user reminder and keeps follow-up/review rules. */
export function withExplicitReminder(defaults: ReminderRuleSpec[], explicit?: ReminderRuleSpec): ReminderRuleSpec[] {
  if (!explicit) return defaults;
  return [...defaults.filter((rule) => rule.purpose !== "user_reminder"), explicit];
}

/** The reminder rules a task gets at creation, derived from its definition and the recipient's settings. */
export function defaultReminderRuleSpecs(definition: TaskDefinition, settingsRow: typeof userSettings.$inferSelect, explicitReminder?: ReminderRuleSpec): ReminderRuleSpec[] {
  const eventOffsetsMinutes = Array.isArray(settingsRow.eventReminderOffsetsMinutes)
    ? settingsRow.eventReminderOffsetsMinutes.filter((value): value is number => Number.isInteger(value))
    : undefined;
  const templates = defaultReminderTemplates(
    {
      kind: definition.kind,
      timeMode: definition.timeMode,
      importance: definition.importance,
      hasPlannedStart: Boolean(definition.plannedStartAt),
    },
    {
      ...(eventOffsetsMinutes ? { eventOffsetsMinutes } : {}),
      plannedTaskOffsetMinutes: settingsRow.plannedTaskReminderOffsetMinutes,
      criticalPostDueMinutes: settingsRow.criticalPostDueMinutes,
    },
  );
  return withExplicitReminder(defaultRuleSpecs(definition, templates, reminderSettingsFromRow(settingsRow)), explicitReminder);
}

/** Task-level reminder rule rows for the given specs; `ruleIds[i]` names the row for `specs[i]`. */
export function reminderRuleRows(input: {
  workspaceId: string;
  taskId: string;
  specs: readonly ReminderRuleSpec[];
  ruleIds: readonly string[];
}): Array<typeof reminderRules.$inferInsert> {
  return input.specs.map((rule, index) => {
    const id = input.ruleIds[index];
    if (!id) throw new Error("reminder rule id is missing");
    return {
      id,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      triggerKind: rule.triggerKind,
      ...(rule.exactAt ? { exactAt: rule.exactAt } : {}),
      ...(rule.anchor ? { anchor: rule.anchor } : {}),
      ...(rule.offsetSeconds !== undefined ? { offsetSeconds: rule.offsetSeconds } : {}),
      ...(rule.daysOffset !== undefined ? { daysOffset: rule.daysOffset } : {}),
      ...(rule.localTime ? { localTime: rule.localTime } : {}),
      purpose: rule.purpose,
      quietPolicy: rule.quietPolicy,
      origin: rule.origin ?? "default",
      active: true,
    };
  });
}

/**
 * Default reminder rule rows for a task with the given definition, as `TasksService.buildTaskPlan`
 * inserts them at creation. Reused when a fuzzy task is given a concrete time later.
 */
export function defaultReminderRuleRows(input: {
  workspaceId: string;
  taskId: string;
  definition: TaskDefinition;
  settingsRow: typeof userSettings.$inferSelect;
  explicitReminder?: ReminderRuleSpec;
}): Array<typeof reminderRules.$inferInsert> {
  const specs = defaultReminderRuleSpecs(input.definition, input.settingsRow, input.explicitReminder);
  return reminderRuleRows({ workspaceId: input.workspaceId, taskId: input.taskId, specs, ruleIds: specs.map(() => randomUUID()) });
}
