# План улучшений IPsycho

Дата аудита: 2026-09-04, ветка `agent-flow-v2` (`5a7f379`). Проверено: `npm run check` зелёный (178 core + 140 app тестов). Аудит покрыл архитектуру, AI-агента, производительность/надёжность, Telegram UX, тесты/CI/ops. Каждая находка ниже привязана к `file:line` на момент аудита; строки могут сдвинуться, ориентируйся на имена функций.

## 0. Как работать по этому плану

- Один пункт (`Pn.m`) = одна ветка от `agent-flow-v2` (или от `main` после её слияния), один PR, один осмысленный коммит. Не объединяй пункты из разных фаз в один PR.
- Перед началом пункта прочитай указанные файлы целиком, не только цитируемые строки.
- После каждого пункта: `npm run check`. Если пункт трогает SQL, репозитории, миграции или транзакции: ещё `npm run test:e2e` (нужен Docker).
- Новая миграция = новый номер `00NN_*.sql`; существующие миграции не редактировать.
- `.env` не читать и не менять. Конфигурация только через `.env.example` и `src/config.ts`.
- Соблюдай инварианты из `AGENTS.md`: workspace-изоляция, консент на границе провайдера, мутация + журнал в одной транзакции, логи без текста сообщений.
- Если пункт меняет поведение для пользователя или оператора, обнови `README.md` / `MANUAL_ACTIONS.md` / `docs/DEPLOYMENT.md` в том же PR.
- Порядок фаз обязателен для фаз 0 и 1. Внутри остальных фаз пункты независимы, если не указано «после Pn.m».
- Каждый пункт имеет критерий приёмки. Пункт не закрыт, пока критерий не выполнен и не проверен тестом или командой.

## 1. Что сохранить (это работает хорошо)

- `src/core/` чистый: не импортирует ничего снаружи, тестируется отдельно. Не ломать.
- Транзакционная модель действий: один `action_group` + журнал + блокировки `FOR UPDATE ORDER BY id` в одной транзакции, внешних вызовов внутри транзакций нет.
- Контракт агента v2 (`src/core/ai-contract.ts`): 9 действий, короткие id `t1/g2/m3`, один `intent`, риск считает сервер.
- `src/chat/turn-errors.ts`: 39 кодов ошибок × 3 языка, каждый говорит, что пользователь может изменить.
- `src/core/applied-report.ts`: отчёт только по реально сохранённому, с датой до/после.
- `src/core/card-details.ts`: фильтрует поля модели, которые пересказывают заголовок.
- Логи через `safeError`/`safeMessageMetadata`: тела сообщений только как длина + sha256.
- Никакого `parse_mode` в Telegram: класс ошибок экранирования отсутствует.
- `callback_data` всегда ≤ 64 байт, uuid проверяется регэкспом.
- `scripts/backup-compose.sh`: атомарная публикация, проверка расшифровкой перед публикацией.

---

## Фаза 0. Разблокировать CI и деплой (полдня)

Сейчас `docker build` на этой ветке падает, значит CI красный, значит `deploy.yml` никогда не запустится.

### P0.1 Починить Dockerfile
- `Dockerfile:19` копирует `scripts/qa-complex-planning.mjs`, удалённый в `797c30f`.
- Сделать: удалить строку (QA-скрипт не нужен в production-образе). Если нужен в образе, заменить на `scripts/qa-agent-flow.mjs`.
- Приёмка: `docker build -t ipsycho:local .` проходит.

### P0.2 Сборка чистит dist, test:app собирает
- `package.json`: `"build": "rm -rf dist && tsc -p tsconfig.json"`, `"test:app": "npm run build && node --test tests/app/*.test.mjs"`.
- Причина: в `dist/core/` лежат 5 сирот от удалённых исходников; тесты импортируют из `dist/` 41 раз и могут проходить на несуществующем коде.
- Приёмка: `ls dist/core | grep -E 'task-batch|goal-focus|profile-onboarding|digest-input|relative-reminder'` пусто после `npm run build`.

### P0.3 Версии Node и типов
- `@types/node` 22.0.0 при `engines.node >=24`: поднять до `^24`.
- Добавить `.nvmrc` (`24`), `.npmrc` (`engine-strict=true`), `.editorconfig`.
- Приёмка: `npm run check` зелёный на Node 24.

### P0.4 e2e в CI
- `.github/workflows/ci.yml`: добавить job `e2e` с service-контейнером `postgres:17-alpine` (порт 5433, БД/пользователь/пароль как в `docker-compose.e2e.yml`), шаги `npm ci`, `npm run migrate`, `npm run build`, `node --test tests/e2e/*.test.mjs` с `DATABASE_URL`/`TEST_DATABASE_URL`.
- `scripts/test-e2e.sh`: подъём compose и `trap cleanup` только если `TEST_DATABASE_URL` не задан.
- Приёмка: e2e job зелёный в CI; локальный `npm run test:e2e` по-прежнему работает.

### P0.5 Аудит зависимостей в CI
- В job `verify` добавить `npm audit --omit=dev --audit-level=high`.
- Добавить `.github/dependabot.yml` (npm + github-actions, weekly).
- Поднять patch/minor: `zod`, `grammy`, `openai`, `pg-boss`, `tsx`. Мажоры (`@nestjs/*` 12, `typescript` 7, `dotenv` 17) отдельным PR позже.
- Приёмка: `npm audit --omit=dev` без high/critical; `npm run check` зелёный.

### P0.6 Docker cache и concurrency в CI
- `ci.yml`: `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`; сборку образа через `docker/build-push-action@v6` с `cache-from/cache-to: type=gha`.
- Приёмка: повторный прогон CI быстрее первого.

---

## Фаза 1. Критичные дефекты надёжности (1–2 недели)

### P1.1 Дубли напоминаний из-за гонки на старте
- `src/reminders/reminder-queue.service.ts:45` запускает `boss.work` до сброса `processing → pending` (`:50-52`). Задача, взятая в этот промежуток, отправляется, а её строка возвращается в `pending` и отправляется снова. То же `src/briefings/briefing-queue.service.ts:34-35`.
- Сделать: сброс и `enqueuePending()` до `boss.work`.
- Приёмка: unit-тест с фейковым boss, где `work` вызывается после сброса; e2e зелёный.

### P1.2 `singletonKey` не работает
- `createQueue(QUEUE)` без опций даёт policy `standard`, при которой dedup-индексы pg-boss не действуют (`pg-boss/dist/plans.js:635-655`). Каждая реконсиляция создаёт новый job.
- Сделать: `createQueue(QUEUE, { policy: "short", notify: true, expireInSeconds: 120 })`. Policy неизменяема после создания: добавить миграцию или boot-шаг, который удаляет очереди `reminder-delivery`/`briefing-delivery` из `pgboss.queue` перед пересозданием.
- Приёмка: два `enqueue` с одним `singletonKey` дают одну строку в `pgboss.job` (e2e).

### P1.3 Таймауты на все вызовы AI и загрузку голоса
- `src/ai/openai.provider.ts:13`, `gemini.provider.ts:16`, `deepseek.provider.ts:31`, `src/ai/transcription.service.ts:13`: SDK по умолчанию ждёт 600 с. Добавить `timeout: 45_000`.
- `src/telegram/telegram-conversation-handlers.service.ts:62`: `fetch` без дедлайна. Добавить `signal: AbortSignal.timeout(20_000)`.
- Приёмка: тест провайдера с зависшим fetch завершается ошибкой за ≤ 45 с.

