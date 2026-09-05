import { useCallback } from "react";
import type { EndpointName } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { haptics, useMutation } from "../../lib/index.js";
import { useToast, useUndo } from "../../ui/index.js";

/**
 * «Поставить на сегодня» — one tap that gives a pool task today's date (task 7.3).
 *
 * This is what the morning card's eight `wk:d` rows become. The card listed every task taken for
 * the week and put a tap row under each; the app has the pool itself on screen, so the same
 * decision is one button on the row it is about, and the card keeps one launch button instead.
 *
 * It lives here rather than inside the week screen because two screens make the same offer: the
 * week pool (7.3), and a fuzzy task whose review day is today, which the Today screen shows with no
 * occurrence to act on — that row's only honest action is to give it a day.
 *
 * The write is reversible — `ActionsService` journals the reschedule and answers with the group —
 * so the confirmation carries Undo. When the server answers `undoGroupId: null` the snackbar shows
 * the sentence and no button, which is `useUndo`'s contract and the rule in `AGENTS.md`.
 */

/** Everything a new date changes: the pool loses the row, today gains it, the lists shift. */
const TOUCHED: readonly EndpointName[] = ["week", "today", "taskList", "task"];

export interface TakeTodayTarget {
  readonly taskId: string;
  /** The task version; the write is optimistic-concurrency checked like every other one. */
  readonly version: number;
}

export interface TakeTodayApi {
  readonly take: (target: TakeTodayTarget) => void;
  readonly isPending: boolean;
}

export function useTakeToday(): TakeTodayApi {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();

  const mutation = useMutation("takeToday", {
    // The buzz is fired by hand so that a refusal cannot buzz "success" on its way to an error toast.
    haptic: false,
    invalidate: TOUCHED,
    optimistic: (vars, cache) => {
      const taskId = vars.params?.taskId;
      if (!taskId) return;
      // The row leaves the pool the moment it has a day — the same reason the bot redrew its card
      // and dropped the line rather than leaving a tap that no longer means anything.
      return cache.patchEach("week", (data) => {
        const row = data.rows.find((candidate) => candidate.taskId === taskId);
        if (!row) return data;
        return {
          ...data,
          rows: data.rows.filter((candidate) => candidate.taskId !== taskId),
          pickedCount: row.picked ? Math.max(0, data.pickedCount - 1) : data.pickedCount,
        };
      });
    },
    onSuccess: (data) => {
      haptics.notify("success");
      undo.offer(t("week.taken_today_toast"), data.undoGroupId, TOUCHED);
    },
    onError: (error) => {
      haptics.notify("error");
      // The server's own sentence is diagnostic English; the user reads the dictionary's.
      toast.show(t.error(error), { tone: "error" });
    },
  });

  const { mutate, isPending } = mutation;

  const take = useCallback(
    (target: TakeTodayTarget) => {
      void mutate({ params: { taskId: target.taskId }, body: { expectedVersion: target.version } });
    },
    [mutate],
  );

  return { take, isPending };
}
