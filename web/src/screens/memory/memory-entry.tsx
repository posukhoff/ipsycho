import { useState, type ReactNode } from "react";
import { TEXT_LIMITS, type EndpointName, type MemoryRow, type MemoryType } from "../../api/contracts.js";
import { useTodayLocalDate, useTimezone } from "../../app/index.js";
import { useT, type Translator } from "../../i18n/index.js";
import { formatLocalDate, instantToLocalDate, useMutation } from "../../lib/index.js";
import { Button, Checkbox, ConflictNotice, Field, ListRow, Pill, Select, Sheet, Stack, Switch, TextArea, useToast, useUndo, type Option } from "../../ui/index.js";

/**
 * One remembered fact: the row, and the sheet that edits or deletes it.
 *
 * Shared by `/memory` and `/profile` because they are one store — the profile is `memory_items` of
 * type `context`, not a second table — so an editor that behaved differently on the two screens
 * would be two ways to write the same row.
 *
 * The sensitive marking is the part with a rule behind it. A sensitive fact is kept out of the
 * model's context, and that is exactly why it has to be visible and editable here: it was invisible
 * everywhere else. Every write that touches one carries `confirmSensitive`, the same explicit
 * confirmation the chat asks for, and the screen refuses to send the write without it rather than
 * letting the server answer for it. Nothing here implies the model can see it — the hint says the
 * opposite, because that is what the marking means.
 */

export function MemoryEntryRow({ row, onOpen }: { row: MemoryRow; onOpen: () => void }): ReactNode {
  const t = useT();
  const timezone = useTimezone();
  const todayLocalDate = useTodayLocalDate();

  return (
    <ListRow
      title={row.content}
      subtitle={
        <span className="ip-inline">
          <Pill>{typeLabel(row.type, t)}</Pill>
          {row.sensitive ? <Pill tone="danger">{`🔒 ${t("memory.sensitive")}`}</Pill> : null}
          <span className="ip-muted ip-small">{t("memory.source", { source: row.source })}</span>
        </span>
      }
      meta={formatLocalDate(instantToLocalDate(row.updatedAt, timezone), t.locale, { todayLocalDate })}
      onClick={onOpen}
      chevron
    />
  );
}

/** The endpoints whose lists hold this row; both are refetched after a write and after an Undo. */
const TOUCHED: readonly EndpointName[] = ["memory", "profile"];

export function MemoryEntrySheet({
  row,
  allowTypeChange = true,
  onClose,
  onReload,
}: {
  row: MemoryRow;
  allowTypeChange?: boolean;
  onClose: () => void;
  onReload: () => void;
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();

  const [content, setContent] = useState(row.content);
  const [type, setType] = useState<MemoryType>(row.type);
  const [sensitive, setSensitive] = useState(row.sensitive);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Required when the entry is sensitive now *or* becomes sensitive — the contract's rule, stated
  // here so the button is disabled rather than the request refused.
  const needsConfirmation = row.sensitive || sensitive;

  const update = useMutation("patchMemory", {
    invalidate: TOUCHED,
    onSuccess: (data) => {
      undo.offer(t("memory.updated_toast"), data.undoGroupId, TOUCHED);
      onClose();
    },
    onError: () => toast.show(t("settings.failed_toast"), { tone: "error" }),
  });

  const remove = useMutation("deleteMemory", {
    invalidate: TOUCHED,
    onSuccess: (data) => {
      // `undoGroupId` is what decides whether an Undo button appears at all: a delete the server
      // cannot reverse answers with null, and the snackbar then only says what happened.
      undo.offer(t("memory.deleted_toast"), data.undoGroupId, TOUCHED);
      onClose();
    },
    onError: () => toast.show(t("settings.failed_toast"), { tone: "error" }),
  });

  const conflict = update.conflict ?? remove.conflict;
  const types: readonly Option<MemoryType>[] = (["note", "decision", "preference", "context"] as const).map((value) => ({ value, label: typeLabel(value, t) }));
  const canWrite = content.trim().length > 0 && (!needsConfirmation || confirmed);

  if (conflict) {
    return (
      <Sheet open onClose={onClose} title={t("error.conflict_title")}>
        <ConflictNotice
          onReload={() => {
            onReload();
            onClose();
          }}
        />
      </Sheet>
    );
  }

  if (confirmingDelete) {
    return (
      <Sheet open onClose={() => setConfirmingDelete(false)} title={t("common.delete")}>
        <Stack>
          <p className="ip-muted">{row.content}</p>
          {row.sensitive ? <p className="ip-muted ip-small">{t("memory.sensitive_hint")}</p> : null}
          {needsConfirmation ? (
            <ListRow title={t("memory.sensitive_confirm")} leading={<Checkbox checked={confirmed} label={t("memory.sensitive_confirm")} onChange={setConfirmed} />} />
          ) : null}
          <Button
            block
            variant="danger"
            disabled={needsConfirmation && !confirmed}
            loading={remove.isPending}
            onClick={() => {
              void remove.mutate({ params: { id: row.id }, body: { expectedVersion: row.version, confirmSensitive: confirmed } });
            }}
          >
            {t("common.delete")}
          </Button>
          <Button block variant="ghost" onClick={() => setConfirmingDelete(false)}>
            {t("common.cancel")}
          </Button>
        </Stack>
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={onClose} title={t("common.edit")}>
      <Stack>
        <Field label={t("memory.title")} hint={t("memory.source", { source: row.source })}>
          <TextArea value={content} onChange={setContent} rows={4} maxLength={TEXT_LIMITS.memoryContent} />
        </Field>

        {allowTypeChange ? (
          <Field label={t("memory.type_label")}>
            <Select value={type} options={types} onChange={setType} />
          </Field>
        ) : null}

        <ListRow
          title={t("memory.sensitive")}
          subtitle={t("memory.sensitive_hint")}
          trailing={<Switch checked={sensitive} label={t("memory.sensitive")} onChange={setSensitive} />}
        />

        {needsConfirmation ? (
          <ListRow title={t("memory.sensitive_confirm")} leading={<Checkbox checked={confirmed} label={t("memory.sensitive_confirm")} onChange={setConfirmed} />} />
        ) : null}

        <Button
          block
          variant="primary"
          disabled={!canWrite}
          loading={update.isPending}
          onClick={() => {
            void update.mutate({
              params: { id: row.id },
              body: {
                expectedVersion: row.version,
                content: content.trim(),
                type: allowTypeChange ? type : null,
                sensitive,
                confirmSensitive: confirmed,
              },
            });
          }}
        >
          {t("common.save")}
        </Button>

        <Button block variant="danger" onClick={() => setConfirmingDelete(true)}>
          {t("common.delete")}
        </Button>
      </Stack>
    </Sheet>
  );
}

export function typeLabel(type: MemoryType, t: Translator): string {
  if (type === "decision") return t("memory.type_decision");
  if (type === "preference") return t("memory.type_preference");
  if (type === "context") return t("memory.type_context");
  return t("memory.type_note");
}
