import type { ReactNode } from "react";
import type { WeekPoolRow } from "../../api/contracts.js";
import { useNavigate } from "../../app/index.js";
import { useT } from "../../i18n/index.js";
import { Button, Checkbox, IconButton, Inline, ListRow, Pill } from "../../ui/index.js";

/**
 * One task in the pool: the checkbox that takes it for the week, and the tap that gives it today.
 *
 * The three states the row can be in are all states, and none of them is hidden:
 *
 * - **taken** (`picked`) — the box is ticked. `isPickLive` on the server decided that, because it
 *   needs `targetWeekStart`, which needs the user's timezone; a client that recomputed it would put
 *   Sunday's pick in the wrong week for exactly one day a week.
 * - **taken last week and never given a day** (`stale`) — the box is *empty*, because the pick no
 *   longer counts, and the row says «взято на прошлой неделе» so that the empty box reads as an
 *   unfinished decision rather than as a task nobody has ever looked at. That is the point of
 *   marking a pick with the Monday it is for: nothing has to clear it, and it stays readable.
 * - **overdue** — a one-off whose day has passed is in the pool too, because the pool is where its
 *   next day gets chosen (`POOL_MEMBERSHIP` in `src/tasks/tasks.repository.ts`).
 *
 * The row is a `<div>`, not a link: `ListRow` renders an anchor when it is given a route, and the
 * checkbox inside an anchor would both toggle the pick and navigate on one tap.
 */

export interface WeekRowProps {
  readonly row: WeekPoolRow;
  /** The week is full and this row is not in it — `pickLimit` is sent so the tap can be capped. */
  readonly pickDisabled: boolean;
  readonly takeDisabled: boolean;
  readonly onToggle: (row: WeekPoolRow) => void;
  readonly onTakeToday: (row: WeekPoolRow) => void;
}

export function WeekPoolListRow({ row, pickDisabled, takeDisabled, onToggle, onTakeToday }: WeekRowProps): ReactNode {
  const t = useT();
  const navigate = useNavigate();

  return (
    <ListRow
      leading={<Checkbox square checked={row.picked} disabled={pickDisabled} label={t("week.pick_label")} onChange={() => onToggle(row)} />}
      title={row.title}
      subtitle={
        <Inline>
          {row.overdue ? <Pill tone="danger">{t("task.overdue")}</Pill> : null}
          {row.stale ? <Pill tone="accent">{t("week.stale")}</Pill> : null}
          {row.importance === "critical" ? <Pill tone="danger">{t("task.importance_critical")}</Pill> : null}
          {row.importance === "required" ? <Pill>{t("task.importance_required")}</Pill> : null}
          {/* One tap, on the row it is about: this is what the morning card's eight tap rows become. */}
          <Button small variant="ghost" disabled={takeDisabled} onClick={() => onTakeToday(row)}>
            {t("week.take_today")}
          </Button>
        </Inline>
      }
      trailing={<IconButton label={t("common.open")} icon="›" onClick={() => navigate.push({ name: "task", id: row.taskId })} />}
    />
  );
}
