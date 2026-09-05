import { useState, type ReactNode } from "react";
import type { GoalDetail, GoalStatus, TaskListRow } from "../../api/contracts.js";
import { useTimezone, useTodayLocalDate, type RouteOf } from "../../app/index.js";
import { useT, type CopyKey } from "../../i18n/index.js";
import { formatInstantTime, formatLocalDate, instantToLocalDate, useMutation, useQuery } from "../../lib/index.js";
import {
  AsyncContent,
  Card,
  ConfirmSheet,
  ConflictNotice,
  Field,
  Inline,
  ListRow,
  Pill,
  Screen,
  ScreenHeader,
  Section,
  SegmentedControl,
  Sheet,
  Stack,
  useToast,
  useUndo,
  type Option,
} from "../../ui/index.js";

/**
 * One goal, and the tasks attached to it.
 *
 * The bot's goal card could only list the tasks and say «напиши обычным сообщением» to change
 * anything: linking a task meant naming it in words, and unlinking meant asking. Both are one tap
 * here, and both carry the two versions the domain needs — the goal's and the task's — so a link
 * made while the same goal was edited in the chat fails as a conflict instead of overwriting.
 */

const STATUS_KEYS: Record<GoalStatus, CopyKey> = {
  active: "goals.status_active",
  paused: "goals.status_paused",
  completed: "goals.status_completed",
  cancelled: "goals.status_cancelled",
};

export function GoalScreen({ route }: { route: RouteOf<"goal"> }): ReactNode {
  const t = useT();
  const goal = useQuery("goal", { params: { id: route.id } });

  return (
    <Screen header={<ScreenHeader title={goal.data?.goal.title ?? t("goals.title")} />}>
      <AsyncContent query={goal}>{(data) => <GoalBody detail={data} reload={() => void goal.refetch()} />}</AsyncContent>
    </Screen>
  );
}

