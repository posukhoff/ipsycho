import { useCallback, useRef } from "react";
import type { SettingsChange, SettingsResponse } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { useMutation, useQueryCache } from "../../lib/index.js";
import { useToast, useUndo } from "../../ui/index.js";

/**
 * The one way this screen writes a setting.
 *
 * `PATCH /settings` takes a `SettingsChange` — the same discriminated union `buildSettingsPatch`
 * validates for the commands and for the model's `settings` action — plus the version the screen
 * read. So every control here names a change rather than a column, and a control that wanted a
 * column the union has no operation for is a control that must not exist.
 *
 * `project` is the optimistic half: the switch flips before the request leaves and `useMutation`
 * rolls it back if the write fails, which is the honest behaviour for a toggle — it snaps back
 * instead of pretending. It is passed through a ref because `optimistic` only ever sees the request
 * variables, and the projection belongs to the caller's control, not to the body.
 *
 * A success replaces the cached settings with what the server actually stored (one change can move
 * three columns — a digest change stamps `digestTimezone` too) and invalidates `/me`, because the
 * shell reads locale, timezone and today's date from there.
 *
 * The confirmation carries Undo when the server hands back a group. Almost every settings change is
 * a journalled `settings` action — the chat has offered Undo on it since the settings commands
 * existed — and the two that are not (snooze until morning, and a timezone applied to the digest or
 * quiet-hours columns alone) answer `undoGroupId: null`, which `useUndo` renders as a plain
 * confirmation. This screen never decides which is which.
 */
export interface SettingsPatchApi {
  readonly save: (change: SettingsChange, project?: (settings: SettingsResponse) => SettingsResponse) => Promise<boolean>;
  readonly isPending: boolean;
  /** The version guard fired: the row moved under the screen, so it has to be re-read. */
  readonly isConflict: boolean;
}

export function useSettingsPatch(settings: SettingsResponse): SettingsPatchApi {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();
  const cache = useQueryCache();
  const projection = useRef<((current: SettingsResponse) => SettingsResponse) | null>(null);

  const mutation = useMutation("patchSettings", {
    optimistic: (_vars, queryCache) => {
      const project = projection.current;
      if (!project) return;
      return queryCache.patchEach("settings", project);
    },
    onSuccess: (data) => {
      cache.set("settings", undefined, data.settings);
      cache.invalidate(["me"]);
      // Almost every settings change is a journalled action and the chat has always offered Undo on
      // it; `undoGroupId` is null for the two that are not, and the snackbar then shows the plain
      // confirmation. The screen never decides which is which.
      undo.offer(t("common.saved"), data.undoGroupId, ["settings", "me"]);
    },
    onError: () => toast.show(t("settings.failed_toast"), { tone: "error" }),
  });

  const save = useCallback<SettingsPatchApi["save"]>(
    async (change, project) => {
      projection.current = project ?? null;
      const result = await mutation.mutate({ body: { expectedVersion: settings.version, change } });
      return result !== undefined;
    },
    [mutation, settings.version],
  );

  return { save, isPending: mutation.isPending, isConflict: mutation.conflict !== null };
}
