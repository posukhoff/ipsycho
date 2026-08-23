-- Одноразовая правка прод-данных, 2026-08-23, user 4bcf5183.
-- 22.08 «поставить еженедельный отчёт на вечер пятницы в 23:00» бот превратил в повторяющуюся задачу
-- «Еженедельный отчёт» (пт 23:00) вместо настройки еженедельного обзора (был вс 20:00).
-- Повторяет логику change_series cancel: задача и незакрытые occurrences -> cancelled, их pending-доставки -> superseded,
-- событие series:cancel. Сводки пересобираются планировщиком из user_settings, отдельной правки briefing_deliveries не нужно.
-- Все изменения защищены условиями на текущее состояние; повторный запуск ничего не меняет.
--
-- Запуск на VPS:
--   cd /opt/ipsycho && docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 < scripts/fix-weekly-review-task-2026-08-23.sql
begin;

update reminder_deliveries set status = 'cancelled', suppressed_reason = 'superseded'
 where task_id = '72b9c5ba-196e-42a0-b949-c664d0540dd5' and status in ('pending', 'processing');

update task_occurrences set status = 'cancelled', skip_reason = 'series_cancelled', version = version + 1, updated_at = now()
 where task_id = '72b9c5ba-196e-42a0-b949-c664d0540dd5' and status in ('scheduled', 'open', 'in_progress');

update tasks set status = 'cancelled', version = version + 1, updated_at = now()
 where id = '72b9c5ba-196e-42a0-b949-c664d0540dd5' and version = 1 and status = 'active';

insert into task_events (workspace_id, task_id, actor_user_id, event_type)
select '2c8cb3bc-8060-4763-990b-0d9545564896', '72b9c5ba-196e-42a0-b949-c664d0540dd5', '4bcf5183-b121-427e-b4a8-7853ad9ef6c1', 'series:cancel'
 where not exists (
   select 1 from task_events where task_id = '72b9c5ba-196e-42a0-b949-c664d0540dd5' and event_type = 'series:cancel'
 );

-- Еженедельный обзор: вс 20:00 -> пт 23:00 (как setWeekly: weekday 1=пн..7=вс, digest_timezone = timezone)
update user_settings set weekly_review_enabled = true, weekly_review_weekday = 5, weekly_review_time = '23:00',
       digest_timezone = timezone, version = version + 1, updated_at = now()
 where user_id = '4bcf5183-b121-427e-b4a8-7853ad9ef6c1' and version = 1 and weekly_review_weekday = 7 and weekly_review_time = '20:00';

commit;

-- Контроль: задача cancelled, открытых occurrences и pending-доставок нет, обзор пт 23:00
select status, version from tasks where id = '72b9c5ba-196e-42a0-b949-c664d0540dd5';
select status, skip_reason, count(*) from task_occurrences where task_id = '72b9c5ba-196e-42a0-b949-c664d0540dd5' group by 1, 2;
select status, count(*) from reminder_deliveries where task_id = '72b9c5ba-196e-42a0-b949-c664d0540dd5' group by 1;
select weekly_review_enabled, weekly_review_weekday, weekly_review_time, version from user_settings where user_id = '4bcf5183-b121-427e-b4a8-7853ad9ef6c1';