### P1.4 Параллельная обработка Telegram-обновлений
- `src/telegram/telegram.service.ts:163` `bot.start()` обрабатывает обновления строго последовательно для всех чатов. Один вызов модели блокирует всех.
- Сделать: `@grammyjs/runner` с `sequentialize((ctx) => ctx.chat?.id)`; `run(bot)`; корректный `stop` в `onApplicationShutdown`. Добавить `allowed_updates: ["message", "callback_query"]`.
- Приёмка: app-тест: два обновления из разных чатов обрабатываются параллельно, из одного чата последовательно.

### P1.5 Обработка 429 и неоднозначных исходов Telegram
- Нет обработки `retry_after`; `reminder-queue.service.ts:204-227` при любой ошибке возвращает строку в `pending` и ретраит, включая таймаут ответа на уже доставленное сообщение.
- Сделать: `bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }))` из `@grammyjs/auto-retry`; в очереди различать 429 (ретрай без потери попытки), 4xx (suppress с причиной), сетевой таймаут после отправки (`status = 'ambiguous'`, не ретраить автоматически, показать в `/status`).
- Приёмка: unit-тесты трёх веток.

### P1.6 Undeliverable-строки не ретраятся вечно
- `reminder-queue.service.ts:103-125`: если join по `users/workspace_members/tasks/reminder_rules/user_settings` пуст, `return` оставляет `pending`, реконсилер ставит job каждую минуту навсегда.
- Сделать: `suppress(deliveryId, "orphaned")`.
- Приёмка: e2e: удалённая задача не оставляет pending-доставок после реконсиляции.

### P1.7 Слушатели ошибок пула и advisory-lock
- `src/database/database.service.ts:13`: `Pool` без `on("error")`; обрыв idle-соединения роняет процесс.
- `src/runtime/single-instance.service.ts:20`: клиент без `on("error")`, лок никогда не перепроверяется.
- Сделать: `pool.on("error", ...)` с `safeError`; для лока: `client.on("error")` + keepalive каждые 30 с (`SELECT pg_try_advisory_lock(...)`), при потере лока завершить процесс с кодом 1.
- Приёмка: unit-тест на keepalive с фейковым клиентом.

### P1.8 Индексы
- Новая миграция `0024_indexes.sql` (все `CREATE INDEX CONCURRENTLY` нельзя в транзакции; `migrate.ts` оборачивает файл в транзакцию, поэтому либо использовать обычный `CREATE INDEX`, либо добавить в `migrate.ts` поддержку маркера `-- no-transaction`):
  - `task_events(workspace_id, occurrence_id, event_type, created_at)`; `task_events(workspace_id, task_id, created_at)`; partial `task_events(event_type, created_at) WHERE occurrence_id IS NOT NULL`; partial `task_events(created_at) WHERE details IS NOT NULL`.
  - `reminder_rules(workspace_id, task_id) WHERE active`; `reminder_rules(workspace_id, occurrence_id) WHERE active`.
  - `reminder_deliveries(workspace_id, occurrence_id) WHERE status IN ('pending','processing')`; `reminder_deliveries(workspace_id, reminder_rule_id) WHERE status IN ('pending','processing')`; `reminder_deliveries(recipient_user_id, status, scheduled_for)`; `reminder_deliveries(workspace_id, task_id)`.
  - `messages(user_id, role, created_at DESC)`; `messages(workspace_id, pending_group_id)`.
  - `pending_actions(expires_at)`.
  - GIN `tasks USING GIN (to_tsvector('simple', title || ' ' || coalesce(context, '')))` (выражение должно байт-в-байт совпадать с тем, что генерирует Drizzle в `tasks.repository.ts:42-48`; после P1.9 согласовать).
  - partial `task_occurrences(status) WHERE status IN ('scheduled','open','in_progress')`; partial `tasks(status) WHERE recurrence_rule IS NOT NULL`.
  - Удалить `task_recurrence_exclusions_task_idx` (дублирует PK).
- Обновить `src/database/schema.ts` теми же индексами.
- Приёмка: `EXPLAIN` для запросов из `context.repository.ts:282-304` и `tasks.repository.ts:393-398` показывает Index Scan (проверить в e2e через `EXPLAIN (FORMAT JSON)` или вручную и записать в PR).

### P1.9 Полнотекстовый поиск фактически не работает
- `src/context/context.repository.ts:198` и `src/tasks/tasks.repository.ts:43`: `websearch_to_tsquery('simple', <всё сообщение>)` объединяет все слова через AND без стемминга. Проверено: `'Забрать посылку' @@ 'посылка'` → false. Память типов note/decision/preference никогда не возвращается модели; спасательный путь при >60 задач мёртв.
- Сделать: токенизировать сообщение, убрать стоп-слова (ru/uk/en), построить `to_tsquery('simple', 'a | b | c')` с `ts_rank` и порогом; добавить `pg_trgm` (`CREATE EXTENSION IF NOT EXISTS pg_trgm`) и fallback `similarity(title, term) > 0.3`. Вынести построение запроса в `src/core/search-query.ts` с unit-тестами.
- Приёмка: core-тесты на токенизацию; e2e: память «Пью таблетки от давления» находится по «напомни про таблетки».

### P1.10 Ограничить выборку задач для контекста
- `src/tasks/tasks.repository.ts:32-36` `SELECT *` без LIMIT, затем `tasks.service.ts:285-295` грузит occurrences и чеклисты для всех id.
- Сделать: `.orderBy(desc(updatedAt)).limit(300)`; occurrences/чеклисты только для id, прошедших отбор в `core/turn-context.ts:173-232`. Порядок отбора: N просроченных + M ближайших будущих + FTS-совпадения (сейчас сортировка по anchor asc выталкивает будущие).
- Приёмка: core-тест на отбор с 100 задачами: будущие задачи этой недели попадают в контекст.

### P1.11 Ретраи Telegram-отправки в AI-retry без обрезки
- `src/chat/ai-retry.service.ts:47-55` шлёт `text + report` без `compactText`; при >4096 символов `sendMessage` падает, ошибка глотается, сообщение уже помечено `processed`.
- Сделать: `TelegramChatReplyService.replyTo(telegramUserId, access, result)` как общий рендерер (вынести из `reply()`), использовать в `AiRetryService`; удалить локальный `actionSummary` в `ai-retry.service.ts:74-78`.
- Приёмка: app-тест: ретрай с ответом 5000 символов отправляет ≤ 3900.

---

## Фаза 2. Корректность контракта и агента (1–2 недели)

### P2.1 Кнопки идут через журнал действий и получают Undo
- `src/telegram/telegram-handlers.service.ts:923-940`: `occ:done|skip|cancel|start` вызывают `tasks.setOccurrenceStatus` напрямую, минуя `ActionsService`. Нет `action_group`, нет Undo, пустая клавиатура после. Нарушает README («explicit reversible changes ... 24-hour Undo»). `:896,903` (`recordInteraction`), `:1113` (`recordBlocker`) аналогично.
- Сделать: собрать `ResolvedAction` `set_task_state` и вызвать `actions.applyResolved`, как уже делает `applyReschedule` (`:658-679`). `terminalTaskText` получает клавиатуру с `↩️ Вернуть как было`. Cancel/skip одноразовой задачи по кнопке требует подтверждения (таблица рисков §5 `AGENT_FLOW.md`), либо документировать, что кнопка = explicit и применяется с Undo.
- Приёмка: e2e: нажатие done создаёт `action_groups` строку и её можно откатить; app-тест на клавиатуру.

