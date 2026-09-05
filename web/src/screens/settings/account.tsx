import { useState, type ReactNode } from "react";
import type { AccountDeleteResponse } from "../../api/contracts.js";
import { useMe, useTimezone, useTodayLocalDate } from "../../app/index.js";
import { useT } from "../../i18n/index.js";
import { formatInstantTime, formatLocalDate, instantToLocalDate, useMutation } from "../../lib/index.js";
import { Button, ConfirmSheet, EmptyState, Field, Screen, Sheet, Stack, TextInput, useToast } from "../../ui/index.js";

/**
 * Clearing the AI history, and deleting the account.
 *
 * Neither is reversible from here, and the screen says so instead of offering a button that lies:
 *
 * - `POST /chat/history/clear` answers with a count and no `undoGroupId`. It is confirmed first and
 *   then simply reported.
 * - `POST /account/delete` takes the literal word `delete`, the same deterministic gate
 *   `/delete_account` puts in the chat. **Restore is not in the app on purpose**: the guard refuses
 *   a deletion-pending user exactly as the bot's allowlist gate does, so the moment this succeeds
 *   every request from this app — including the one that would undo it — comes back `unauthorized`.
 *   `/restore` in the chat is the only way back, and the sentence saying so is on the screen both
 *   before the confirmation and after it. Without it the user is left with no visible path.
 */

export function ClearHistorySheet({ count, onClose }: { count: number; onClose: () => void }): ReactNode {
  const t = useT();
  const toast = useToast();

  const clear = useMutation("clearHistory", {
    invalidate: ["settings", "me"],
    onSuccess: (data) => toast.show(t("settings.history_cleared", { count: data.cleared })),
    onError: () => toast.show(t("settings.failed_toast"), { tone: "error" }),
  });

  return (
    <ConfirmSheet
      open
      destructive
      onClose={onClose}
      pending={clear.isPending}
      title={t("settings.clear_history")}
      description={t("settings.history_count", { count })}
      confirmLabel={t("common.clear")}
      onConfirm={() => {
        void clear.mutate({}).then(() => onClose());
      }}
    />
  );
}

export function DeleteAccountSheet({ onClose, onDeleted }: { onClose: () => void; onDeleted: (result: AccountDeleteResponse) => void }): ReactNode {
  const t = useT();
  const toast = useToast();
  const graceDays = useMe().deletionGraceDays;
  const [typed, setTyped] = useState("");

  const remove = useMutation("deleteAccount", {
    onSuccess: (data) => onDeleted(data),
    onError: () => toast.show(t("settings.failed_toast"), { tone: "error" }),
  });

  const confirmed = typed.trim().toLowerCase() === "delete";

  return (
    <Sheet open onClose={onClose} title={t("settings.delete_account")}>
      <Stack>
        {/*
          Both sentences are said before the deletion, not only after it. The grace period is the
          only thing that makes «удалить» survivable, and `/delete_account` states it in the prompt
          it attaches the confirm button to — a screen that waited until the answer would be asking
          for an irreversible confirmation on less information than the chat gives. From here on the
          app is also the wrong surface, which is the second sentence.
        */}
        <p className="ip-muted">{t("settings.delete_warning", { days: graceDays })}</p>
        <p className="ip-muted">{t("settings.restore_chat_only")}</p>
        <Field label={t("settings.delete_confirm_hint")}>
          <TextInput value={typed} onChange={setTyped} placeholder="delete" boxed />
        </Field>
        <Button
          block
          variant="danger"
          disabled={!confirmed}
          loading={remove.isPending}
          onClick={() => {
            void remove.mutate({ body: { confirm: "delete" } });
          }}
        >
          {t("settings.delete_account")}
        </Button>
        <Button block variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </Stack>
    </Sheet>
  );
}

/**
 * What the app shows once deletion is scheduled. It replaces the settings screen rather than
 * navigating: every other screen would answer `unauthorized` on its next request, so a tab bar back
 * into the app would only produce the refusal screen.
 */
export function DeletionScheduled({ result }: { result: AccountDeleteResponse }): ReactNode {
  const t = useT();
  const timezone = useTimezone();
  const todayLocalDate = useTodayLocalDate();
  const localDate = instantToLocalDate(result.deleteAfter, timezone);

  return (
    <Screen header={null}>
      <EmptyState
        icon="🗑"
        title={t("settings.delete_scheduled", { date: `${formatLocalDate(localDate, t.locale, { todayLocalDate })} ${formatInstantTime(result.deleteAfter, timezone, t.locale)}` })}
        body={
          <>
            {t("settings.delete_warning", { days: result.graceDays })}
            <br />
            {t("settings.restore_chat_only")}
          </>
        }
      />
    </Screen>
  );
}
