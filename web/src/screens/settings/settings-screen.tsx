import { useState, type ReactNode } from "react";
import type { AccountDeleteResponse, SettingsResponse } from "../../api/contracts.js";
import { useMe, useTodayLocalDate } from "../../app/index.js";
import { useT, type Translator } from "../../i18n/index.js";
import { dayOffset, formatInstantTime, formatLocalDate, instantToLocalDate, useMutation, useQuery } from "../../lib/index.js";
import { AsyncContent, Button, ConflictNotice, ListRow, Screen, ScreenHeader, Section, Sheet, Switch, useToast } from "../../ui/index.js";
import { ClearHistorySheet, DeleteAccountSheet, DeletionScheduled } from "./account.js";
import { QuietHoursSheet, QuietWindowMeta } from "./quiet-hours-sheet.js";
import { MorningDigestSheet, ReminderDefaultsSheet, WeeklyReviewSheet } from "./schedule-sheets.js";
import { TimezoneSheet } from "./timezone-sheet.js";
import { useSettingsPatch } from "./use-settings-patch.js";

/**
 * Settings: the seven commands, `prefs:*` and `tzapply:*`, as one screen.
 *
 * The screen reads `GET /settings` rather than the copy of the row that came with `/me`, so an
 * optimistic switch has one entry to patch and one to roll back. A successful write replaces that
 * entry with the row the server stored and invalidates `/me`, because the shell takes the locale,
 * the timezone and today's date from there and a language change has to reach it.
 *
 * Everything that is only a value — a time, a weekday, a set of offsets — opens a sheet. Everything
 * that is on or off is a switch on the row, and switches are optimistic: the flip happens at the
 * tap and snaps back if the write fails, which is the only honest way to render a control whose
 * result the user is watching for.
 */
export function SettingsScreen(): ReactNode {
  const t = useT();
  const settings = useQuery("settings");
  const [deleted, setDeleted] = useState<AccountDeleteResponse | null>(null);

  if (deleted) return <DeletionScheduled result={deleted} />;

  return (
    <Screen header={<ScreenHeader title={t("settings.title")} />}>
      <AsyncContent query={settings}>{(data) => <SettingsBody settings={data} onReload={() => void settings.refetch()} onDeleted={setDeleted} />}</AsyncContent>
    </Screen>
  );
}

type SheetName = "timezone" | "language" | "quiet" | "digest" | "weekly" | "reminderDefaults" | "clearHistory" | "deleteAccount";