### P2.2 Единый путь изменения настроек
- Настройки меняются двумя независимыми реализациями: `src/settings/settings.service.ts:61-169` (команды) и `src/actions/action-describe.ts:97-125` `settingsPatchForAction` (агент). Уже расходятся: AI-путь не ставит `digestTimezone` для snooze/reminder_defaults, не вызывает `parseLocalTime`.
- Сделать: `settingsPatchForAction` возвращает типизированный `SettingsPatch` (сейчас `Record<string, unknown>`, `action-describe.ts:96`) и становится единственным построителем патча; `SettingsService` сеттеры вызывают его и применяют через `updateSettingsInTx` с журналом.
- Приёмка: app-тест: `/quiet` и `settings quiet_hours` из агента дают одинаковый патч.

### P2.3 Живая карточка не отменяется чужим действием
- `src/chat/chat.service.ts:452`: любое `explicit` действие отменяет открытую карточку подтверждения, даже не связанное. И отмена происходит до `handleProposed` (`:453-456` vs `:465-474`): при доменной ошибке пользователь теряет и карточку, и действие.
- Сделать: сравнивать resolved-действия с payload pending-группы (тип + target task id); отменять карточку только после успешного применения.
- Приёмка: app-тест: карточка «отменить созвон?» + «создай задачу купить молоко» → карточка жива, задача создана.

### P2.4 История диалога не зависит от topic
- `src/messages/messages.repository.ts:181`: `topicId ? eq(topicId) : isNull(topicId)`. При `topic.mode: "none"` (рекомендуется промптом для простых команд) модель теряет предыдущие 19 ходов.
- Сделать: выбирать последние N по времени независимо от `topic_id`; topic использовать только для summary.
- Приёмка: app-тест: после хода с `topic.mode: none` следующий ход видит предыдущие сообщения.

### P2.5 Вопрос модели не обрезается
- `chat.service.ts:706` `renderTurn` склеивает `reply + question`, потом `compactText(600)` режет хвост, то есть вопрос.
- Сделать: бюджет `reply = max - question.length - 2`, вопрос не трогать; в промпт (`ai.service.ts:182`) добавить «reply under 600 characters».
- Приёмка: app-тест: reply 590 символов + вопрос → вопрос в ответе целиком.

### P2.6 Убрать английский текст правил из ответов
- `src/chat/turn-errors.ts:228-237` `technicalHint` вставляет до 157 символов внутреннего сообщения: «Не сохранил: … (task plan could not be prepared)». `AGENT_FLOW.md` §9 требовал это удалить.
- Сделать: hint только в лог; пользователю «Не сохранил: не сработало одно из правил. Сформулируй задачу и время одной фразой.» на трёх языках.
- Приёмка: app-тест на `genericRejection` (проверка латиницы в ответе снята вместе с QA-скриптом).

### P2.7 Типизированная доменная ошибка вместо эвристики по длине
- `chat.service.ts:698-700` `isDomainRuleError` решает по `message.length < 200` и регэкспу, доменное это правило или сбой. ~40 `throw new Error(...)` в `action-mutations.repository.ts`, `context-actions.repository.ts`, `action-group.repository.ts`.
- Сделать: `class DomainRuleError extends Error { code }` в `src/core/errors.ts`; заменить все броски; `isDomainRuleError = instanceof`; таблицу `BY_MESSAGE` (`turn-errors.ts:210-220`) удалить, все коды в `BY_CODE`.
- Приёмка: grep `throw new Error(` в `src/actions`, `src/context` пуст; app-тест турн-ошибок зелёный.

### P2.8 Ссылки на задачу, созданную в том же сообщении
- Модель ссылается на `create_task` из того же пакета (`AGENT_FLOW.md` §9б, два оставшихся промаха: два reschedule сразу, связывание новой задачи с целью). Сейчас `ref_not_found` и весь пакет отклоняется.
- Сделать: `RefSchema` (`ai-contract.ts:15`) принимает `n1..n8` (n-й `create_task` в этом сообщении); резолвить во второй проход в `actions.service.ts:prepareSteps` после создания задач (link goal, set_reminder). Обновить промпт: одна строка про `nN`.
- Приёмка: app-тест «создай задачу X и свяжи с целью Y» → одна группа, два шага.

### P2.9 Few-shot примеры в промпт
- `src/ai/ai.service.ts:172`: 3 компактных примера input→JSON (два reschedule в одном массиве; `create_task` с `goal`; recurrence с `skipDates`) до `CURRENT_TIME`, чтобы попасть в кэшируемый префикс. Поднять бюджет в `tests/app/ai-prompt.test.mjs:102`. Исправить опечатку `,,` в `:174`.
- Приёмка: `npm run eval:agent -- --runs 3` (нужны ключи): 9/9 фраз §2.7 с первого вызова во всех трёх прогонах.

### P2.10 Параметры провайдеров
- `openai.provider.ts:29-36`, `gemini.provider.ts:33-40`, `deepseek.provider.ts:48-58`: нет `temperature`, нет `max_output_tokens`, не читается `cached_tokens`, `store` не выключен у Responses API, токены неудачной попытки repair не пишутся в `ai_usage`.
- Сделать: в `AiRequest` добавить `temperature`, `maxOutputTokens`; default-режим `0.2`/`1500`, deep `0.7`/`3000`; `store: false`; в `AiProviderResult` добавить `attempts`, `cachedInputTokens`; писать оба в `ai_usage` (миграция: две колонки); `AI_MAX_CALLS_PER_HOUR` считать по `attempts`.
- DeepSeek: `DEEPSEEK_JSON_INSTRUCTION` (`:7-23`) генерировать из `z.toJSONSchema(AiTurnSchema)` и передавать до `CURRENT_CONTEXT` (кэш по префиксу).
- Приёмка: app-тесты на параметры запроса и на запись `attempts`.

### P2.11 Бюджет контекста и дубль weekly-снапшота
- Нет байтового лимита: память 30×2000, цели 30, темы 3×2000, история 19×3900. `chat.service.ts:566-570` `withWeeklySnapshot` строит weekly-брифинг второй раз и кладёт в промпт второй копией (`turn-context.service.ts:98-100` уже кладёт).
- Сделать: удалить `withWeeklySnapshot`; `budgetContext(ctx, maxChars = 20_000)` в `turn-context.service.ts` с фиксированным порядком урезания: `topic.recent` → `memory.content` до 300 символов → история до N символов → строки задач.
- Приёмка: app-тест: контекст с переполненной памятью ≤ 20 000 символов; в промпте одна копия снапшота.

### P2.12 Детерминированное уточнение по названию задачи
- `action-resolver.ts:151-158` при `ref_not_found` отвечает «назови точнее». Сервер может предложить 2–5 кандидатов (fuzzy по `RefMap`), как уже делает `scope_required`.
- Сделать: кандидаты по trigram/Levenshtein к intended title (если модель его передала) или к последним упомянутым; `clarificationForCandidates` в `turn-errors.ts:240-247`.
- Приёмка: app-тест с двумя похожими задачами.

