import { useState, type ReactNode } from "react";
import type { SettingsResponse, TimezoneApplyTo } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { detectTimezone, formatUtcOffset, useQuery } from "../../lib/index.js";
import { Button, Field, ListRow, Pill, Sheet, Spinner, Stack, TextInput } from "../../ui/index.js";
import type { SettingsPatchApi } from "./use-settings-patch.js";

/**
 * The timezone picker, and the question that follows it.
 *
 * The question is the point of this sheet. The profile zone, the digests' zone and the quiet-hours
 * zone are three separate columns, and moving the first silently would leave the morning card
 * arriving at 09:00 in a city the user left. The bot asks with four buttons (`tzapply:`); this asks
 * with the same four, and there is deliberately no default — «оставить как есть» is an answer the
 * user gives, not one the screen picks for them.
 *
 * The list itself is searched server-side (`GET /settings/timezones`) so no IANA table ships to the
 * browser, and each suggestion shows the local clock time there right now, which is what actually
 * confirms a guess. «Определить» offers the device's own zone — offered, never applied: the device
 * clock is a hint, and this is the one setting the whole schedule hangs on.
 */
export function TimezoneSheet({ settings, patch, onClose }: { settings: SettingsResponse; patch: SettingsPatchApi; onClose: () => void }): ReactNode {
  const t = useT();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);

  const trimmed = query.trim();
  const suggestions = useQuery("timezoneSearch", { query: { q: trimmed } }, { enabled: trimmed.length >= 2 });
  const detected = detectTimezone();

  if (chosen !== null) {
    return <ApplyQuestion zone={chosen} settings={settings} patch={patch} onBack={() => setChosen(null)} onDone={onClose} />;
  }

  return (
    <Sheet open onClose={onClose} title={t("settings.timezone")}>
      <Stack>
        <Field label={t("settings.timezone_search")}>
          <TextInput value={query} onChange={setQuery} placeholder={t("settings.timezone_search")} inputMode="search" boxed autoFocus />
        </Field>

        {detected && detected !== settings.timezone && trimmed.length < 2 ? (
          <ListRow title={detected} meta={<Pill tone="accent">{t("settings.timezone_detect")}</Pill>} onClick={() => setChosen(detected)} />
        ) : null}

        {trimmed.length >= 2 && suggestions.isLoading ? <Spinner label={t("common.loading")} /> : null}

        {suggestions.data?.suggestions.map((suggestion) => (
          <ListRow
            key={suggestion.id}
            title={suggestion.id}
            subtitle={formatUtcOffset(suggestion.offsetMinutes)}
            meta={suggestion.localTime}
            onClick={() => setChosen(suggestion.id)}
          />
        ))}

        {trimmed.length >= 2 && suggestions.data?.suggestions.length === 0 ? <p className="ip-muted ip-small">{t("common.nothing_here")}</p> : null}

        <p className="ip-muted ip-small">{`${t("schedule.field_timezone")}: ${settings.timezone}`}</p>
      </Stack>
    </Sheet>
  );
}

const APPLY_CHOICES: readonly TimezoneApplyTo[] = ["both", "digests", "quiet", "keep"];

function ApplyQuestion({
  zone,
  settings,
  patch,
  onBack,
  onDone,
}: {
  zone: string;
  settings: SettingsResponse;
  patch: SettingsPatchApi;
  onBack: () => void;
  onDone: () => void;
}): ReactNode {
  const t = useT();
  const labels: Record<TimezoneApplyTo, string> = {
    both: t("settings.apply_both"),
    digests: t("settings.apply_digests"),
    quiet: t("settings.apply_quiet"),
    keep: t("settings.apply_keep"),
  };

  return (
    <Sheet open onClose={onBack} title={zone}>
      <Stack>
        <p className="ip-muted">{t("settings.timezone_apply_title")}</p>
        <p className="ip-muted ip-small">{t("settings.digest_timezone", { timezone: settings.digestTimezone })}</p>
        {APPLY_CHOICES.map((choice) => (
          <Button
            key={choice}
            block
            variant={choice === "keep" ? "ghost" : "secondary"}
            disabled={patch.isPending}
            onClick={() => {
              void patch.save({ operation: "timezone", timezone: zone, applyTo: choice }).then((ok) => {
                if (ok) onDone();
              });
            }}
          >
            {labels[choice]}
          </Button>
        ))}
      </Stack>
    </Sheet>
  );
}
