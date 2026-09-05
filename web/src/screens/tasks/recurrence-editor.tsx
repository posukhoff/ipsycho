import { type ReactNode } from "react";
import { TEXT_LIMITS, type MissPolicy, type RecurrenceInput, type TaskKind, type Weekday } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { DateField, DateListEditor, Field, MonthDayPicker, NumberInput, SegmentedControl, Switch, WeekdayPicker, type Option } from "../../ui/index.js";

/**
 * The repeat, with the two parts the bot could only ever set by conversation: the end date and the
 * dates the series skips.
 *
 * `frequency: "none"` is the draft's own value, not the contract's — a task with no repeat sends
 * `recurrence: null`, and giving the control a fourth segment is how the form says «не повторять»
 * without a second checkbox above it.
 */

export type RecurrenceFrequency = "none" | RecurrenceInput["frequency"];

export interface RecurrenceDraft {
  readonly frequency: RecurrenceFrequency;
  readonly interval: number;
  readonly weekdays: readonly Weekday[];
  readonly monthDays: readonly number[];
  readonly until: string | null;
  readonly skipDates: readonly string[];
  readonly missed: MissPolicy;
}

export const EMPTY_RECURRENCE: RecurrenceDraft = { frequency: "none", interval: 1, weekdays: [], monthDays: [], until: null, skipDates: [], missed: "expire" };

const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

function asWeekdays(values: readonly string[]): Weekday[] {
  return WEEKDAYS.filter((day) => values.includes(day));
}

export function recurrenceFromDraft(draft: RecurrenceDraft, kind: TaskKind): RecurrenceInput | null {
  if (draft.frequency === "none") return null;
  return {
    frequency: draft.frequency,
    interval: draft.interval,
    weekdays: draft.frequency === "weekly" && draft.weekdays.length > 0 ? [...draft.weekdays] : null,
    monthDays: draft.frequency === "monthly" && draft.monthDays.length > 0 ? [...draft.monthDays] : null,
    until: draft.until,
    skipDates: draft.skipDates.length > 0 ? [...draft.skipDates] : null,
    // An event has no miss policy; sending one would be a field the domain has nowhere to put.
    missed: kind === "task" ? draft.missed : null,
  };
}

export function RecurrenceEditor({
  value,
  onChange,
  kind,
  todayLocalDate,
}: {
  value: RecurrenceDraft;
  onChange: (next: RecurrenceDraft) => void;
  kind: TaskKind;
  todayLocalDate: string;
}): ReactNode {
  const t = useT();
  const patch = (next: Partial<RecurrenceDraft>): void => onChange({ ...value, ...next });

  const frequencies: readonly Option<RecurrenceFrequency>[] = [
    { value: "none", label: t("recurrence.none") },
    { value: "daily", label: t("recurrence.daily") },
    { value: "weekly", label: t("recurrence.weekly") },
    { value: "monthly", label: t("recurrence.monthly") },
  ];

  return (
    <>
      <Field label={t("recurrence.label")}>
        <SegmentedControl value={value.frequency} options={frequencies} onChange={(frequency) => patch({ frequency })} />
      </Field>

      {value.frequency === "none" ? null : (
        <>
          <Field label={t("recurrence.interval")}>
            <NumberInput value={value.interval} min={1} max={365} onChange={(interval) => patch({ interval: interval && interval > 0 ? interval : 1 })} />
          </Field>

          {value.frequency === "weekly" ? (
            <Field label={t("recurrence.weekdays")}>
              <WeekdayPicker values={value.weekdays} onChange={(days) => patch({ weekdays: asWeekdays(days) })} />
            </Field>
          ) : null}

          {value.frequency === "monthly" ? (
            <Field label={t("recurrence.month_days")}>
              <MonthDayPicker values={value.monthDays} onChange={(monthDays) => patch({ monthDays })} />
            </Field>
          ) : null}

          <Field label={t("recurrence.until_label")} hint={value.until ? undefined : t("recurrence.endless")}>
            <Switch checked={value.until !== null} label={t("recurrence.until_label")} onChange={(on) => patch({ until: on ? todayLocalDate : null })} />
          </Field>
          {value.until === null ? null : (
            <Field>
              <DateField value={value.until} todayLocalDate={todayLocalDate} min={todayLocalDate} onChange={(until) => patch({ until })} />
            </Field>
          )}

          <Field label={t("recurrence.skip_dates")}>
            <DateListEditor values={value.skipDates} todayLocalDate={todayLocalDate} max={TEXT_LIMITS.recurrenceExcludedDates} onChange={(skipDates) => patch({ skipDates })} />
          </Field>

          {kind === "task" ? (
            <Field label={t("recurrence.miss_policy")}>
              <SegmentedControl
                value={value.missed}
                options={[
                  { value: "expire", label: t("recurrence.miss_expire") },
                  { value: "carry_over", label: t("recurrence.miss_carry") },
                ]}
                onChange={(missed) => patch({ missed })}
              />
            </Field>
          ) : null}
        </>
      )}
    </>
  );
}