### P2.13 Конфиг: кросс-валидация и обязательные поля
- `src/config.ts:47-49`: `AI_PROVIDER=gemini` с одним `OPENAI_API_KEY` стартует и молча отвечает `ai_unavailable`. `TELEGRAM_BOT_TOKEN` optional в схеме, обязателен в `telegram.service.ts:19`.
- Сделать: `superRefine` провайдер↔ключ; токен обязателен; warning при старте, если `AI_PRICING_JSON` пуст при настроенном провайдере; `AI_MONTHLY_WARNING_USD` в конфиг и `.env.example` как дефолт для новых пользователей.
- Приёмка: unit-тесты `loadConfig` на три случая.

### P2.14 `ActionStateUncertainError` либо бросается, либо удаляется
- Определён в `actions.service.ts:53-58`, ловится в трёх местах, не бросается нигде.
- Сделать: бросать из `applyResolved` при ошибке после возможного коммита (сетевой сбой в `commit`); иначе удалить класс и три ветки.
- Приёмка: e2e с инъекцией ошибки на коммите либо grep класса пуст.

---

## Фаза 3. UX Telegram (2 недели)

### P3.1 Часовой пояс в онбординге
- `src/database/schema.ts:44-46` дефолт `Europe/Kyiv`; онбординг (`telegram-handlers.service.ts:145-163, 412-440`) не спрашивает пояс; `/timezone` нет в меню и `/help`.
- Сделать: первый шаг онбординга: «В каком ты часовом поясе? От этого зависит время сводок и разбор фраз вроде "завтра в 10". Напиши город или выбери ниже.» + кнопки `Europe/Kyiv`, `Europe/Berlin`, `Europe/Warsaw`, `Другой`. Добавить `/timezone` и `/language` в меню и `/help`. В конце онбординга показать карточку `settingsText`, а не одну фразу.
- Приёмка: app-тест последовательности онбординга; копия на трёх языках.

### P3.2 Консент не теряет первое сообщение
- `telegram-chat-reply.service.ts:20-24`, `telegram-handlers.service.ts:478`: после согласия «отправь ещё раз». Сообщение уже сохранено со статусом `blocked_consent`, `/retry_ai` существует.
- Сделать: консент как шаг онбординга (один грант на текст и голос); при гранте из чата автоматически переиграть последнее `blocked_consent` сообщение. При отказе: «AI выключен. Кнопки, напоминания и сводки работают; свободный текст разбирать не буду. Включить: напиши мне ещё раз.»
- Приёмка: app-тест: сообщение → карточка консента → «да» → ответ агента без повторной отправки.

### P3.3 Snooze напоминания без переноса задачи
- `telegram-ui.ts:159-165, 188-197`: `🕒 Позже` переносит occurrence и может спросить причину. Отложить само напоминание нельзя.
- Сделать: кнопка `⏰ Через 10 мин` / `⏰ Через час` на карточке напоминания создаёт новую `reminder_delivery` с `origin = snooze`, задачу не трогает.
- Приёмка: e2e: snooze создаёт доставку, occurrence не меняется.

### P3.4 Ловушка pendingInput
- После `🧱 Застрял` / `📅 Другая дата` следующее любое сообщение съедается (`telegram-handlers.service.ts:695-699, 904, 996`); `← Назад` (`:879-883`) не очищает pending; `/cancel` не в меню.
- Сделать: кнопка `✖️ Не сейчас` очищает pendingInput; `occ:back` очищает; `/cancel` в меню. По `AGENT_FLOW.md` §3: свободный текст после «перенести» идёт в модель с хинтом `пользователь нажал перенести у tN`, парсер только для кнопок с готовым выбором.
- Приёмка: app-тест: после «Застрял» сообщение «напомни завтра купить хлеб» уходит в модель, а не в blocker.

### P3.5 Тупики и мёртвые кнопки
- `/reminders` и `/goals` имеют одну кнопку `← Помощь` (`:524-534, 549-553, 1206-1217`). Реализованные, но недостижимые callback: `rem:cancel`, `prefs:*:toggle`, `nav:settings|reminders|goals`, `occ:seen`, `follow:seen`, `topic:continue|conclude`, `guide:help`, `system:ping`.
- Сделать: `/reminders` строки-кнопки с `rem:cancel`; `/goals` строки-кнопки; футер `☀️ Сегодня | 📋 Задачи` везде; `/settings` с тумблерами `prefs:*` и кнопкой назад. Неиспользуемые callback либо подключить, либо удалить с их обработчиками.
- Приёмка: app-тест: каждый зарегистрированный `callbackQuery` паттерн имеет хотя бы один генератор в `telegram-ui.ts`.

### P3.6 Единый гейт доступа и одинаковый отказ
- 49 ручных `resolveActiveUser`; 14 команд для чужого пользователя молчат (`:182,203,210,...`); три разных текста отказа (`:98,126,189`).
- Сделать: grammY middleware в `TelegramService.registerBaseMiddleware`: резолвит доступ один раз в `ctx.state.access`, чужим отвечает `registrationDeniedText(locale)` на любую команду/кнопку, `/start` с инвайтом пропускает. Обработчики читают `ctx.state.access`. Ветка `already_registered` в `registerFromInvite` получает свой текст.
- Приёмка: app-тест: неизвестный пользователь получает один и тот же отказ на `/help`, `/tasks`, кнопку.

### P3.7 Неподдерживаемые типы сообщений и группы
- Зарегистрированы только `message:text` и `message:voice`; фото/стикеры/документы/группы: тишина (`telegram.service.ts:31-34`).
- Сделать: fallback `bot.on("message")`: «Пока понимаю только текст и голосовые. Опиши словами, что нужно сделать.» Для группы один раз: «Я работаю только в личных сообщениях.»
- Приёмка: app-тесты на оба случая, три языка.

### P3.8 Карточка подтверждения называет цель
- `action-describe.ts:5-48`: «Связать задачу с целью» без имён, «Отменить» без задачи, «Изменить настройки: тихие часы» без значений.
- Сделать: во всех ветках подставлять title задачи/цели и новые значения: «Отменить «Созвон с Антоном» (25.08 11:00)», «Тихие часы → будни 23:00–08:00».
- Приёмка: обновить `tests/app/telegram-cards.test.mjs`.

### P3.9 Единые подписи Confirm/Undo, отчёт об откате, окно 24 ч
- Три подписи Undo (`telegram-chat-reply.service.ts:74-79`, `telegram.service.ts:96`, `telegram-handlers.service.ts:1187`); после Undo только toast, сообщение остаётся «Создана задача».
- Сделать: `Подтвердить` / `Не надо`; `↩️ Вернуть как было`; после Undo отредактировать сообщение: «↩️ Вернул как было: задача «Зарядка» удалена.»; в `/help` и guide указать 24 часа; текст `:846` → «Это изменение уже нельзя отменить: прошло больше суток или задача успела измениться.»
- Приёмка: `telegram-copy.test.mjs` обновлён.

### P3.10 Stale-карточки обновляются, не только toast
- Все ветки «устарело» дают 2-секундный toast и оставляют кнопки (`:646,652,846,872,943`).
- Сделать: при stale отредактировать сообщение в терминальное состояние или снять клавиатуру. При «нет» на карточке снять кнопки (`chat.service.ts:695`).
- Приёмка: app-тест на `act:confirm` для уже обработанной группы.

