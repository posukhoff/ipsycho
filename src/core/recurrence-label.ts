/** Human wording for the stored RRULE subset (daily/weekly/monthly, INTERVAL, BYDAY, BYMONTHDAY). */
export type LabelLocale = "ru" | "uk" | "en";

const WEEKDAYS: Record<LabelLocale, Record<string, string>> = {
  ru: { MO: "пн", TU: "вт", WE: "ср", TH: "чт", FR: "пт", SA: "сб", SU: "вс" },
  uk: { MO: "пн", TU: "вт", WE: "ср", TH: "чт", FR: "пт", SA: "сб", SU: "нд" },
  en: { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" },
};

const WORDS: Record<
  LabelLocale,
  {
    daily: string;
    everyDays: (n: number) => string;
    weekly: string;
    everyWeeks: (n: number) => string;
    monthly: string;
    everyMonths: (n: number) => string;
    monthDay: (d: string) => string;
    until: string;
    except: string;
  }
> = {
  ru: {
    daily: "каждый день",
    everyDays: (n) => `каждые ${n} ${plural("ru", n, "день", "дня", "дней")}`,
    weekly: "каждую неделю",
    everyWeeks: (n) => `каждые ${n} ${plural("ru", n, "неделю", "недели", "недель")}`,
    monthly: "каждый месяц",
    everyMonths: (n) => `каждые ${n} ${plural("ru", n, "месяц", "месяца", "месяцев")}`,
    monthDay: (d) => `${d}-го`,
    until: "до",
    except: "кроме",
  },
  uk: {
    daily: "щодня",
    everyDays: (n) => `кожні ${n} ${plural("uk", n, "день", "дні", "днів")}`,
    weekly: "щотижня",
    everyWeeks: (n) => `кожні ${n} ${plural("uk", n, "тиждень", "тижні", "тижнів")}`,
    monthly: "щомісяця",
    everyMonths: (n) => `кожні ${n} ${plural("uk", n, "місяць", "місяці", "місяців")}`,
    monthDay: (d) => `${d}-го`,
    until: "до",
    except: "крім",
  },
  en: {
    daily: "every day",
    everyDays: (n) => `every ${n} days`,
    weekly: "every week",
    everyWeeks: (n) => `every ${n} weeks`,
    monthly: "every month",
    everyMonths: (n) => `every ${n} months`,
    monthDay: (d) => ordinal(Number(d)),
    until: "until",
    except: "except",
  },
};

/**
 * The rhythm as one line. Excluded dates belong here: a label that says «каждый вторник» while the
 * nearest Tuesday is skipped describes a series the user does not have.
 */
export function recurrenceLabel(
  rule: string | null | undefined,
  endLocalDate?: string | null,
  locale: LabelLocale = "ru",
  excludedLocalDates: readonly string[] = [],
): string | null {
  if (!rule) return null;
  const parts = Object.fromEntries(
    rule.split(";").map((part) => {
      const [key, value] = part.split("=");
      return [key?.trim().toUpperCase() ?? "", value?.trim() ?? ""];
    }),
  ) as Record<string, string>;
  const interval = Math.max(1, Number.parseInt(parts.INTERVAL ?? "1", 10) || 1);
  const frequency = parts.FREQ;
  const words = WORDS[locale];
  let text: string | null = null;
  if (frequency === "DAILY") text = interval === 1 ? words.daily : words.everyDays(interval);
  else if (frequency === "WEEKLY") {
    const days = (parts.BYDAY ?? "")
      .split(",")
      .map((day) => WEEKDAYS[locale][day.trim().toUpperCase()])
      .filter(Boolean);
    const base = interval === 1 ? words.weekly : words.everyWeeks(interval);
    text = days.length ? `${base}: ${days.join(", ")}` : base;
  } else if (frequency === "MONTHLY") {
    const days = (parts.BYMONTHDAY ?? "")
      .split(",")
      .map((day) => day.trim())
      .filter(Boolean);
    const base = interval === 1 ? words.monthly : words.everyMonths(interval);
    text = days.length ? `${base}, ${days.map(words.monthDay).join(", ")}` : base;
  }
  if (!text) return null;
  if (endLocalDate) {
    const [year, month, day] = endLocalDate.split("-");
    if (year && month && day) text = `${text} ${words.until} ${day}.${month}.${year}`;
  }
  const skipped = [...excludedLocalDates].sort();
  if (skipped.length) {
    const shown = skipped.slice(0, 3).map(dayMonth).filter(Boolean);
    const rest = skipped.length - shown.length;
    if (shown.length) text = `${text}, ${words.except} ${shown.join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
  }
  return text;
}

function dayMonth(localDate: string): string | null {
  const [, month, day] = localDate.split("-");
  return month && day ? `${day}.${month}` : null;
}

function ordinal(day: number): string {
  const mod100 = day % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `${day}${suffix}`;
}

function plural(locale: LabelLocale, count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return locale === "uk" && mod10 >= 2 && mod10 <= 4 ? few : many;
}
