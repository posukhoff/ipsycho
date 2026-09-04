-- The four numbers from docs/AGENT_FLOW.md §10, over the last seven days.
-- Run with: docker compose exec -T postgres psql -U ipsycho -d ipsycho -f - < scripts/agent-metrics.sql

\echo '-- provider calls per user message (target <= 1.1)'
select
  round(coalesce(sum(u.attempts), 0)::numeric / nullif(count(distinct m.id), 0), 3) as calls_per_message,
  count(distinct m.id) as user_messages
from messages m
left join ai_usage u on u.user_id = m.user_id and u.created_at between m.created_at and m.created_at + interval '2 minutes'
where m.role = 'user' and m.created_at > now() - interval '7 days';

\echo '-- mean prompt size (target <= 5000 tokens)'
select round(avg(input_tokens))::int as mean_input_tokens, round(avg(cached_input_tokens))::int as mean_cached_tokens, round(sum(estimated_cost_usd), 4) as usd
from ai_usage
where created_at > now() - interval '7 days';

\echo '-- share of user messages that ended in an applied or pending action (target >= 0.9)'
select round(count(*) filter (where g.id is not null)::numeric / nullif(count(*), 0), 3) as settled_share, count(*) as messages
from messages m
left join action_groups g on g.source_message_id = m.id and g.status in ('applied', 'pending')
where m.role = 'user' and m.created_at > now() - interval '7 days';

\echo '-- undo within 60 seconds of apply (target <= 1 in 30)'
select
  count(*) filter (where e.created_at is not null and e.created_at - g.applied_at < interval '60 seconds') as undone_fast,
  count(*) as applied_groups
from action_groups g
left join action_events e on e.group_id = g.id and e.action_type = 'undo'
where g.applied_at > now() - interval '7 days';

\echo '-- deliveries that could not be confirmed'
select status, count(*)::int from reminder_deliveries where scheduled_for > now() - interval '7 days' group by status order by 2 desc;