### P3.11 Тихие часы и эскалация объясняются
- Перенос/подавление в тихие часы молчаливые (`reminder-planning.ts:161-167`, `reminder-queue.service.ts:274-278`); критичная эскалация повторяет байт-в-байт без выхода (`:257-269`).
- Сделать: префикс «🔕 Было в тихие часы, показываю сейчас»; подавленные упомянуть в утренней сводке; эскалация: «🔴 Срок прошёл — 3-е напоминание» + кнопка `🔕 Хватит по этой задаче` (деактивирует rule).
- Приёмка: unit-тесты рендера; e2e на деактивацию.

### P3.12 Тексты ошибок для людей
- `:730,846` «сверено после восстановления» → «Не уверен, сохранилось ли изменение. Не повторяй пока — я проверю сам и напишу.»
- `chat-reply:18` провайдер недоступен → «AI сейчас недоступен. Сообщение сохранено — напиши /retry_ai, когда захочешь повторить.»
- `chat-reply:19` лимит → с числом и временем сброса: «Достигнут часовой лимит AI (60). Снова смогу после 14:35.»
- `conversation-handlers:48` лимиты голоса из конфига, не литералы «5 минут и 20 МБ».
- `:270` «Неизвестный IANA timezone» → «Не знаю такой часовой пояс. Напиши город, например «Берлин».»
- «Не найдены настройки пользователя.» в 7 местах → один текст через locale.
- Приёмка: `telegram-copy.test.mjs`.

### P3.13 Weekly review по запросу и понятное завершение
- Обзор запускается только кнопкой из воскресной сводки (`telegram-conversation-handlers.service.ts:124-159`).
- Сделать: `/weekly review` и кнопка в `/settings`; текст завершения по кнопке «Закончить планирование» не должен звучать как «ничего не сохранено» если план собран; в `/help` перечислить фразы-выходы («хватит вопросов», «ничего не сохраняй»).
- Приёмка: app-тест запуска по команде.

### P3.14 Индикатор набора текста
- Нет `sendChatAction` нигде; p90 ответа 5.2 с.
- Сделать: `ctx.replyWithChatAction("typing")` в `telegram-handlers.service.ts:715` перед `processText`, обновлять каждые 4 с до ответа.
- Приёмка: app-тест: `typing` вызван до `chat.processText`.

### P3.15 Today: обратный путь и >20 задач
- `:542-546`: развёрнутый экран не сворачивается, задачи после 20-й недостижимы.
- Сделать: кнопка «Свернуть», пагинация `nav:today:page:N`.

### P3.16 Длина сообщений
- Weekly-брифинг без ограничения (`briefing-content.service.ts:103-169`) может превысить 4096 и упасть в `bot.catch`.
- Сделать: единый cap 3900 в `telegram.service.ts:sendMessage/sendBriefing` с обрезкой по строкам; ограничить `nextAction`/`context` в брифинге до 120 символов.
- Приёмка: unit-тест на брифинг с 40 задачами.

---

## Фаза 4. Локализация (1 неделя, после P3)

Сейчас навигация трёхъязычная, а содержимое (карточки, клавиатуры, отчёты, дайджесты, подтверждения) только русское. Это хуже, чем сплошной русский.

### P4.1 Пронести `locale` через рендер
- `telegram-ui.ts:45-236, 353-357, 469-482, 503-523`; `core/applied-report.ts` (весь файл, нет параметра locale); `actions/action-describe.ts`; `core/recurrence-label.ts`; `core/time-presentation.ts:16,29,48-123`; `briefings/briefing-content.service.ts:36-170`; `telegram.service.ts:70-82`; `telegram-chat-reply.service.ts:16-22,74-106`; `telegram-conversation-handlers.service.ts:43-162`; ~40 toast в `telegram-handlers.service.ts`; все детерминированные команды `:191-404`.
- Сделать: `src/telegram/copy/` со словарями `ru/uk/en` и функцией `t(locale, key, params)`; все перечисленные функции принимают `locale`. Даты: `Intl` с локалью пользователя (`en` → `Aug 23, 6:00 PM`).
- Приёмка: снапшот-тест `tests/app/telegram-copy-snapshot.test.mjs`: каждый экран × 3 языка; инвариант «в EN-экране нет кириллицы, в RU нет латиницы кроме id/URL».

### P4.2 Контекст модели без русских литералов
- `core/turn-context.ts:235,263,417`, `core/time-presentation.ts:110-117`: «Показаны N из M», `пн…вс`, «выходные». EN-пользователь получает русский payload и модель тянет к русскому.
- Сделать: параметризовать по locale.

### P4.3 Один плюрализатор и одинаковые правила
- 4 копии с разными правилами (`action-describe.ts:87` даёт «12 задачи»). Оставить `plural` из `core`.

### P4.4 `card-details.ts` эвристики для uk/en
- `PLANNING_CHORE`, `SCHEDULING_ECHO`, `STOP_WORDS` (`:76-113`) в основном RU. Дополнить uk/en.

### P4.5 Убрать string-matching по заголовкам
- `telegram-handlers.service.ts:785` `startsWith("💭 Вечерний разбор")`, `:857` `startsWith("⚙️ Настройки")`: после локализации сломается (для uk/en уже сломано: карточка настроек не обновляется после очистки истории).
- Сделать: определять экран по `callback_data`/state, не по тексту.

---

## Фаза 5. Производительность и данные (1 неделя)

### P5.1 N+1 на пути ответа
- `actions.service.ts:537-614`: по 2–4 запроса на каждую созданную задачу для отчёта; `validate` (`:110-123`) последовательный цикл `getTask/getOccurrenceContext`; `afterCommit` (`:513-532`) последовательные rebuild.
- Сделать: батч `IN (...)` для occurrences и next reminders; `Promise.all` в validate и afterCommit.
- Приёмка: e2e с подсчётом запросов (обёртка над pool.query) на пакет из 5 задач: ≤ 12 запросов.

### P5.2 Дублирующие гейты и последовательные независимые запросы
- `chat.service.ts:393` и `:427`: `currentAiGate` дважды без внешнего вызова между ними; `listRecentForAi` (`:416`) ждёт `turnContext.build`, хотя независим; `localeFor` (`telegram-handlers.service.ts:513-516`) перечитывает настройки.
- Сделать: один гейт; `Promise.all` для контекста и истории; locale из уже загруженных настроек.

### P5.3 Неограниченные и неупорядоченные сканы
- `reminder-queue.service.ts:78-81` (LIMIT 1000 без ORDER BY, boot ставит все будущие), `tasks.repository.ts:315-325` (1000), `recurrence-maintenance.service.ts:39-45` (500), `tasks.repository.ts:271-304` (200 старейших, никогда не сдвигается → вечное голодание).
- Сделать: `ORDER BY` + keyset-пагинация; boot enqueue только для `scheduled_for < now + 24h`; `markIgnoredResultChecks` переписать в один `INSERT ... SELECT ... WHERE NOT EXISTS` с маркером `resolved_at`.
- Приёмка: e2e на `markIgnoredResultChecks` с 250 строками.

### P5.4 Cleanup-джобы без RETURNING всего и батчами
- `actions.repository.ts:122-146, 237-272`, `messages.repository.ts:164-170`, `tasks.repository.ts:306-312`, `context.repository.ts:173-185`: `RETURNING id` ради count, полные сканы.
- Сделать: `rowCount`, `LIMIT 1000` в цикле.

### P5.5 `checkAiSpendWarnings` одним запросом
- `maintenance.service.ts:85-101`: SUM на каждого пользователя + последовательные отправки. `GROUP BY user_id`.

