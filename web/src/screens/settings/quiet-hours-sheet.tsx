import { useState, type ReactNode } from "react";
import type { QuietHoursView } from "../../api/contracts.js";
import { useT, type Translator } from "../../i18n/index.js";
import { Button, Field, ListRow, Pill, Sheet, Stack, Switch, TimeField } from "../../ui/index.js";
import type { SettingsPatchApi } from "./use-settings-patch.js";

/**
 * Quiet hours: two windows, and the one thing about them that looks like a bug and is not.
 *
 * A quiet window normally crosses midnight — «не пиши мне с 22:00 до 08:00» — so `start > end` is
 * the *common* case, not an error. Printing «22:00–08:00» flat reads as a range typed backwards, so
 * a crossing window is spelled out with «до … завтра» and carries the same marker in the list.
 *
 * The weekend is optional on purpose, and the rule is the domain's, not this screen's:
 * `buildSettingsPatch` copies the weekday range into the weekend when the weekend fields are null,
 * because naming one range is what a person actually says. So the switch below sends nulls rather
 * than duplicating the two times, and the two stay linked afterwards instead of silently drifting.
 */
export function QuietHoursSheet({ quietHours, patch, onClose }: { quietHours: QuietHoursView; patch: SettingsPatchApi; onClose: () => void }): ReactNode {
  const t = useT();
  const [weekdayStart, setWeekdayStart] = useState(quietHours.weekdayStart);
  const [weekdayEnd, setWeekdayEnd] = useState(quietHours.weekdayEnd);
  const [weekendStart, setWeekendStart] = useState(quietHours.weekendStart);
  const [weekendEnd, setWeekendEnd] = useState(quietHours.weekendEnd);
  const [splitWeekend, setSplitWeekend] = useState(quietHours.weekendStart !== quietHours.weekdayStart || quietHours.weekendEnd !== quietHours.weekdayEnd);

  const valid = Boolean(weekdayStart && weekdayEnd && (!splitWeekend || (weekendStart && weekendEnd)));

  return (
    <Sheet open onClose={onClose} title={t("settings.quiet_hours")}>
      <Stack>
        <div className="ip-field__label">{t("settings.quiet_weekday")}</div>
        <div className="ip-inline">
          <Field label={t("settings.quiet_from")}>
            <TimeField value={weekdayStart} allowEmpty={false} onChange={(value) => setWeekdayStart(value ?? weekdayStart)} />
          </Field>
          <Field label={t("settings.quiet_to")}>
            <TimeField value={weekdayEnd} allowEmpty={false} onChange={(value) => setWeekdayEnd(value ?? weekdayEnd)} />
          </Field>
        </div>
        <p className="ip-muted ip-small">{quietWindowLabel(weekdayStart, weekdayEnd, t)}</p>

        <ListRow
          title={t("settings.quiet_weekend")}
          subtitle={splitWeekend ? null : quietWindowLabel(weekdayStart, weekdayEnd, t)}
          trailing={<Switch checked={splitWeekend} label={t("settings.quiet_weekend")} onChange={setSplitWeekend} />}
        />

        {splitWeekend ? (
          <>
            <div className="ip-inline">
              <Field label={t("settings.quiet_from")}>
                <TimeField value={weekendStart} allowEmpty={false} onChange={(value) => setWeekendStart(value ?? weekendStart)} />
              </Field>
              <Field label={t("settings.quiet_to")}>
                <TimeField value={weekendEnd} allowEmpty={false} onChange={(value) => setWeekendEnd(value ?? weekendEnd)} />
              </Field>
            </div>
            <p className="ip-muted ip-small">{quietWindowLabel(weekendStart, weekendEnd, t)}</p>
          </>
        ) : null}

        <Button
          block
          variant="primary"
          disabled={!valid}
          loading={patch.isPending}
          onClick={() => {
            void patch
              .save({
                operation: "quiet_hours",
                enabled: true,
                weekdayStart,
                weekdayEnd,
                // Null means «the weekend follows the weekday range», which is what the domain does
                // with it. Sending a copy instead would freeze today's times into the weekend row.
                weekendStart: splitWeekend ? weekendStart : null,
                weekendEnd: splitWeekend ? weekendEnd : null,
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

/** True when the window runs past midnight, which is what most quiet windows do. */
export function crossesMidnight(start: string, end: string): boolean {
  return start > end;
}

/** «с 22:00 до 08:00 завтра» — the crossing is named rather than left to look like a typo. */
export function quietWindowLabel(start: string, end: string, t: Translator): string {
  const base = `${t("settings.quiet_from")} ${start} ${t("settings.quiet_to")} ${end}`;
  return crossesMidnight(start, end) ? `${base} ${t("common.tomorrow")}` : base;
}

/** The same window as a list row's meta, with the crossing marked where there is no room to spell it. */
export function QuietWindowMeta({ start, end }: { start: string; end: string }): ReactNode {
  const t = useT();
  return (
    <span className="ip-inline">
      <span>{`${start} – ${end}`}</span>
      {crossesMidnight(start, end) ? <Pill>{t("common.tomorrow")}</Pill> : null}
    </span>
  );
}
