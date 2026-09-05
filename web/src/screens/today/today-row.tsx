import type { ReactNode } from "react";
import type { OccurrenceState, TaskGroup, TaskListRow } from "../../api/contracts.js";
import { Link } from "../../app/index.js";
import { useT, type Translator } from "../../i18n/index.js";
import { Button, Checkbox, IconButton, Inline, ListRow, Pill } from "../../ui/index.js";
import { whenLabel } from "./schedule-label.js";

/**
 * One line of Today, and the actions folded under it.
 *
 * **Why the row is a `<div>` and not a link.** `ListRow` renders an `<a>` when it is given a route,
 * and an interactive control inside an anchor is both invalid markup and a click that fires twice —
 * the checkbox would mark the task done *and* navigate. Today's dominant action is the checkbox, so
 * the row stays inert and the task's own screen is one item inside the folded actions.
 *
 * **Why the rest is folded.** This is the screen the morning card's launch button opens, so it has
 * to be readable in the second it appears. Done is one tap on the checkbox; «начал», «пропустить»
 * and «вижу» are one tap away behind the row's own control, which on a repeat doubles as the
 * «раскрыть» the bot's «▸» promised — the same disclosure, with the dates actually shown.
 *
 * **What is not offered.** A finished occurrence gets a checked, disabled box rather than an
 * un-tick: the contract has no state that reopens one (`OccurrenceStateSchema`), and a control that
 * cannot do what it looks like it does is the failure `AGENTS.md` names. A fuzzy task has no
 * occurrence at all, so it gets no box and no state buttons — only «поставить на сегодня», which is
 * the one decision its review day is asking for.
 */

export interface TodayRowProps {
  readonly group: TaskGroup;
  readonly todayLocalDate: string;
  readonly expanded: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onAct: (state: OccurrenceState) => void;
  /** Opens the «что мешает?» sheet, which then acts with `seen` and the note. */
  readonly onBlocker: () => void;
  readonly onTakeToday: () => void;
}

const TERMINAL = new Set(["done", "skipped", "cancelled"]);

export function TodayGroupRow({ group, todayLocalDate, expanded, busy, onToggle, onAct, onBlocker, onTakeToday }: TodayRowProps): ReactNode {
  const t = useT();
  const lead = leadRow(group);
  const others = group.rows.filter((row) => row !== lead);
  const terminal = lead.occurrenceStatus !== null && TERMINAL.has(lead.occurrenceStatus);
  const hasOccurrence = lead.occurrenceId !== null;
  const started = lead.occurrenceStatus === "in_progress";

  // A repeat's control says how many dates it hides; anything else says «ещё».
  const toggleLabel = expanded ? t("tasks.group_collapse") : others.length > 0 ? t("tasks.group_dates", { count: others.length }) : t("common.more");
  // A row whose day is not today — one that carried over, or the next date left behind once the
  // lead was closed — names the day rather than showing a bare time under a header that says today.
  const when = whenLabel(lead, t, { todayLocalDate, withDate: lead.localDate !== null && lead.localDate !== todayLocalDate });

  return (
    <>
      <ListRow
        muted={terminal}
        leading={
          hasOccurrence ? (
            <Checkbox checked={terminal} disabled={terminal || busy} label={terminal ? t("state.done") : t("state.mark_done")} onChange={() => onAct("done")} />
          ) : (
            // A fuzzy task keeps the column, so the titles still line up, and says what it is.
            <span className="ip-muted" aria-hidden="true" style={{ display: "inline-block", width: 24, textAlign: "center" }}>
              🫧
            </span>
          )
        }
        title={group.title}
        subtitle={rowPills(lead, t)}
        meta={when}
        trailing={<IconButton label={toggleLabel} icon={expanded ? "⌃" : "⋯"} onClick={onToggle} />}
      />

      {expanded ? (
        <>
          {others.map((row) => (
            <ListRow key={row.occurrenceId ?? row.taskId} muted title={whenLabel(row, t, { todayLocalDate, withDate: true })} subtitle={rowPills(row, t)} />
          ))}
          <ListRow
            title={
              <Inline>
                {hasOccurrence && !terminal ? (
                  <>
                    {started ? null : (
                      <Button small disabled={busy} onClick={() => onAct("started")}>
                        {t("state.mark_started")}
                      </Button>
                    )}
                    {lead.recurrenceRule ? (
                      <Button small disabled={busy} onClick={() => onAct("skipped")}>
                        {t("state.mark_skipped")}
                      </Button>
                    ) : null}
                    <Button small disabled={busy} onClick={onBlocker}>
                      {t("state.mark_seen")}
                    </Button>
                  </>
                ) : null}
                {hasOccurrence ? null : (
                  <Button small variant="primary" disabled={busy} onClick={onTakeToday}>
                    {t("week.take_today")}
                  </Button>
                )}
                <Link to={{ name: "task", id: lead.taskId }} className="ip-button ip-button--ghost ip-button--small">
                  {t("common.more")}
                </Link>
              </Inline>
            }
          />
        </>
      ) : null}
    </>
  );
}

/** `leadIndex` points into `rows`; the group always has at least one (`TaskGroupSchema`). */
export function leadRow(group: TaskGroup): TaskListRow {
  return group.rows[group.leadIndex] ?? group.rows[0]!;
}

/**
 * The row's state, as labels rather than as icons: what the bot's `rowState` said in words.
 * Returns `undefined` when there is nothing to say, so the row keeps one line.
 */
function rowPills(row: TaskListRow, t: Translator): ReactNode | undefined {
  const pills: ReactNode[] = [];

  if (row.overdue)
    pills.push(
      <Pill key="overdue" tone="danger">
        {t("task.overdue")}
      </Pill>,
    );
  if (row.importance === "critical")
    pills.push(
      <Pill key="importance" tone="danger">
        {t("task.importance_critical")}
      </Pill>,
    );
  else if (row.importance === "required") pills.push(<Pill key="importance">{t("task.importance_required")}</Pill>);
  if (row.occurrenceStatus === "in_progress")
    pills.push(
      <Pill key="status" tone="accent">
        {t("state.started")}
      </Pill>,
    );
  if (row.occurrenceStatus === "skipped") pills.push(<Pill key="status">{t("state.skipped")}</Pill>);
  if (row.occurrenceStatus === "cancelled") pills.push(<Pill key="status">{t("state.cancelled")}</Pill>);
  if (row.completedLate) pills.push(<Pill key="late">{t("task.completed_late")}</Pill>);
  if (row.recurrenceRule) pills.push(<Pill key="repeat">{t("recurrence.label")}</Pill>);

  if (pills.length === 0) return undefined;
  return <Inline>{pills}</Inline>;
}