### P5.6 Пул и таймауты
- `database.service.ts:13`: только `max: 10`. Добавить `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`, `statement_timeout: 15000`, `query_timeout: 15000`, `application_name`. `migrate.ts` без statement_timeout, но с `lock_timeout = '5s'` и ретраем.
- Один `PgBoss` на приложение (`queue/pg-boss.service.ts`), `max: 5`; worker `batchSize: 5, localConcurrency: 5, pollingIntervalSeconds: 1`; dead-letter очередь + уведомление владельцу (`maintenance.service.ts:99` уже умеет писать в Telegram).

### P5.7 `/health` и `/ready`
- `health.controller.ts:13-17`: при исчерпании пула висит, не показывает мёртвые воркеры.
- Сделать: `/health` = процесс жив; `/ready` = `select 1` с таймаутом 2 с + timestamp последнего успешного тика каждого из 7 циклов (`lastTickAt` в каждом периодическом сервисе; красный, если старше 3 интервалов). `docker-compose.yml` healthcheck на `/ready`.

### P5.8 `telegram_updates`: статус, ретеншн, уникальность
- `telegram.service.ts:36-45`: строка пишется до `next()`, `status` никогда не обновляется, ретеншна нет, `telegram_chat_message_uq` без `bot_identity`, insert без conflict target, вставка до проверки доступа (write amplification от чужих).
- Сделать: `status = 'handled'` после `next()`; sweep `received` старше 10 минут на старте (переобработать или пометить `lost`); удалять старше 7 дней в maintenance; индекс с `bot_identity` (миграция); insert только после allowlist-гейта из P3.6.

### P5.9 Rate-limit с учётом in-flight
- Отложено: обновления одного чата уже выполняются строго по очереди (`sequentialize`), так что параллельные вызовы одного пользователя возможны только между живым ходом и `AiRetryService`. Порог `max - 1` в `voiceGate` оставлен.
- `chat.service.ts:325-333`: два COUNT, потом вызов; параллельные вызовы невидимы; `voiceGate` использует `max - 1`.
- Сделать: вставлять `ai_usage` строку со статусом `in_flight` до вызова, обновлять после; единый порог.

### P5.10 Ретеншн `task_events`
- Растёт вечно, зануляется только `details`. Решить: удалять события старше 180 дней, кроме терминальных статусов, либо агрегировать. Зафиксировать в README.

### P5.11 `deleteTasksIfVersions` без гонки
- `tasks.repository.ts:233-246`: read-then-delete. `DELETE ... WHERE (id, version) IN (...) RETURNING id`. (Метод сейчас без вызовов, см. P6.7; если удаляется, пункт снимается.)

---

## Фаза 6. Архитектура и чистота кода (2–3 недели, инкрементально)

### P6.1 Логгер
- 71 `console.*` в 19 файлах, `Logger` Nest не используется, нет уровней, нет correlation id.
- Сделать: `src/observability/logger.ts`: `logger.info|warn|error(event, fields)` → одна JSON-строка, `LOG_LEVEL` из env; заменить все вызовы (сигнатура уже `(message, {fields})`); `turnId` генерируется в middleware Telegram и пробрасывается через `ChatProcessResult`/`ActionScope`. `safeError` не менять.
- Приёмка: grep `console\.` в `src/` пуст кроме `logger.ts` и `main.ts`.

### P6.2 Разбить `telegram-handlers.service.ts` (1405 строк)
- Новые файлы: `telegram/handlers/system-commands.service.ts` (`:93-237`), `settings-commands.service.ts` (`:239-407`, `:737-766`), `task-callbacks.service.ts` (`:637-656, 864-1093`), `onboarding.service.ts` (`:412-486`), `pending-input.service.ts` (`:1095-1182, 658-679, 947-984`), `screens.service.ts` (`:504-561, 602-626`); копия в `telegram/copy/{help,guide,registration,onboarding}.ts` (`:1201-1405`). `TelegramHandlersService` остаётся композицией ~60 строк.
- Заменить 31 `ctx: any` на `CommandContext<Context>`, `CallbackQueryContext<Context>`, `Filter<Context, "message:text">`, `Filter<Context, "message:voice">`; это уберёт 31 `!`.
- Делать после P3.6 (middleware) и P4.1 (copy), чтобы не переносить код дважды.
- Приёмка: ни один файл в `src/telegram/` > 400 строк; `grep 'ctx: any' src/` пуст.

### P6.3 Разбить `actions.service.ts` и `action-mutations.repository.ts`
- `actions/action-validation.service.ts`, `action-step-compiler.ts` (чистый), `applied-report.builder.ts`, `action-aftercommit.service.ts`; `actions/steps/{task,occurrence,reminder,settings}-steps.ts`, `action-snapshots.ts`. Разорвать цикл `action-group.repository.ts:19` ↔ `action-mutations.repository.ts:27` через `action-group-finalize.ts`.
- Типизировать `ResolvedActionOf<"goal"|"memory"|"settings">` как discriminated union по `op`/`operation`, чтобы исчезли 17 `!` в `actions.service.ts:207-499` (P2.10 контракт для модели тоже выигрывает: `settings`, `goal`, `set_reminder` как union по операции).

### P6.4 Репозитории для всех доменов
- Сделано: `SettingsRepository` (весь SQL `user_settings`), `TelegramUpdatesRepository` (журнал апдейтов; транспорт больше не пишет SQL).
- Осознанно не сделано: `AccessService`, `reminder-*`, `briefing-*`. Там SQL и есть доменное правило: удаление аккаунта, подавление доставок и запись в аудит идут одной транзакцией, а планирование напоминаний — одним запросом с джойнами. Вынести их в репозиторий можно только целиком, оставив сервис пустой обёрткой, либо разорвав транзакцию. Первое ничего не даёт, второе опасно.
- SQL напрямую в сервисах: `settings.service.ts`, `access.service.ts`, `reminder-*.service.ts`, `briefing-*.service.ts`, `maintenance.service.ts`, `recurrence-maintenance.service.ts`, `telegram.service.ts:37-42`.
- Сделать: `SettingsRepository`, `AccessRepository`, `RemindersRepository`, `BriefingsRepository`, `TelegramUpdatesRepository`; тела запросов переносить дословно.

### P6.5 Домен не импортирует Telegram-рендер
- Частично: реальный вред (эмодзи брифинга в промпте) снят — `stripPresentation` (`core/telegram-ux.ts`) чистит недельный снимок перед моделью. `briefing-content` и `reminder-queue` по-прежнему зовут `telegram-ui`: это путь доставки в Telegram, отдельный слой рендера там ничего не защищает.
- `briefing-content.service.ts:8` и `reminder-queue.service.ts:8` импортируют `telegram-ui.ts`; брифинг с эмодзи уходит в промпт модели.
- Сделать: контент-сервисы возвращают структуру (`DigestItem[]`), рендер в `telegram-ui.ts`; модели отдавать plain-текст.

### P6.6 Удалить дублирование
- `withWeeklySnapshot` (P2.11); два `actionSummary` (P1.11); три клавиатуры confirm/undo (P3.9); два pg-boss (P5.6); `occurrenceFallsOnLocalDate` (`tasks.service.ts:263-269` = `briefing-content.service.ts:27-34`) → `core/local-schedule.ts`; `importanceRank` ×4; `DbTransaction` ×3 → `database.service.ts`; locale-резолверы ×3 → `core/language.ts`; `TERMINAL_OCCURRENCE_STATUSES` ×6 → `core/types.ts`; 7 polling-сервисов → `runtime/periodic.service.ts` с `lastTickAt` (нужен для P5.7); константы `15` минут ×4, `90` дней ×2, advisory-ключи ×2, «14 дней»/«7 дней» в копии → экспорт из `core`.
- Core-политики, которые прод переписал инлайном: `shouldBundleWeeklyReview`, `morningDigestSections`, `shouldWarnMonthlySpend`, `canConfirmAction/canUndoAction` → вызывать core-версии.

