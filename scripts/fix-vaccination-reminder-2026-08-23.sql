-- Одноразовая правка прод-данных, 2026-08-23, user 4bcf5183.
-- Напоминание «Прийти на вакцинацию собаки сегодня»: 18:00 -> 17:30 Kyiv (бот пообещал 17:30, записал 18:00).
-- Повторяет логику rebuildOccurrence: правило -> explicit/-30 мин, старая доставка -> superseded, новая -> 14:30 UTC.
-- Очередь (pg-boss) подхватит новую pending-доставку за 2 минуты до срока; старая джоба на 15:00 UTC отработает вхолостую.
-- Все изменения защищены условиями на текущее состояние; повторный запуск ничего не меняет.
--
-- Запуск на VPS:
--   cd /opt/ipsycho && docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < scripts/fix-vaccination-reminder-2026-08-23.sql
begin;

update reminder_rules set offset_seconds = -1800, origin = 'explicit'
 where id = 'c0a1193f-48e2-4860-b898-60665ae70e73' and offset_seconds = 0;

update reminder_deliveries set status = 'cancelled', suppressed_reason = 'superseded'
 where id = 'a0f0f6ed-b825-4d8b-8d17-b2e05f7cff85' and status = 'pending';

insert into reminder_deliveries (id, workspace_id, recipient_user_id, reminder_rule_id, task_id, occurrence_id, intended_for, scheduled_for, status, deduplication_key)
select gen_random_uuid(), '2c8cb3bc-8060-4763-990b-0d9545564896', '4bcf5183-b121-427e-b4a8-7853ad9ef6c1',
       'c0a1193f-48e2-4860-b898-60665ae70e73', '257cefd1-eea7-4e49-920f-5299c3e533d2', 'b5c88093-0cab-4ba7-bea7-79aecec6b8f5',
       '2026-08-23T14:30:00Z', '2026-08-23T14:30:00Z', 'pending',
       'c0a1193f-48e2-4860-b898-60665ae70e73:b5c88093-0cab-4ba7-bea7-79aecec6b8f5:v1:2026-08-23T14:30:00.000Z'
 where not exists (
   select 1 from reminder_deliveries
    where deduplication_key = 'c0a1193f-48e2-4860-b898-60665ae70e73:b5c88093-0cab-4ba7-bea7-79aecec6b8f5:v1:2026-08-23T14:30:00.000Z'
 );

-- why осталось от прежнего названия («записаться»), задача уже «прийти»
update tasks set why = 'Плановая вакцинация собаки по записи.', version = version + 1, updated_at = now()
 where id = '257cefd1-eea7-4e49-920f-5299c3e533d2' and version = 4;

insert into task_events (workspace_id, task_id, actor_user_id, event_type)
values ('2c8cb3bc-8060-4763-990b-0d9545564896', '257cefd1-eea7-4e49-920f-5299c3e533d2', '4bcf5183-b121-427e-b4a8-7853ad9ef6c1', 'reminder:changed');

commit;

-- Контроль: ожидается cancelled/superseded на 18:00 и pending на 17:30
select status, scheduled_for at time zone 'Europe/Kyiv' as kyiv, suppressed_reason
  from reminder_deliveries where task_id = '257cefd1-eea7-4e49-920f-5299c3e533d2' order by created_at;
select title, why, version from tasks where id = '257cefd1-eea7-4e49-920f-5299c3e533d2';
