import { useEffect, useState, type ReactNode } from "react";
import { TEXT_LIMITS, type FuzzySchedule, type OccurrenceSchedule, type ReschedulePreset, type RescheduleReasonCode, type RescheduleRequest } from "../../api/contracts.js";
import { useT, type CopyKey } from "../../i18n/index.js";
import { formatInstantTime, useMutation, useQuery } from "../../lib/index.js";
import { Button, ConflictNotice, Field, Sheet, SegmentedControl, Spinner, TextInput, useToast, useUndo, type Option } from "../../ui/index.js";
import { WhenEditor, draftFromSchedule, whenFromDraft, type WhenDraft } from "./when-editor.js";

/**
 * The reschedule sheet — where the reminder card's «📅 Другая дата» button lands (task 10.2).
 *
 * The card kept the three presets because they answer the message in the moment. Everything the
 * card could not hold is here: an arbitrary date in any of the five shapes, the choice between
 * moving one date and changing the rule, and the reason — asked **because the server says it is
 * required for this occurrence**, not because the client guessed. `rescheduleOptions` answers with
 * `reasonRequired`, `hasSeries` and what each preset resolves to right now, so the buttons can name
 * the time they will produce instead of a relative phrase the user has to translate.
 */

const REASON_KEYS: Record<RescheduleReasonCode, CopyKey> = {
  time: "reschedule.reason_time",
  dependency: "reschedule.reason_dependency",
  energy: "reschedule.reason_energy",
  other: "reschedule.reason_other",
};

const PRESET_KEYS: Record<ReschedulePreset, CopyKey> = {
  "1h": "reschedule.preset_1h",
  evening: "reschedule.preset_evening",
  tomorrow: "reschedule.preset_tomorrow",
};

export function RescheduleSheet({
  open,
  onClose,
  id,
  expectedVersion,
  schedule,
  fuzzy,
  todayLocalDate,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** The id the deep link named: an occurrence when there is one, the task otherwise. */
  id: string;
  expectedVersion: number;
  schedule: OccurrenceSchedule | null;
  fuzzy: FuzzySchedule | null;
  todayLocalDate: string;
  onDone: () => void;
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();

  const options = useQuery("rescheduleOptions", { params: { id } }, { enabled: open });
  const [draft, setDraft] = useState<WhenDraft>(() => draftFromSchedule(schedule, fuzzy, todayLocalDate));
  const [custom, setCustom] = useState(false);
  const [scope, setScope] = useState<"occurrence" | "series">("occurrence");
  const [reason, setReason] = useState<RescheduleReasonCode | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [wasOpen, setWasOpen] = useState(open);

  // Opening the sheet re-reads the occurrence: after one move the next one starts from the new
  // time, not from the one the screen mounted with.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft(draftFromSchedule(schedule, fuzzy, todayLocalDate));
      setCustom(false);
      setReason(null);
      setReasonText("");
    }
  }

  const reschedule = useMutation("reschedule", {
    invalidate: ["task", "taskList", "today", "pausedSeries", "reminders", "week", "goal"],
    onSuccess: (data) => {
      undo.offer(t("reschedule.done_toast"), data.undoGroupId, ["task", "taskList", "today", "reminders"]);
      onDone();
      onClose();
    },
  });

  // A conflict is not a failure to report: it is the row having moved, and it renders as a notice
  // with a reload rather than as a red toast (`ConflictNotice`, below).
  useEffect(() => {
    if (reschedule.error !== undefined && reschedule.conflict === null) toast.show(t("reschedule.failed_toast"), { tone: "error" });
  }, [reschedule.error, reschedule.conflict, toast, t]);

  const data = options.data;
  const reasonRequired = data?.reasonRequired ?? false;
  const reasonReady = !reasonRequired || (reason !== null && (reason !== "other" || reasonText.trim().length > 0));
  const customWhen = whenFromDraft(draft);

  const submit = (when: RescheduleRequest["when"]): void => {
    if (!reasonReady) return;
    void reschedule.mutate({
      params: { id },
      body: {
        expectedVersion,
        when,
        reason: reason === null ? null : { code: reason, text: reason === "other" ? reasonText.trim() : null },
        scope: data?.hasSeries ? scope : null,
        // Changing the rule itself is the create/edit form's job; this only moves what is planned.
        recurrence: null,
      },
    });
  };

  const scopeOptions: readonly Option<"occurrence" | "series">[] = [
    { value: "occurrence", label: t("reschedule.scope_occurrence") },
    { value: "series", label: t("reschedule.scope_series") },
  ];

  return (
    <Sheet open={open} onClose={onClose} title={t("reschedule.title")}>
      {reschedule.conflict ? (
        <ConflictNotice
          onReload={() => {
            reschedule.reset();
            onDone();
            onClose();
          }}
        />
      ) : null}

      {options.isLoading ? <Spinner label={t("common.loading")} /> : null}

      {data ? (
        <div className="ip-stack">
          {reasonRequired ? <p className="ip-muted ip-small">{t("reschedule.repeated_hint")}</p> : null}

          {data.hasSeries ? (
            <Field label={t("reschedule.scope")}>
              <SegmentedControl value={scope} options={scopeOptions} onChange={setScope} />
            </Field>
          ) : null}

          {reasonRequired ? (
            <Field label={t("reschedule.reason")} hint={t("reschedule.reason_required")} required>
              <div className="ip-chip-group">
                {(Object.keys(REASON_KEYS) as RescheduleReasonCode[]).map((code) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={reason === code}
                    className={`ip-chip${reason === code ? " ip-chip--selected" : ""}`}
                    onClick={() => setReason(code)}
                  >
                    {t(REASON_KEYS[code])}
                  </button>
                ))}
              </div>
            </Field>
          ) : null}

          {reasonRequired && reason === "other" ? (
            <Field>
              <TextInput value={reasonText} boxed maxLength={TEXT_LIMITS.rescheduleReason} placeholder={t("reschedule.reason_text")} onChange={setReasonText} />
            </Field>
          ) : null}

          <div className="ip-inline">
            {data.presets.map((preset) => (
              <Button key={preset} small variant="secondary" disabled={!reasonReady || reschedule.isPending} onClick={() => submit({ kind: "preset", preset })}>
                {`${t(PRESET_KEYS[preset])} · ${formatInstantTime(data.presetTimes[preset], data.timezone, t.locale)}`}
              </Button>
            ))}
          </div>

          {custom ? (
            <>
              <WhenEditor value={draft} onChange={setDraft} todayLocalDate={todayLocalDate} />
              <Button
                block
                variant="primary"
                loading={reschedule.isPending}
                disabled={customWhen === null || !reasonReady}
                onClick={() => customWhen && submit({ kind: "custom", when: customWhen })}
              >
                {t("reschedule.submit")}
              </Button>
            </>
          ) : (
            <Button block variant="ghost" onClick={() => setCustom(true)}>
              {t("reschedule.custom")}
            </Button>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
