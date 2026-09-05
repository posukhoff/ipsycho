import { type ReactNode } from "react";
import { useT } from "../i18n/index.js";
import { formatLocalDate, shiftLocalDate } from "../lib/format.js";
import { haptics } from "../lib/telegram.js";
import { Button } from "./primitives.js";
import { ChipGroup, type Option } from "./form.js";

/**
 * Date and time pickers.
 *
 * They are `<input type="date">` and `<input type="time">` rather than a custom calendar, and that
 * is a considered choice: inside Telegram the platform picker is the one the user already knows, it
 * is localised and accessible for free, and — the part that decides it — the value it produces is
 * exactly the contract's `YYYY-MM-DD` and `HH:MM`, in the *user's* stated timezone rather than the
 * device's. A hand-rolled calendar would have to re-derive a local day from an instant, which is
 * the one thing `primitives.ts` says never to do in the browser.
 *
 * The quick chips above the field are what make it fast: «сегодня», «завтра», «+ неделя» cover the
 * overwhelming majority of taps without opening a picker at all.
 */

export function DateField({
  value,
  onChange,
  todayLocalDate,
  min,
  quick = true,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  todayLocalDate: string;
  min?: string | undefined;
  quick?: boolean | undefined;
  disabled?: boolean | undefined;
}): ReactNode {
  const t = useT();
  return (
    <div className="ip-stack" style={{ gap: "var(--space-2)" }}>
      <input
        className="ip-input ip-input--boxed"
        type="date"
        value={value ?? ""}
        {...(min === undefined ? {} : { min })}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      />
      {quick ? (
        <div className="ip-chip-group">
          <QuickDate label={t("common.today")} date={todayLocalDate} current={value} onPick={onChange} />
          <QuickDate label={t("common.tomorrow")} date={shiftLocalDate(todayLocalDate, 1)} current={value} onPick={onChange} />
          <QuickDate label={`+${t.plural(7, "day")}`} date={shiftLocalDate(todayLocalDate, 7)} current={value} onPick={onChange} />
        </div>
      ) : null}
    </div>
  );
}

function QuickDate({ label, date, current, onPick }: { label: string; date: string; current: string | null; onPick: (value: string) => void }): ReactNode {
  return (
    <button
      type="button"
      className={`ip-chip${current === date ? " ip-chip--selected" : ""}`}
      onClick={() => {
        haptics.select();
        onPick(date);
      }}
    >
      {label}
    </button>
  );
}

export function TimeField({
  value,
  onChange,
  disabled,
  allowEmpty = true,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean | undefined;
  allowEmpty?: boolean | undefined;
}): ReactNode {
  return (
    <input
      className="ip-input ip-input--boxed"
      type="time"
      value={value ?? ""}
      disabled={disabled}
      required={!allowEmpty}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
    />
  );
}

/** Monday-first, `1..7`, matching `IsoWeekdayNumberSchema` and `weeklyReviewWeekday`. */
export function WeekdayPicker({ values, onChange }: { values: readonly string[]; onChange: (values: string[]) => void }): ReactNode {
  const t = useT();
  const options: readonly Option<string>[] = [
    { value: "MO", label: t("weekday.1") },
    { value: "TU", label: t("weekday.2") },
    { value: "WE", label: t("weekday.3") },
    { value: "TH", label: t("weekday.4") },
    { value: "FR", label: t("weekday.5") },
    { value: "SA", label: t("weekday.6") },
    { value: "SU", label: t("weekday.7") },
  ];
  return <ChipGroup values={values} options={options} onChange={onChange} />;
}

export function MonthDayPicker({ values, onChange }: { values: readonly number[]; onChange: (values: number[]) => void }): ReactNode {
  const options: readonly Option<string>[] = Array.from({ length: 31 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }));
  return <ChipGroup values={values.map(String)} options={options} onChange={(next) => onChange(next.map(Number).sort((a, b) => a - b))} />;
}

/**
 * The excluded dates of a repeat. Capped at `TEXT_LIMITS.recurrenceExcludedDates` by the contract;
 * the caller passes `max` so the form says so rather than letting the server refuse.
 */
export function DateListEditor({
  values,
  onChange,
  todayLocalDate,
  max,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  todayLocalDate: string;
  max: number;
}): ReactNode {
  const t = useT();
  return (
    <div className="ip-stack" style={{ gap: "var(--space-2)" }}>
      <div className="ip-chip-group">
        {values.map((date) => (
          <button
            key={date}
            type="button"
            className="ip-chip ip-chip--selected"
            onClick={() => {
              haptics.select();
              onChange(values.filter((item) => item !== date));
            }}
          >
            {formatLocalDate(date, t.locale, { todayLocalDate })} ✕
          </button>
        ))}
      </div>
      {values.length < max ? (
        <DateField
          value={null}
          quick={false}
          todayLocalDate={todayLocalDate}
          onChange={(date) => {
            if (date && !values.includes(date)) onChange([...values, date].sort());
          }}
        />
      ) : (
        <p className="ip-field__hint">{t("recurrence.skip_dates_count", { count: max })}</p>
      )}
    </div>
  );
}
/** «Через 15 минут», «через час» — the offsets the reminder card offers, as buttons. */
export function QuickChoices<Value extends string>({
  options,
  onPick,
  disabled,
}: {
  options: readonly Option<Value>[];
  onPick: (value: Value) => void;
  disabled?: boolean | undefined;
}): ReactNode {
  return (
    <div className="ip-inline">
      {options.map((option) => (
        <Button key={option.value} small variant="secondary" disabled={disabled ?? option.disabled} onClick={() => onPick(option.value)}>
          {option.label}
        </Button>
      ))}
    </div>
  );
}