### P6.7 Удалить мёртвый код
- `ActionMutationsRepository` (12 методов, `action-mutations.repository.ts:116-219`) и `ContextActionsRepository` (8 из 9 методов) инжектятся в `ActionsService` и не вызываются; e2e переписать на `ActionGroupRepository.apply`.
- Мёртвые методы: `ActionsRepository.finalizeApplied/finalizeUndo/listEventsForGroup`, `TasksService.undoCreatedTasks/getCreatedTasksForActionGroup/createTask/createTasks`, `TasksRepository.deleteTasksIfVersions/findTasksBySourceActionGroup/createPlan/createPlans/listRecurrenceExclusions`, `AccessService.resolveUserAnyStatus/getUserSettings`; core: `REF_PREFIX`, `formatLocalDateLabel`, `localDateTimeToUtc`, `missingWeeklyReviewDimensions`, 5 алиасов `ai-contract.ts:208-219`; `scripts/backup.sh`, `scripts/restore.sh`; `openspec/changes/improve-complex-planning-and-task-batches` → `archive/`.
- Включить `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` в `tsconfig.json`.

### P6.8 Drizzle schema ↔ миграции
- В `schema.ts` нет 17 CHECK, 14 `.onDelete("cascade")`, 3 partial-предикатов (`:267` `occurrence_series_recurrence_key_uq` без `WHERE recurrence_key IS NOT NULL` запретит легальные строки при генерации), 5 индексов, 2 FK; ~25 выдуманных имён constraint.
- Сделать: сначала cascade и `.where(...)`, затем CHECK и имена. До этого не запускать `drizzle-kit generate`. Добавить тест, сравнивающий `information_schema` e2e-базы с `schema.ts` (хотя бы индексы и FK).

### P6.9 Checksums миграций
- `migrate.ts:28-31` сверяет только имя файла. `0010:5-7` и `0018:4-23` при повторном запуске разрушительны.
- Сделать: колонка `checksum` в `schema_migrations`, sha256 файла, abort при расхождении; поддержка `-- no-transaction` для `CREATE INDEX CONCURRENTLY`.

### P6.10 Lint и формат
- `eslint` + `typescript-eslint` flat config: `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unnecessary-condition`, `consistent-type-imports`; `prettier`; скрипты `lint`, `format`, `format:check`; в `check` и CI.
- Первый прогон даст много `no-floating-promises`; разобрать 102 `.catch(() => undefined)`: оставить только для Telegram edit-race через helper `ignoreTelegramEditRace(promise)`, остальные логировать (`chat.service.ts:290,454,477`, `telegram-handlers.service.ts:269,344,369,763`, `actions.service.ts:516-530`).

---

## Фаза 7. Тесты и eval агента (параллельно фазам 2–6)

### P7.1 Покрытие и ratchet
- `c8` с `--check-coverage --lines 70 --branches 60`, `.c8rc.json` (`all: true, src: dist`), скрипт `coverage` в CI.
- 20 файлов никогда не загружаются тестами: `ai-retry.service`, `gemini.provider`, `transcription.service`, `briefing-queue`, `briefing-scheduling`, `maintenance.service`, `cli.ts`, `migrate.ts`, `single-instance.service`, `telegram-conversation-handlers.service`, модули.

### P7.2 Тесты Telegram-обработчиков
- 45 обработчиков без единого теста. После P3.6/P6.2: харнесс с фейковым grammY `ctx` (`tests/app/helpers/telegram-harness.mjs`); тесты на каждый `callbackQuery` паттерн: stale, чужой workspace, двойной тап, 64-байтный лимит (`callback_data.length <= 64` для всех генераторов клавиатур с uuid).

### P7.3 Тесты очереди напоминаний
- `reminder-queue.service.ts` + `reminder-scheduling.service.ts` (723 строки) без тестов. Фейковый pg-boss, контролируемое время: доставка, тихие часы при доставке, snooze, эскалация, boot-recovery (P1.1), orphan (P1.6), 429/ambiguous (P1.5).

### P7.4 Property-тесты времени
- `fast-check` для `core/timezone.ts`, `recurrence.ts`, `local-schedule.ts`: зоны `Europe/Kyiv`, `Europe/Lisbon`, `America/Santiago`, `Australia/Lord_Howe`, `Pacific/Chatham`, `Asia/Tehran`; инварианты: монотонность, ровно N локальных дат без пропусков/дублей через DST, `until` включительно, `skipDates` не сдвигает остальные. Снять пункты DST из `MANUAL_ACTIONS.md:18,20`.

### P7.5 Снапшоты копии × 3 языка
- См. P4.1. Использовать `t.assert.snapshot` Node 24.

### P7.6 Тесты `maintenance`, `access`, `settings`, `transcription`
- `maintenance.service.ts` делает необратимые `DELETE FROM users` без тестов: e2e на cutoff-арифметику. `transcription.service.ts:29`: консент на границе при отозванном согласии блокирует загрузку (unit с фейковым OpenAI). `settings.service.ts`: 13 инкрементов версии, pending-input автомат.

### P7.7 Backup round-trip в CI
- `tests/app/ops-scripts.test.mjs` грепает исходник скрипта. Заменить на реальный прогон в e2e job: backup → restore в одноразовый контейнер → сравнение количества строк по манифесту.

### P7.8 Eval-контур агента
- `tests/eval/dialogs.json`: `{message, seededContext, expect: {actionTypes, when, recurrence, intent, questionExpected}}` — минимум 9 фраз §2.7 + карточка + 10 новых (uk/en, память, settings, ambiguous).
- `scripts/eval-agent.mjs --runs N --baseline eval/baseline.json`: реальный провайдер, одноразовый workspace, проверка содержимого созданных сущностей (не только `applied > 0`), pass-rate по каждой проверке, `attempts`, токены, USD; результат в `eval/results/<date>-<model>.json`; `--baseline` падает при регрессии.
- Продовые метрики §10 `AGENT_FLOW.md` как SQL в `scripts/agent-metrics.sql` и еженедельная строка в лог maintenance: вызовов/сообщение, средний вход, доля explicit-сообщений с applied/pending, Undo за 60 с.
- Заменить `scripts/qa-agent-flow.mjs` на eval-скрипт; `MANUAL_ACTIONS.md:19` ссылается на него.

### P7.9 Тесты интеграции DI
- `nest-module-wiring.test.mjs` проверяет одно ребро. Добавить тест, который создаёт `AppModule` через `Test.createTestingModule` с фейковыми `DatabaseService`/`TelegramService` и проверяет, что граф резолвится и порядок shutdown: Telegram → очереди → пул.

---

## Фаза 8. Ops и деплой (3–4 дня)

