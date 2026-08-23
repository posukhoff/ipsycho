/** Human wording for the stored RRULE subset (daily/weekly/monthly, INTERVAL, BYDAY, BYMONTHDAY). */
const WEEKDAYS: Record<string, string> = { MO: "пн", TU: "вт", WE: "ср", TH: "чт", FR: "пт", SA: "сб", SU: "вс" };

export function recurrenceLabel(rule: string | null | undefined, endLocalDate?: string | null): string | null {
  if (!rule) return null;
  const parts = Object.fromEntries(rule.split(";").map((part) => {
    const [key, value] = part.split("=");
    return [key?.trim().toUpperCase() ?? "", value?.trim() ?? ""];
  })) as Record<string, string>;
  const interval = Math.max(1, Number.parseInt(parts.INTERVAL ?? "1", 10) || 1);
  const frequency = parts.FREQ;
  let text: string | null = null;
  if (frequency === "DAILY") text = interval === 1 ? "каждый день" : `каждые ${interval} ${plural(interval, "день", "дня", "дней")}`;
  else if (frequency === "WEEKLY") {
    const days = (parts.BYDAY ?? "").split(",").map((day) => WEEKDAYS[day.trim().toUpperCase()]).filter(Boolean);
    const base = interval === 1 ? "каждую неделю" : `каждые ${interval} ${plural(interval, "неделю", "недели", "недель")}`;
    text = days.length ? `${base}: ${days.join(", ")}` : base;
  } else if (frequency === "MONTHLY") {
    const days = (parts.BYMONTHDAY ?? "").split(",").map((day) => day.trim()).filter(Boolean);
    const base = interval === 1 ? "каждый месяц" : `каждые ${interval} ${plural(interval, "месяц", "месяца", "месяцев")}`;
    text = days.length ? `${base}, ${days.map((day) => `${day}-го`).join(", ")}` : base;
  }
  if (!text) return null;
  if (endLocalDate) {
    const [year, month, day] = endLocalDate.split("-");
    if (year && month && day) text = `${text} до ${day}.${month}.${year}`;
  }
  return text;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