function SettingsBody({ settings, onReload, onDeleted }: { settings: SettingsResponse; onReload: () => void; onDeleted: (result: AccountDeleteResponse) => void }): ReactNode {
  const t = useT();
  const me = useMe();
  const todayLocalDate = useTodayLocalDate();
  const patch = useSettingsPatch(settings);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const close = (): void => setSheet(null);

  const snoozedUntil = settings.notificationsSnoozedUntil;
  const snoozed = Boolean(snoozedUntil && new Date(snoozedUntil).getTime() > Date.now());

  return (
    <>
      {patch.isConflict ? <ConflictNotice onReload={onReload} /> : null}

      <Section>
        <ListRow title={t("nav.goals")} to={{ name: "goals", scope: "active" }} chevron />
        <ListRow title={t("settings.memory")} to={{ name: "memory" }} chevron />
        <ListRow title={t("settings.profile")} to={{ name: "profile" }} chevron />
      </Section>

      <Section title={t("settings.section_time")}>
        <ListRow
          title={t("settings.timezone")}
          subtitle={settings.digestTimezone === settings.timezone ? null : t("settings.digest_timezone", { timezone: settings.digestTimezone })}
          meta={settings.timezone}
          onClick={() => setSheet("timezone")}
          chevron
        />
        <ListRow title={t("settings.language")} meta={languageLabel(settings.pinnedLanguage, t)} onClick={() => setSheet("language")} chevron />
        <ListRow
          title={t("settings.snooze_notifications")}
          subtitle={snoozed && snoozedUntil ? t("settings.snoozed_until", { until: moment(snoozedUntil, settings.timezone, todayLocalDate, t) }) : null}
          trailing={
            <Button
              small
              variant={snoozed ? "primary" : "secondary"}
              disabled={patch.isPending}
              onClick={() => {
                void patch.save(
                  { operation: "snooze", until: snoozed ? null : { kind: "morning" } },
                  // «До утра» resolves against the morning reference time on the server, so the
                  // optimistic patch only clears the field it can know: turning the silence off.
                  snoozed ? (current) => ({ ...current, notificationsSnoozedUntil: null }) : undefined,
                );
              }}
            >
              {snoozed ? t("settings.snooze_off") : t("settings.snooze_until_morning")}
            </Button>
          }
        />
      </Section>

      <Section title={t("settings.section_digests")}>
        <ListRow
          title={t("settings.morning_digest")}
          meta={settings.morningDigest.enabled ? null : t("common.off")}
          trailing={
            <Switch
              checked={settings.morningDigest.enabled}
              label={t("settings.morning_digest")}
              disabled={patch.isPending}
              onChange={(enabled) =>
                void patch.save({ operation: "digest", kind: "morning", enabled, time: null }, (current) => ({
                  ...current,
                  morningDigest: { ...current.morningDigest, enabled },
                }))
              }
            />
          }
        />
        {settings.morningDigest.enabled ? <ListRow title={t("settings.digest_time")} meta={settings.morningDigest.time} onClick={() => setSheet("digest")} chevron /> : null}
        <ListRow
          title={t("settings.weekly_review")}
          meta={settings.weeklyReview.enabled ? null : t("common.off")}
          trailing={
            <Switch
              checked={settings.weeklyReview.enabled}
              label={t("settings.weekly_review")}
              disabled={patch.isPending}
              onChange={(enabled) =>
                void patch.save({ operation: "weekly_review", enabled, weekday: null, time: null }, (current) => ({
                  ...current,
                  weeklyReview: { ...current.weeklyReview, enabled },
                }))
              }
            />
          }
        />
        {settings.weeklyReview.enabled ? (
          <ListRow
            title={t("settings.weekly_weekday")}
            meta={`${weekdayLabel(settings.weeklyReview.weekday, t)} ${settings.weeklyReview.time}`}
            onClick={() => setSheet("weekly")}
            chevron
          />
        ) : null}
        {/* Read-only: «вечером» is a reference hour the contract exposes but no `SettingsChange`
            operation writes, so it is shown rather than offered as a control that cannot save. */}
        <ListRow title={t("settings.evening_reference")} meta={settings.eveningReferenceTime} muted />
      </Section>

      <Section
        title={t("settings.section_quiet")}
        footer={settings.quietHours.timezone === settings.timezone ? null : `${t("schedule.field_timezone")}: ${settings.quietHours.timezone}`}
      >
        <ListRow
          title={t("settings.quiet_hours")}
          meta={settings.quietHours.enabled ? null : t("common.off")}
          trailing={
            <Switch
              checked={settings.quietHours.enabled}
              label={t("settings.quiet_hours")}
              disabled={patch.isPending}
              onChange={(enabled) =>
                void patch.save(
                  {
                    operation: "quiet_hours",
                    enabled,
                    // Re-enabling keeps the windows that are already on screen; the domain would
                    // otherwise fall back to its defaults and silently move them.
                    weekdayStart: enabled ? settings.quietHours.weekdayStart : null,
                    weekdayEnd: enabled ? settings.quietHours.weekdayEnd : null,
                    weekendStart: enabled ? settings.quietHours.weekendStart : null,
                    weekendEnd: enabled ? settings.quietHours.weekendEnd : null,
                  },
                  (current) => ({ ...current, quietHours: { ...current.quietHours, enabled } }),
                )
              }
            />
          }
        />
        {settings.quietHours.enabled ? (
          <>
            <ListRow
              title={t("settings.quiet_weekday")}
              meta={<QuietWindowMeta start={settings.quietHours.weekdayStart} end={settings.quietHours.weekdayEnd} />}
              onClick={() => setSheet("quiet")}
              chevron
            />
            <ListRow
              title={t("settings.quiet_weekend")}
              meta={<QuietWindowMeta start={settings.quietHours.weekendStart} end={settings.quietHours.weekendEnd} />}
              onClick={() => setSheet("quiet")}
              chevron
            />
          </>
        ) : null}
      </Section>

      <Section title={t("settings.reminder_defaults")} footer={t("settings.escalation", settings.escalationMinutes)}>
        <ListRow
          title={t("settings.event_offsets")}
          meta={settings.reminderDefaults.eventOffsetsMinutes.map((minutes) => Math.abs(minutes)).join(", ")}
          onClick={() => setSheet("reminderDefaults")}
          chevron
        />
        <ListRow title={t("settings.task_offset")} meta={String(settings.reminderDefaults.plannedTaskOffsetMinutes)} onClick={() => setSheet("reminderDefaults")} chevron />
        <ListRow title={t("settings.critical_interval")} meta={String(settings.reminderDefaults.criticalPostDueMinutes)} onClick={() => setSheet("reminderDefaults")} chevron />
      </Section>

      <AiSection />

      <Section title={t("settings.section_data")}>
        <ListRow
          title={t("settings.history")}
          meta={t("settings.history_count", { count: settings.historyMessageCount })}
          trailing={
            <Button small variant="secondary" onClick={() => setSheet("clearHistory")}>
              {t("common.clear")}
            </Button>
          }
        />
        <ListRow title={t("settings.delete_account")} subtitle={t("settings.restore_chat_only")} danger onClick={() => setSheet("deleteAccount")} />
      </Section>

      {me.commit ? <p className="ip-muted ip-small">{t("settings.build", { commit: me.commit })}</p> : null}

      {sheet === "timezone" ? <TimezoneSheet settings={settings} patch={patch} onClose={close} /> : null}
      {sheet === "language" ? <LanguageSheet settings={settings} onClose={close} /> : null}
      {sheet === "quiet" ? <QuietHoursSheet quietHours={settings.quietHours} patch={patch} onClose={close} /> : null}
      {sheet === "digest" ? <MorningDigestSheet settings={settings} patch={patch} onClose={close} /> : null}
      {sheet === "weekly" ? <WeeklyReviewSheet settings={settings} patch={patch} onClose={close} /> : null}
      {sheet === "reminderDefaults" ? <ReminderDefaultsSheet settings={settings} patch={patch} onClose={close} /> : null}
      {sheet === "clearHistory" ? <ClearHistorySheet count={settings.historyMessageCount} onClose={close} /> : null}
      {sheet === "deleteAccount" ? (
        <DeleteAccountSheet
          onClose={close}
          onDeleted={(result) => {
            close();
            onDeleted(result);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * AI and the two consents.
 *
 * The switch is a pre-check, not the authority: `ChatService` and `TranscriptionService` re-check
 * consent at the provider boundary on every call, including retries. Revoking here is immediate and
 * carries no Undo, because there is no journalled group behind it to reverse — granting again is a
 * new decision the user makes, not a rollback.
 */
function AiSection(): ReactNode {
  const t = useT();
  const me = useMe();
  const toast = useToast();
  const consents = useQuery("consents");

  const grant = useMutation("grantConsent", {
    invalidate: ["consents", "me"],
    optimistic: (vars, cache) =>
      cache.patchEach("consents", (data) => ({ consents: data.consents.map((item) => (item.scope === vars.body.scope ? { ...item, granted: true } : item)) })),
    onError: () => toast.show(t("settings.failed_toast"), { tone: "error" }),
  });

  const revoke = useMutation("revokeConsent", {
    invalidate: ["consents", "me"],
    optimistic: (vars, cache) =>
      cache.patchEach("consents", (data) => ({ consents: data.consents.map((item) => (item.scope === vars.body.scope ? { ...item, granted: false } : item)) })),
    onError: () => toast.show(t("settings.failed_toast"), { tone: "error" }),
  });

  const rows = consents.data?.consents ?? me.consents;
  const pending = grant.isPending || revoke.isPending;

  return (
    <Section title={t("settings.section_ai")}>
      <ListRow title={t("settings.ai_status")} meta={aiLabel(me.ai, t)} muted={me.ai.status !== "enabled"} />
      {rows.map((consent) => (
        <ListRow
          key={consent.scope}
          title={consent.scope === "voice" ? t("settings.consent_voice") : t("settings.consent_text")}
          subtitle={t("settings.consent_provider", { provider: consent.provider })}
          trailing={
            <Switch
              checked={consent.granted}
              disabled={pending}
              label={consent.granted ? t("settings.consent_revoke") : t("settings.consent_grant")}
              onChange={(next) => {
                const mutation = next ? grant : revoke;
                void mutation.mutate({ body: { scope: consent.scope } });
              }}
            />
          }
        />
      ))}
    </Section>
  );
}

function LanguageSheet({ settings, onClose }: { settings: SettingsResponse; onClose: () => void }): ReactNode {
  const t = useT();
  const patch = useSettingsPatch(settings);
  const options: ReadonlyArray<{ value: "auto" | "ru" | "uk" | "en"; label: string }> = [
    { value: "auto", label: t("settings.language_auto") },
    { value: "ru", label: t("settings.language_ru") },
    { value: "uk", label: t("settings.language_uk") },
    { value: "en", label: t("settings.language_en") },
  ];

  return (
    <Sheet open onClose={onClose} title={t("settings.language")}>
      {options.map((option) => (
        <ListRow
          key={option.value}
          title={option.label}
          meta={(settings.pinnedLanguage ?? "auto") === option.value ? "✓" : null}
          onClick={() => {
            void patch.save({ operation: "language", language: option.value === "auto" ? null : option.value }).then((ok) => {
              if (ok) onClose();
            });
          }}
        />
      ))}
    </Sheet>
  );
}

function languageLabel(pinned: SettingsResponse["pinnedLanguage"], t: Translator): string {
  if (pinned === "ru") return t("settings.language_ru");
  if (pinned === "uk") return t("settings.language_uk");
  if (pinned === "en") return t("settings.language_en");
  return t("settings.language_auto");
}

function aiLabel(ai: { status: "enabled" | "suspended"; configured: boolean; rateLimited: boolean }, t: Translator): string {
  if (!ai.configured) return t("settings.ai_not_configured");
  if (ai.status === "suspended") return t("settings.ai_suspended");
  if (ai.rateLimited) return t("settings.ai_rate_limited");
  return t("settings.ai_enabled");
}

function weekdayLabel(weekday: number, t: Translator): string {
  const keys = ["weekday.1", "weekday.2", "weekday.3", "weekday.4", "weekday.5", "weekday.6", "weekday.7"] as const;
  return t(keys[weekday - 1] ?? "weekday.1");
}

/** «сегодня 21:30» or «7 сент. 21:30» — an instant read in the user's own zone, never the device's. */
function moment(instant: string, timezone: string, todayLocalDate: string, t: Translator): string {
  const localDate = instantToLocalDate(instant, timezone);
  const time = formatInstantTime(instant, timezone, t.locale);
  const offset = dayOffset(localDate, todayLocalDate);
  if (offset === "today") return `${t("common.today")} ${time}`;
  if (offset === "tomorrow") return `${t("common.tomorrow")} ${time}`;
  return `${formatLocalDate(localDate, t.locale, { todayLocalDate })} ${time}`;
}
