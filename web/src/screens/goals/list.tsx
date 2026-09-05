import { type ReactNode } from "react";
import type { GoalRow, GoalScope } from "../../api/contracts.js";
import { useNavigate, useTodayLocalDate, type RouteOf } from "../../app/index.js";
import { useT, type CopyKey, type Translator } from "../../i18n/index.js";
import { formatLocalDate, useInfiniteQuery, useQuery } from "../../lib/index.js";
import { EmptyState, ErrorState, InfiniteSentinel, ListRow, Pill, Screen, ScreenHeader, Section, SkeletonList, Tabs, type TabItem } from "../../ui/index.js";

/**
 * The goals list.
 *
 * It stays a list of goals, not a list of tasks under goals — the same split `goalsOverviewText`
 * makes, and for the reason written next to it: printing four tasks under each of eight goals made
 * that the longest message the bot sends and buried the goals themselves. A row says how much is
 * planned; the tasks live on the goal's own screen.
 *
 * The one number the bot computed and never showed here is `idleDays`: `idleGoals` decides which
 * goal the weekly card raises, and the list marks the same goal rather than making the user wait
 * for Sunday to find out.
 */

const SCOPES: readonly GoalScope[] = ["active", "paused", "completed"];

const SCOPE_KEYS: Record<GoalScope, CopyKey> = {
  active: "goals.scope_active",
  paused: "goals.scope_paused",
  completed: "goals.scope_completed",
};

export function GoalsScreen({ route }: { route: RouteOf<"goals"> }): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const todayLocalDate = useTodayLocalDate();

  const query = { scope: route.scope };
  const head = useQuery("goals", { query: { ...query, page: 0 } });
  const list = useInfiniteQuery("goals", { query, items: (data) => data.goals });

  const counts = head.data?.counts;
  const tabs: readonly TabItem<GoalScope>[] = SCOPES.map((scope) => ({ value: scope, label: t(SCOPE_KEYS[scope]), count: counts?.[scope] }));

  return (
    <Screen header={<ScreenHeader title={t("goals.title")} />}>
      <Tabs value={route.scope} items={tabs} onChange={(scope) => navigate.replace({ name: "goals", scope })} />

      {list.isLoading ? <SkeletonList /> : null}
      {!list.isLoading && list.items.length === 0 && list.error !== undefined ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}
      {!list.isLoading && list.items.length === 0 && list.error === undefined ? <EmptyState icon="🎯" title={t("goals.empty")} /> : null}

      {list.items.length > 0 ? (
        <Section>
          {list.items.map((goal) => (
            <GoalRowLine key={goal.id} goal={goal} todayLocalDate={todayLocalDate} t={t} />
          ))}
        </Section>
      ) : null}

      <InfiniteSentinel hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} label={t("tasks.load_more")} />
    </Screen>
  );
}

function GoalRowLine({ goal, todayLocalDate, t }: { goal: GoalRow; todayLocalDate: string; t: Translator }): ReactNode {
  const subtitle = [
    goal.taskCount > 0 ? t.plural(goal.taskCount, "task") : t("goals.no_tasks"),
    goal.targetLocalDate ? t("goals.target", { date: formatLocalDate(goal.targetLocalDate, t.locale, { todayLocalDate }) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ListRow
      title={goal.title}
      subtitle={subtitle}
      meta={goal.idleDays !== null && goal.idleDays >= 7 ? <Pill tone="accent">{t("goals.idle", { days: goal.idleDays })}</Pill> : null}
      to={{ name: "goal", id: goal.id }}
      chevron
    />
  );
}
