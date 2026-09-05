import { useState, type ReactNode } from "react";
import type { SettingsResponse } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { Button, ChipGroup, Field, NumberInput, Select, Sheet, Stack, TimeField, type Option } from "../../ui/index.js";
import type { SettingsPatchApi } from "./use-settings-patch.js";

/**
 * The three sheets behind the digest, the weekly card and the reminder defaults.
 *
 * Each writes exactly one `SettingsChange` operation, and none of them can turn a feature on or off
 * — the switches on the list do that, so a sheet that is opened and dismissed changes nothing.
 */

export function MorningDigestSheet({ settings, patch, onClose }: { settings: SettingsResponse; patch: SettingsPatchApi; onClose: () => void }): ReactNode {
  const t = useT();
  const [time, setTime] = useState(settings.morningDigest.time);

  return (
    <Sheet open onClose={onClose} title={t("settings.morning_digest")}>
      <Stack>
        <Field label={t("settings.digest_time")}>
          <TimeField value={time} allowEmpty={false} onChange={(value) => setTime(value ?? time)} />
        </Field>
        <p className="ip-muted ip-small">{t("settings.digest_timezone", { timezone: settings.digestTimezone })}</p>
        <Button
          block
          variant="primary"
          loading={patch.isPending}
          onClick={() => {
            void patch.save({ operation: "digest", kind: "morning", enabled: settings.morningDigest.enabled, time }).then((ok) => {
              if (ok) onClose();
            });
          }}
        >
          {t("common.save")}
        </Button>
      </Stack>
    </Sheet>
  );
}

export function WeeklyReviewSheet({ settings, patch, onClose }: { settings: SettingsResponse; patch: SettingsPatchApi; onClose: () => void }): ReactNode {
  const t = useT();
  const [weekday, setWeekday] = useState(String(settings.weeklyReview.weekday));
  const [time, setTime] = useState(settings.weeklyReview.time);

  const days: readonly Option<string>[] = ["1", "2", "3", "4", "5", "6", "7"].map((value) => ({ value, label: t(`weekday.${value}` as "weekday.1") }));

  return (
    <Sheet open onClose={onClose} title={t("settings.weekly_review")}>
      <Stack>
        <Field label={t("settings.weekly_weekday")}>
          <Select value={weekday} options={days} onChange={setWeekday} />
        </Field>
        <Field label={t("settings.weekly_time")}>
          <TimeField value={time} allowEmpty={false} onChange={(value) => setTime(value ?? time)} />
        </Field>
        <Button
          block
          variant="primary"
          loading={patch.isPending}
          onClick={() => {
            void patch.save({ operation: "weekly_review", enabled: settings.weeklyReview.enabled, weekday: Number(weekday), time }).then((ok) => {
              if (ok) onClose();
            });
          }}
        >
          {t("common.save")}
        </Button>
      </Stack>
    </Sheet>
  );
}

/**
 * Reminder defaults.
 *
 * Event offsets are minutes *before* the start, so they cross the wire negative, exactly as
 * `/reminder_defaults event -60,-15` sends them. The chips show how long before, which is how the
 * setting is thought about; the sign lives in the value. At least one offset is required by the
 * contract, so the save button refuses an empty selection rather than letting the server do it.
 */
const OFFSET_PRESETS = [-1440, -120, -60, -30, -15, -10, -5] as const;

export function ReminderDefaultsSheet({ settings, patch, onClose }: { settings: SettingsResponse; patch: SettingsPatchApi; onClose: () => void }): ReactNode {
  const t = useT();
  const [offsets, setOffsets] = useState<readonly string[]>(settings.reminderDefaults.eventOffsetsMinutes.map(String));
  const [taskOffset, setTaskOffset] = useState<number | null>(settings.reminderDefaults.plannedTaskOffsetMinutes);
  const [critical, setCritical] = useState<number | null>(settings.reminderDefaults.criticalPostDueMinutes);

  const choices = [...new Set([...OFFSET_PRESETS, ...settings.reminderDefaults.eventOffsetsMinutes])].sort((a, b) => a - b);
  const options: readonly Option<string>[] = choices.map((minutes) => ({ value: String(minutes), label: String(Math.abs(minutes)) }));
  const valid = offsets.length > 0 && offsets.length <= 12 && taskOffset !== null && critical !== null && critical >= 15;

  return (
    <Sheet open onClose={onClose} title={t("settings.reminder_defaults")}>
      <Stack>
        <Field label={t("settings.event_offsets")}>
          <ChipGroup values={offsets} options={options} onChange={setOffsets} />
        </Field>
        <Field label={t("settings.task_offset")}>
          <NumberInput value={taskOffset} onChange={setTaskOffset} />
        </Field>
        <Field label={t("settings.critical_interval")} hint={t("settings.escalation", settings.escalationMinutes)}>
          <NumberInput value={critical} min={15} onChange={setCritical} />
        </Field>
        <Button
          block
          variant="primary"
          disabled={!valid}
          loading={patch.isPending}
          onClick={() => {
            if (!valid) return;
            void patch
              .save({
                operation: "reminder_defaults",
                eventOffsets: offsets.map(Number).sort((a, b) => a - b),
                plannedTaskOffsetMinutes: taskOffset,
                criticalPostDueMinutes: critical,
              })
              .then((ok) => {
                if (ok) onClose();
              });
          }}
        >
          {t("common.save")}
        </Button>
      </Stack>
    </Sheet>
  );
}
