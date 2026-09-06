import type { ResolvedActionOf } from "../../core/ai-contract.js";
import { DEFAULT_DIGEST_TIMES, DEFAULT_WEEKLY_REVIEW } from "../../core/settings-change.js";
import { resolveTimezoneInput } from "../../core/timezone-lookup.js";
import type { SettingsChange } from "../contracts/index.js";
import { ApiError } from "../http/api-error.js";
import type { WebSettingsRow } from "../auth/index.js";

/**
 * One `SettingsChange` from the contract, turned into the write the bot already performs.
 *
 * A settings change asked for in chat becomes a `ResolvedActionOf<"settings">` the agent hands to
 * `ActionsService`, so the change is validated by the same rules, written by the
 * same patch builder and journaled with Undo. This function builds the identical action, which is
 * the whole reason `PATCH /settings` takes a discriminated union rather than loose fields: a third
 * writer with its own idea of what a valid quiet-hours window is, is exactly what
 * `buildSettingsPatch` was extracted to prevent.
 *
 * Two shapes in the contract have no counterpart in `SettingsActionSchema` and are mapped onto one
 * that does, with the defaults the preset itself uses:
 *
 * - `digest_preset` is `digest` at `DEFAULT_DIGEST_TIMES.morning`;
 * - `weekly_preset` is `weekly_review` at `DEFAULT_WEEKLY_REVIEW`.
 *
 * `buildSettingsPatch` produces the same columns for each pair, so this is a rename, not a second
 * rule — and it means the presets journal, which `SettingsService.setDigestPreset` does not.
 *
 * `snooze until morning` is the exception that cannot be an action: `/snooze morning` resolves the
 * instant through `SettingsService.snoozeUntilMorning`, which writes without a journal. Re-deriving
 * the instant here to journal it would be a second definition of «утром».
 */
export type SettingsWritePlan =
  | {
      kind: "action";
      action: ResolvedActionOf<"settings">;
      /**
       * The second half of the `tzapply:` question. `both` is carried by the action itself
       * (`applyTimezoneTo: "all"`), because one journaled step can move all three columns; a single
       * target is the unjournaled copy `tzapply:digests` and `tzapply:quiet` perform today.
       */
      copyTimezoneTo: "digests" | "quiet" | null;
    }
  | { kind: "snooze_until_morning" };

export function planSettingsChange(change: SettingsChange, current: WebSettingsRow): SettingsWritePlan {
  const base = {
    type: "settings" as const,
    intent: "explicit" as const,
    // Doing double duty exactly as it does in the bot: the schedule context for every other
    // operation, the requested zone for `timezone`.
    timezone: current.timezone,
    reviewTime: current.morningReferenceTime,
    expectedVersion: current.version,
    applyTimezoneTo: null,
    language: null,
    digestKind: null,
    enabled: null,
    time: null,
    weekday: null,
    weekdayStart: null,
    weekdayEnd: null,
    weekendStart: null,
    weekendEnd: null,
    snoozeUntilDate: null,
    snoozeUntilTime: null,
    eventOffsets: null,
    plannedTaskOffsetMinutes: null,
    criticalPostDueMinutes: null,
  } satisfies Omit<ResolvedActionOf<"settings">, "operation">;

  const action = (fields: Partial<ResolvedActionOf<"settings">> & Pick<ResolvedActionOf<"settings">, "operation">): SettingsWritePlan => ({
    kind: "action",
    action: { ...base, ...fields },
    copyTimezoneTo: null,
  });

  switch (change.operation) {
    case "timezone": {
      // The picker sends what the user chose, which may be a city name — the same input `/timezone`
      // accepts. An unresolvable value is a refusal with the domain's own token, not a 400 that
      // says «string», because «Пермь» is a legal string and a wrong answer.
      const zone = resolveTimezoneInput(change.timezone);
      if (!zone) throw ApiError.domainRule("timezone");
      return {
        kind: "action",
        action: { ...base, operation: "timezone", timezone: zone, applyTimezoneTo: change.applyTo === "both" ? "all" : "profile_only" },
        copyTimezoneTo: change.applyTo === "digests" || change.applyTo === "quiet" ? change.applyTo : null,
      };
    }
    case "language":
      return action({ operation: "language", language: change.language });
    case "digest":
      return action({ operation: "digest", digestKind: "morning", enabled: change.enabled, time: change.time });
    case "digest_preset":
      return action({ operation: "digest", digestKind: "morning", enabled: change.enabled, time: DEFAULT_DIGEST_TIMES.morning });
    case "weekly_review":
      return action({ operation: "weekly_review", enabled: change.enabled, weekday: change.weekday, time: change.time });
    case "weekly_preset":
      return action({ operation: "weekly_review", enabled: change.enabled, weekday: DEFAULT_WEEKLY_REVIEW.weekday, time: DEFAULT_WEEKLY_REVIEW.time });
    case "quiet_hours":
      return action({
        operation: "quiet_hours",
        enabled: change.enabled,
        weekdayStart: change.weekdayStart,
        weekdayEnd: change.weekdayEnd,
        // Either window may be absent and either may cross midnight; `buildSettingsPatch` lets the
        // weekend follow the weekday range, and `isQuietAt` handles the wrap. Neither is re-derived.
        weekendStart: change.weekendStart,
        weekendEnd: change.weekendEnd,
      });
    case "snooze":
      if (change.until === null) return action({ operation: "snooze", snoozeUntilDate: null, snoozeUntilTime: null });
      if (change.until.kind === "morning") return { kind: "snooze_until_morning" };
      return action({ operation: "snooze", snoozeUntilDate: change.until.date, snoozeUntilTime: change.until.time });
    case "reminder_defaults":
      return action({
        operation: "reminder_defaults",
        eventOffsets: change.eventOffsets,
        plannedTaskOffsetMinutes: change.plannedTaskOffsetMinutes,
        criticalPostDueMinutes: change.criticalPostDueMinutes,
      });
  }
}