### P8.1 Деплой с health-gate и откатом
- `deploy.yml:41-42`: `up -d` возвращается до healthcheck, `image prune -f` удаляет предыдущий образ.
- Сделать: удалённый скрипт `scripts/deploy-remote.sh`: сохранить `PREV=$(git rev-parse HEAD)`, backup перед миграцией, `docker compose up -d --build --wait --wait-timeout 180`, poll `/ready` до совпадения `commit` с SHA (30 × 5 с), при провале checkout `PREV` и повторный up, exit 1. `image prune` в отдельный еженедельный cron с `--filter until=168h`. `stop_grace_period: 30s` в compose (гонка advisory-lock между старым и новым контейнером, `migrate.ts:20-22`).
- Долгосрочно: сборка образа в CI, push в GHCR, на сервере `compose pull` по digest.
- Приёмка: ручной прогон на проде с заведомо ломаным коммитом откатывается; записать в `docs/DEPLOYMENT.md`.

### P8.2 Логи и алерты
- `docker-compose.yml`: `logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }` для обоих сервисов.
- Dead-man switch (healthchecks.io или аналог) с backup-cron и 5-минутного `curl /ready`.
- Telegram владельцу (`OWNER_TELEGRAM_USER_ID`) из maintenance: pending-доставки старше 10 минут, dead-letter не пуст, бэкап старше 26 часов, `ambiguous` доставки.
- `/status`: реальный `select 1`, глубина очередей, последний бэкап, самый старый pending.

### P8.3 Бэкап/restore исправления
- `restore-compose.sh:51`: `--exit-on-error --single-transaction`, сравнение числа строк с манифестом.
- `restore.sh` удалить (P6.7) или `--single-transaction --exit-on-error` + guard по `current_database()`.
- Все скрипты на `bash` + `set -euo pipefail` (сейчас pipe-ошибки в `:46, :69, :72` невидимы).
- sha256 sidecar рядом с `.enc`; cron backup (03:15) и ежемесячный restore-drill с алертом; `flock` от наложения.
- `scripts/fix-*.sql` содержат прод-uuid и текст пользователя: удалить из дерева (остаются в истории).

### P8.4 Документация
- `docs/DEPLOYMENT.md:64` секрет `DEPLOY_SSH_PRIVATE_KEY` ≠ `deploy.yml:26` `DEPLOY_SSH_PRIVATE_KEY_BASE64`, не сказано про base64.
- `docs/AGENT_FLOW.md:43` ссылается на удалённый `goal-focus.ts`.
- `docs/QA_PRODUCT_TECHNICAL_2026-08-23.md`: пометить как устаревший (описывает удалённые пути) и оставить только оценки диалогов как baseline.
- `.github/pull_request_template.md` с чеклистом из `AGENTS.md`; `CODEOWNERS`; `SECURITY.md`.
- `package.json` `dev`: заменить `&` на `concurrently -k` или trap-обёртку.

---

## Метрики, по которым видно результат

| Метрика | Сейчас | Цель | Где мерить |
|---|---|---|---|
| CI зелёный на ветке | нет (docker build) | да | GitHub Actions |
| e2e в CI | нет | да, на каждый PR | `ci.yml` |
| Дубли напоминаний после рестарта | возможны | 0 | P7.3 тест + прод-лог |
| Пропускная способность бота | ~3 сообщения/мин на всех | параллельно по чатам | P1.4 |
| Макс. задержка одного хода | до 10 мин при зависшем провайдере | ≤ 45 с | P1.3 |
| Память находится по запросу | не находится | ≥ 90 % на eval-наборе | P1.9 + P7.8 |
| Фразы §2.7 с первого вызова | 8/9 | 9/9 в 3 прогонах | P7.8 |
| Средний вход модели | ~6k токенов | ≤ 5k | P2.11 |
| Undo в первые 60 с | 8/30 | ≤ 1/30 | P7.8 метрики |
| Экраны на uk/en без русского | ~40 % | 100 % | P4.1 снапшоты |
| Покрытие строк (core+app) | не измеряется | ≥ 70 %, ratchet | P7.1 |
| Файлов > 700 строк | 4 | 0 | P6.2, P6.3 |
| `console.*` в src | 71 | 0 | P6.1 |
| `ctx: any` | 31 | 0 | P6.2 |

## Рекомендуемый порядок исполнения

1. P0 целиком (полдня).
2. P1.1, P1.2, P1.3, P1.7 (день): дубли и зависания.
3. P1.4, P1.5, P1.6, P1.11 (2 дня).
4. P1.8, P1.9, P1.10 (2 дня): индексы и поиск.
5. P2.6, P2.5, P2.3, P2.4, P2.7, P2.13 (3 дня): дешёвые и заметные.
6. P3.6 (middleware) → P3.1, P3.2, P3.14, P3.7 (3 дня).
7. P2.10, P2.9, P2.8, P2.11, P7.8 (неделя): агент и eval вместе, потому что eval нужен для проверки промпта.
8. P3.3, P3.4, P3.5, P3.8–P3.13, P3.15, P3.16.
9. P4 целиком.
10. P6.1, P6.10, P6.7, P6.6, P6.2, P6.3, P6.4, P6.5, P6.8, P6.9.
11. P5, P7 остальные, P8.

Фазы 5, 7, 8 можно вести параллельно с 3–6, если разные файлы.

---

## Статус выполнения (2026-09-04, ветка `improvement-plan`)

Ветка ушла на 35 коммитов вперёд `agent-flow-v2`. `npm run check` — 205 core + 200 app тестов, `npm run test:e2e` — 50, покрытие 64.8 % строк / 73.8 % ветвей (порог в `.c8rc.json` не даёт опуститься ниже).

**Сделано полностью:** фазы 0, 1, 2 (кроме проверки P2.9 на живом провайдере), 3, 4, 5 (кроме P5.9), 7, 8; из фазы 6 — P6.1, P6.2, P6.6, P6.7, P6.8, P6.9, P6.10.

**Сделано частично, с причиной:**
- **P2.9** — три примера добавлены в промпт и проверяются схемой контракта в app-тесте. Прогон `npm run eval:agent -- --runs 3` требует ключей провайдера и остаётся за владельцем.
- **P5.9** — отложено: обновления одного чата уже строго последовательны (`sequentialize`), так что гонка возможна только между живым ходом и `AiRetryService`. Порог `max - 1` в `voiceGate` оставлен.
- **P5.11** — снят: `deleteTasksIfVersions` удалён вместе с мёртвым кодом (P6.7).
- **P6.3** — из `actions.service.ts` вынесены валидация (`action-validation.ts`) и сборка отчёта (`applied-report.builder.ts`), 951 → 654 строки. `action-mutations.repository.ts` (1306) не тронут: там один шаг = одна транзакция, и разрезать его без риска нельзя.
- **P6.4** — `SettingsRepository` и `TelegramUpdatesRepository` сделаны. `AccessService`, `reminder-*`, `briefing-*` оставлены: там SQL и есть доменное правило (удаление аккаунта, подавление доставок и аудит — одна транзакция), вынос дал бы пустую обёртку или разорванную транзакцию.
- **P6.5** — реальный вред снят: `stripPresentation` чистит недельный снимок перед моделью. `briefing-content` и `reminder-queue` продолжают звать `telegram-ui`: это путь доставки в Telegram.

**Что осталось владельцу:** прогнать `npm run eval:agent -- --runs 3` с ключами и записать `eval/baseline.json`; выполнить ручные проверки из `MANUAL_ACTIONS.md`; настроить на сервере cron бэкапа с `BACKUP_PING_URL` и `HEALTHCHECK_PING_URL`.