function GoalBody({ detail, reload }: { detail: GoalDetail; reload: () => void }): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();
  const todayLocalDate = useTodayLocalDate();
  const timezone = useTimezone();
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<{ taskId: string; title: string } | null>(null);

  const goal = detail.goal;
  const invalidate = ["goal", "goals", "task", "taskList", "today"] as const;

  const update = useMutation("updateGoal", {
    invalidate,
    onSuccess: (data) => undo.offer(t("common.saved"), data.undoGroupId, ["goal", "goals"]),
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const unlink = useMutation("unlinkGoal", {
    invalidate,
    onSuccess: (data) => {
      setUnlinking(null);
      undo.offer(t("goals.unlinked_toast"), data.undoGroupId, ["goal", "goals", "task"]);
    },
    onError: () => {
      setUnlinking(null);
      toast.show(t("state.failed_toast"), { tone: "error" });
    },
  });

  /**
   * `reviewEnabled` and `clear` are always null here, and that is not an oversight: the goal action
   * has no slot for either — `update_goal`'s patch is title, why, target date and status — so the
   * server refuses both by name rather than answering 200 to a change it cannot make. The switch
   * this screen used to draw for the review flag reported «сохранено» and moved nothing.
   */
  const patch = (change: { status?: GoalStatus }): void => {
    void update.mutate({
      params: { id: goal.id },
      body: {
        expectedVersion: goal.version,
        title: null,
        why: null,
        targetLocalDate: null,
        status: change.status ?? null,
        reviewEnabled: null,
        clear: null,
      },
    });
  };

  const statusOptions: readonly Option<GoalStatus>[] = (["active", "paused", "completed"] as const).map((status) => ({ value: status, label: t(STATUS_KEYS[status]) }));
  const conflict = update.conflict ?? unlink.conflict;

  return (
    <>
      {conflict ? (
        <ConflictNotice
          onReload={() => {
            update.reset();
            unlink.reset();
            reload();
          }}
        />
      ) : null}

      <Card>
        <Stack gap={2}>
          <Inline>
            <Pill tone={goal.status === "active" ? "accent" : "neutral"}>{t(STATUS_KEYS[goal.status])}</Pill>
            {goal.targetLocalDate ? <Pill>{t("goals.target", { date: formatLocalDate(goal.targetLocalDate, t.locale, { todayLocalDate }) })}</Pill> : null}
            {goal.idleDays !== null && goal.idleDays >= 7 ? <Pill tone="accent">{t("goals.idle", { days: goal.idleDays })}</Pill> : null}
          </Inline>
          {goal.why ? (
            <div>
              <div className="ip-small ip-muted">{t("goals.why")}</div>
              <div>{goal.why}</div>
            </div>
          ) : null}
          {goal.nextReviewAt ? (
            <div className="ip-small ip-muted">
              {t("goals.next_review", {
                when: `${formatLocalDate(instantToLocalDate(goal.nextReviewAt, timezone), t.locale, { todayLocalDate })} ${formatInstantTime(goal.nextReviewAt, timezone, t.locale)}`,
              })}
            </div>
          ) : null}
        </Stack>
      </Card>

      <Section>
        <div className="ip-row">
          <div className="ip-row__main">
            <Field>
              <SegmentedControl value={goal.status === "cancelled" ? "active" : goal.status} options={statusOptions} onChange={(status) => patch({ status })} />
            </Field>
          </div>
        </div>
        {/* Shown, not offered: nothing in the product writes `review_enabled`, and a switch that
            answers «сохранено» without moving the row is worse than a line that states the state. */}
        <ListRow title={t(goal.reviewEnabled ? "goals.review_on" : "goals.review_off")} muted />
      </Section>

      <Section title={t("goals.tasks")}>
        {detail.tasks.length === 0 ? <ListRow title={t("goals.no_tasks")} muted /> : null}
        {detail.tasks.map((task) => (
          <ListRow
            key={task.taskId}
            title={task.title}
            subtitle={task.detail ?? undefined}
            meta={
              <>
                {task.overdue ? <Pill tone="danger">{t("task.overdue")}</Pill> : null}
                {task.dueLocalDate ? <span className="ip-small ip-muted">{formatLocalDate(task.dueLocalDate, t.locale, { todayLocalDate })}</span> : null}
              </>
            }
            to={{ name: "task", id: task.occurrenceId ?? task.taskId }}
            chevron
          />
        ))}
        <ListRow title={t("goals.link_task")} onClick={() => setLinking(true)} muted chevron />
      </Section>

      <ConfirmSheet
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        onConfirm={() => {
          if (unlinking) void unlink.mutate({ params: { id: goal.id, taskId: unlinking.taskId } });
        }}
        title={t("goals.unlink_task")}
        description={unlinking?.title}
        confirmLabel={t("goals.unlink_task")}
        destructive
        pending={unlink.isPending}
      />

      <LinkTaskSheet
        open={linking}
        onClose={() => setLinking(false)}
        detail={detail}
        onLinked={reload}
        onUnlink={(taskId, title) => {
          setLinking(false);
          setUnlinking({ taskId, title });
        }}
      />
    </>
  );
}

/**
 * Attaching and detaching, in one place.
 *
 * It reads the `all` scope of the task list — the one filter that includes undated and fuzzy work,
 * which is exactly the kind of task a goal collects — and lists what is already linked above it, so
 * the two halves of one decision are not on two screens.
 */
function LinkTaskSheet({
  open,
  onClose,
  detail,
  onLinked,
  onUnlink,
}: {
  open: boolean;
  onClose: () => void;
  detail: GoalDetail;
  onLinked: () => void;
  onUnlink: (taskId: string, title: string) => void;
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const undo = useUndo();
  const tasks = useQuery("taskList", { query: { scope: "all", page: 0 } }, { enabled: open });

  const link = useMutation("linkGoal", {
    invalidate: ["goal", "goals", "task", "taskList"],
    onSuccess: (data) => {
      undo.offer(t("goals.linked_toast"), data.undoGroupId, ["goal", "goals", "task"]);
      onLinked();
      onClose();
    },
    onError: () => toast.show(t("state.failed_toast"), { tone: "error" }),
  });

  const linked = new Set(detail.tasks.map((task) => task.taskId));
  // One task can hold several dates, and each is its own row: the picker offers the task once.
  const candidates: TaskListRow[] = [];
  const seen = new Set<string>();
  for (const group of tasks.data?.groups ?? []) {
    for (const row of group.rows) {
      if (linked.has(row.taskId) || seen.has(row.taskId)) continue;
      seen.add(row.taskId);
      candidates.push(row);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t("goals.link_task")}>
      {detail.tasks.length > 0 ? (
        <div className="ip-row-group">
          {detail.tasks.map((task) => (
            <ListRow key={task.taskId} title={task.title} meta={t("goals.unlink_task")} onClick={() => onUnlink(task.taskId, task.title)} />
          ))}
        </div>
      ) : null}
      {candidates.length === 0 ? <p className="ip-muted">{t("common.nothing_here")}</p> : null}
      <div className="ip-row-group">
        {candidates.map((row) => (
          <ListRow
            key={row.taskId}
            title={row.title}
            onClick={() =>
              void link.mutate({
                params: { id: detail.goal.id },
                body: { taskId: row.taskId, expectedGoalVersion: detail.goal.version, expectedTaskVersion: row.taskVersion },
              })
            }
          />
        ))}
      </div>
    </Sheet>
  );
}
