import { type ReactNode } from "react";
import { TEXT_LIMITS, type OccurrenceSchedule, type TaskWhen } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { DateField, Field, NumberInput, SegmentedControl, TextInput, TimeField, type Option } from "../../ui/index.js";
import { addMinutesToLocalTime, instantToLocalDate } from "../../lib/index.js";

/**
 * The one control that reaches every schedule shape the domain can store.
 *
 * This is the screen the bot could never offer: in chat a time is whatever the model parsed out of
 * a sentence, and the two shapes nobody ever asked for out loud — a window with a duration, and a
 * fuzzy task with a review day — were unreachable. Here all five are one segmented control.
 *
 * The five shapes map onto the contract's four modes exactly as `schedule.ts` documents:
 * a window *is* an exact start plus a duration, so this form computes the duration from an end time
 * rather than inventing a fifth mode. `whenFromDraft` returns `null` while the draft is incomplete,
 * which is what the submit button is disabled on — the server never sees a half-filled shape.
 */

export type WhenShape = "exact" | "window" | "date" | "deadline" | "fuzzy";

export interface WhenDraft {
  readonly shape: WhenShape;
  readonly date: string | null;
  readonly time: string | null;
  /** The window's end, kept as a clock time; the duration is derived from it on submit. */
  readonly endTime: string | null;
  readonly horizonText: string;
  readonly reviewDate: string | null;
}

export function emptyWhenDraft(todayLocalDate: string): WhenDraft {
  return { shape: "exact", date: todayLocalDate, time: "10:00", endTime: "11:00", horizonText: "", reviewDate: todayLocalDate };
}

/** Minutes between two clock times on the same day; a wrap past midnight counts as the next day. */
export function durationBetween(startTime: string, endTime: string): number {
  const minutes = (value: string): number => {
    const [hours = "0", mins = "0"] = value.split(":");
    return Number(hours) * 60 + Number(mins);
  };
  const delta = minutes(endTime) - minutes(startTime);
  return delta > 0 ? delta : delta + 1440;
}

/** `null` while the draft cannot make a legal `TaskWhen`. The caller disables submit on it. */
export function whenFromDraft(draft: WhenDraft): TaskWhen | null {
  switch (draft.shape) {
    case "exact":
      return draft.date && draft.time ? { mode: "exact", date: draft.date, time: draft.time, durationMinutes: null } : null;
    case "window":
      if (!draft.date || !draft.time || !draft.endTime) return null;
      return { mode: "exact", date: draft.date, time: draft.time, durationMinutes: durationBetween(draft.time, draft.endTime) };
    case "date":
      return draft.date ? { mode: "date", date: draft.date } : null;
    case "deadline":
      return draft.date ? { mode: "deadline", date: draft.date, time: draft.time } : null;
    case "fuzzy":
      return draft.horizonText.trim() && draft.reviewDate ? { mode: "fuzzy", horizonText: draft.horizonText.trim(), reviewDate: draft.reviewDate } : null;
  }
}

/**
 * The stored occurrence, back as a draft — so «перенести» opens on the shape the task already has
 * rather than on the form's default. A window is recognised by having both ends, exactly as
 * `scheduleShape` reads it.
 */
export function draftFromSchedule(
  schedule: OccurrenceSchedule | null,
  fuzzy: { horizonText: string | null; reviewAt: string | null; timezone: string } | null,
  todayLocalDate: string,
): WhenDraft {
  const base = emptyWhenDraft(todayLocalDate);
  if (fuzzy) {
    return {
      ...base,
      shape: "fuzzy",
      horizonText: fuzzy.horizonText ?? "",
      reviewDate: fuzzy.reviewAt ? instantToLocalDate(fuzzy.reviewAt, fuzzy.timezone) : todayLocalDate,
    };
  }
  if (!schedule) return base;
  const zone = schedule.timezone;
  const clock = (instant: string): string => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: zone }).format(new Date(instant));

  if (schedule.plannedStartAt && schedule.plannedEndAt) {
    return { ...base, shape: "window", date: instantToLocalDate(schedule.plannedStartAt, zone), time: clock(schedule.plannedStartAt), endTime: clock(schedule.plannedEndAt) };
  }
  if (schedule.plannedStartAt) {
    const time = clock(schedule.plannedStartAt);
    return { ...base, shape: "exact", date: instantToLocalDate(schedule.plannedStartAt, zone), time, endTime: addMinutesToLocalTime(time, 60) };
  }
  if (schedule.dueAt) return { ...base, shape: "deadline", date: instantToLocalDate(schedule.dueAt, zone), time: clock(schedule.dueAt) };
  if (schedule.dueLocalDate) return { ...base, shape: "deadline", date: schedule.dueLocalDate, time: null };
  if (schedule.plannedLocalDate) return { ...base, shape: "date", date: schedule.plannedLocalDate, time: null };
  return base;
}

export function WhenEditor({ value, onChange, todayLocalDate }: { value: WhenDraft; onChange: (next: WhenDraft) => void; todayLocalDate: string }): ReactNode {
  const t = useT();
  const shapes: readonly Option<WhenShape>[] = [
    { value: "exact", label: t("schedule.mode_exact") },
    { value: "window", label: t("schedule.mode_window") },
    { value: "date", label: t("schedule.mode_date") },
    { value: "deadline", label: t("schedule.mode_deadline") },
    { value: "fuzzy", label: t("schedule.mode_fuzzy") },
  ];

  const patch = (next: Partial<WhenDraft>): void => onChange({ ...value, ...next });
  const duration = value.time && value.endTime ? durationBetween(value.time, value.endTime) : null;

  return (
    <>
      <Field label={t("schedule.mode")}>
        <SegmentedControl value={value.shape} options={shapes} onChange={(shape) => patch({ shape })} />
      </Field>

      {value.shape === "fuzzy" ? (
        <>
          <Field label={t("schedule.field_horizon")} hint={t("schedule.field_horizon_hint")} required>
            <TextInput value={value.horizonText} maxLength={TEXT_LIMITS.fuzzyHorizon} onChange={(horizonText) => patch({ horizonText })} boxed />
          </Field>
          <Field label={t("schedule.field_review_date")} required>
            <DateField value={value.reviewDate} todayLocalDate={todayLocalDate} onChange={(reviewDate) => patch({ reviewDate })} />
          </Field>
        </>
      ) : (
        <>
          <Field label={t("schedule.field_date")} required>
            <DateField value={value.date} todayLocalDate={todayLocalDate} onChange={(date) => patch({ date })} />
          </Field>

          {value.shape === "date" ? null : (
            <Field label={t("schedule.field_time")} required={value.shape !== "deadline"} {...(value.shape === "deadline" ? { hint: t("common.optional") } : {})}>
              <TimeField
                value={value.time}
                allowEmpty={value.shape === "deadline"}
                onChange={(time) => patch({ time, endTime: time && value.shape === "window" ? addMinutesToLocalTime(time, duration ?? 60) : value.endTime })}
              />
            </Field>
          )}

          {value.shape === "window" ? (
            <>
              <Field label={t("schedule.field_end_time")} required>
                <TimeField value={value.endTime} allowEmpty={false} onChange={(endTime) => patch({ endTime })} />
              </Field>
              <Field label={t("schedule.field_duration")}>
                <NumberInput
                  value={duration}
                  min={1}
                  max={10_080}
                  onChange={(minutes) => patch({ endTime: value.time && minutes && minutes > 0 ? addMinutesToLocalTime(value.time, minutes) : value.endTime })}
                />
              </Field>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
