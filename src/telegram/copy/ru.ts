/** Russian is the reference dictionary: every key here must exist in uk.ts and en.ts. */
export const ru = {
  // Access and registration
  access_denied: "Этот бот закрытый. Попроси у владельца персональную ссылку-приглашение.",
  access_denied_toast: "Нет доступа",
  private_only: "Я работаю только в личных сообщениях: там у каждого свой отдельный список задач.",
  invite_invalid: "Эта ссылка-приглашение недействительна, просрочена или уже использована.",
  invite_already_registered: "У тебя уже есть аккаунт в этом боте, ссылка не нужна. Если бот не отвечает, напиши владельцу.",
  invite_created:
    "Отправь эту персональную ссылку новому пользователю:\n{link}\n\nОна действует один раз в течение {days} дней. У человека будет отдельное пространство без доступа к твоим данным.",
  invite_not_allowed: "Создавать ссылки-приглашения может только владелец проекта.",
  invite_failed: "Не удалось создать ссылку-приглашение. Попробуй позже.",
  settings_missing: "Настройки аккаунта не найдены. Напиши /start, чтобы создать их заново.",
  unsupported_message: "Пока понимаю только текст и голосовые. Опиши словами, что нужно сделать. Например: «встреча в четверг в 16:00».",

  // Status
  status_server: "✅ Сервер IPsycho доступен",
  status_db_ok: "✅ PostgreSQL отвечает",
  status_db_failed: "❌ PostgreSQL не отвечает",
  status_telegram: "✅ Telegram доставил этот ответ",
  status_ai_configured: "🤖 AI: настроен ({provider})",
  status_ai_missing: "🤖 AI: не настроен",
  status_ai_suspended: "🤖 AI: приостановлен для аккаунта",
  status_deliveries: "🔔 Напоминаний в очереди: {pending}",
  status_deliveries_ambiguous: "⚠️ Доставок с неизвестным исходом: {ambiguous}",

  // History, cancel
  history_cleared: "AI-история очищена ({count} сообщений). Сообщения Telegram, задачи, цели, напоминания и настройки не изменены.",
  cancel_done: "Текущий ввод и разбор остановлены. Уже сохранённые задачи и решения не изменены.",

  // Account
  delete_prompt:
    "Удаление остановит AI, сводки и напоминания сразу. Данные будут окончательно удалены через {days} дней; до этого аккаунт можно восстановить командой /restore. Остаточные данные могут сохраняться в зашифрованных резервных копиях: {daily} ежедневных и {weekly} еженедельных.",
  delete_confirm_button: "Подтвердить удаление",
  delete_scheduled_toast: "Удаление запланировано",
  delete_scheduled: "Аккаунт заблокирован. В течение {days} дней его можно восстановить командой /restore.",
  delete_failed_toast: "Не удалось запланировать удаление",
  deletion_pending_notice: "Аккаунт ждёт удаления, поэтому всё остановлено. Вернуть его можно ещё {days} дн.: /restore",
  deletion_pending_toast: "Аккаунт ждёт удаления. Вернуть: /restore",
  restore_done: "Аккаунт восстановлен. Будущие напоминания снова активны.",
  restore_unavailable: "Аккаунт не ожидает удаления или срок восстановления уже истёк.",
  ai_revoked: "Согласие на внешнюю AI-обработку отозвано. Напоминания, сводки и кнопки продолжат работать.",
  retry_failed: "Повторная обработка пока не удалась. Сообщение сохранено.",

  // Consent
  consent_prompt:
    "Для AI-чата текст сообщений будет отправляться внешнему провайдеру {provider}. Голосовые при OpenAI отправляются только для расшифровки и не сохраняются как аудио. Разрешить такую обработку?",
  consent_yes_button: "Согласен",
  consent_no_button: "Не сейчас",
  consent_granted_toast: "Согласие сохранено",
  consent_granted_replaying: "Готово, обрабатываю твоё последнее сообщение.",
  consent_granted: "Готово. Напиши, что нужно сделать.",
  consent_declined_toast: "AI не включён",
  consent_declined:
    "Хорошо, AI выключен. Кнопки, напоминания и сводки продолжат работать; свободный текст я разбирать не буду. Включить можно в любой момент: просто напиши мне ещё раз.",
  voice_consent_prompt:
    "Для AI-обработки текст будет отправляться внешнему провайдеру, а голосовое — OpenAI только для расшифровки. Аудио не сохраняется; распознанный текст обрабатывается и хранится как обычное сообщение. Разрешить?",
  voice_consent_granted: "Голосовой ввод включён. Отправь голосовое ещё раз: аудио не переотправляется автоматически.",
  voice_consent_declined_toast: "Голосовой ввод не включён",

  // Chat gates
  chat_nothing_to_retry: "Нет сохранённых сообщений, которые ждут AI-обработки.",
  chat_ai_suspended: "AI-обработка для аккаунта приостановлена. Напоминания и кнопки продолжают работать.",
  chat_ai_unavailable: "AI сейчас недоступен. Сообщение сохранено: напиши /retry_ai, когда захочешь повторить. Напоминания и кнопки работают.",
  chat_rate_limited: "Достигнут часовой лимит AI ({limit} сообщений). Снова смогу разбирать текст после {until}. Кнопки, напоминания и сводки работают как обычно.",
  text_failed: "Не удалось обработать сообщение. Ничего не изменилось; я попробую сам ещё раз.",
  ai_retry_exhausted: "Так и не смог обработать сообщение: «{preview}». Ничего не изменилось. Попробовать ещё раз: /retry_ai",
  text_uncertain: "Не уверен, сохранилось ли изменение. Не повторяй пока: я проверю сам и напишу.",
  end_done: "Разговор закончен. Всё, что уже сохранено, остаётся.",
  end_none: "Сейчас нет активного разбора.",
  until_morning: "Хорошо. Молчу до {until}.",

  // Timezone, asked once at onboarding and changed by conversation afterwards
  timezone_usage: "Напиши город или часовой пояс. Например: «Берлин» или «Europe/Berlin».",
  timezone_set: "Основной часовой пояс: {timezone}. Уже созданные задачи не сдвигаются. Сводки и тихие часы пока остаются в прежнем поясе: применить новый и к ним?",
  timezone_invalid: "Не знаю такой часовой пояс. Напиши город, например «Берлин», или пояс вида Europe/Berlin.",
  time_invalid: "Неверное время. Используй формат HH:MM, например 09:30.",

  // Onboarding
  onb_timezone_prompt: "В каком ты часовом поясе? От этого зависит время сводок и разбор фраз вроде «завтра в 10». Напиши город, например «Берлин», или выбери ниже.",
  profile_title: "🧭 Контекст пользователя",
  profile_empty: "Пока здесь ничего нет.",
  profile_opening_question:
    "Можно отвечать свободно, пропускать вопросы или закончить в любой момент. Начнём с простого: какой у тебя обычно режим дня — когда встаёшь, ложишься и в какие часы лучше не планировать важное?",
  chat_too_many_questions: "Я задал уже пять вопросов подряд. Скажи «хватит вопросов» — сделаю вывод из того, что есть.",
  onb_step_unclear: "Ответь «да» или «нет» — или нажми кнопку.",
  onb_timezone_other: "Другой",
  onb_timezone_saved_toast: "Часовой пояс сохранён",

  // Generic toasts and buttons
  bad_command_toast: "Некорректная команда",
  done_toast: "Готово",
  back_button: "← Назад",
  not_now_button: "✖️ Не сейчас",

  // Mini App launch buttons. They exist only while WEBAPP_ENABLED is on; with the flag off no
  // keyboard asks for them, because there is no app to open and a dead end is worse than no button.
  webapp_open_button: "📲 Открыть в приложении",
  webapp_open_task_button: "📲 Открыть задачу",
  webapp_profile_hint: "Профиль и всё, что я о тебе помню, целиком — в приложении.",

  // Briefings: the morning and week cards, and the shared vocabulary their lines use
  scope_overdue: "просрочено",
  week_plan_summary: "За прошлую неделю закрыто: {done}. Взято и не начато: {stale}.",
  group_next: "ближ.",
  label_main: "Главное",
  nothing_planned: "Запланированных дел нет.",
  list_more: "+ ещё {count}",
  briefing_morning_title: "☀️ Сегодня",
  briefing_weekly_title: "🗂 План недели",
  briefing_goals_idle: "Цели без движения:",
  briefing_goal_idle_days: "тишина {days} дн.",
  goal_step_button: "💡 Шаг по цели: {title}",
  goal_step_prompt: "Что сделать по цели «{title}»? Предложи один конкретный шаг на эту неделю.",
  goal_step_gone_toast: "Цель уже не активна",
  briefing_taken_week: "Взято на неделю:",
  briefing_week_cta: "Выбрать задачи на следующую неделю можно в приложении.",
  briefing_pool_empty: "В пуле нет задач без даты.",

  // Action cards
  confirm_button: "Подтвердить",
  decline_button: "Не надо",
  undo_button: "↩️ Вернуть как было",
  undo_reschedule_button: "↩️ Отменить перенос",
  confirm_toast: "Подтверждено ✓",
  confirm_toast_many: "Подтверждено: {count}",
  confirmed_text: "Подтверждено.",
  declined_toast: "Отменено",
  already_handled_toast: "Уже обработано",
  undo_toast: "Вернул как было",
  undo_text: "↩️ Вернул как было. Изменение отменено:",
  action_stale_toast: "Уже нельзя отменить: прошло больше суток или задача успела измениться",
  action_uncertain_toast: "Не уверен, что записалось. Проверю сам и напишу",
  action_done_undo_hint: "Отменить можно в течение суток.",

  // Occurrence buttons
  task_not_found_toast: "Задача не найдена",
  task_unavailable_toast: "Задача уже недоступна",
  state_changed_toast: "Состояние уже изменилось или действие недоступно",
  resched_prompt_toast: "Когда вернуться?",
  done_occurrence_toast: "Готово ✓",
  skipped_toast: "Пропущено",
  cancelled_occurrence_toast: "Отменено",

  // Quick reschedule
  reason_toast: "Почему переносишь?",
  reason_prompt_text: "🕒 {title}\n\nПочему переносишь? Напиши коротко одним сообщением.",
  reason_write_toast: "Напиши причину",
  rescheduled_toast: "Перенесено",
  rescheduled_text: "Перенесено.",
  rescheduled_fuzzy_text: "Вернул задачу в нечёткое планирование.",
  resched_failed_toast: "Не удалось перенести",
  resched_failed_text: "Не удалось перенести. Скажи новое время ещё раз, например «завтра в 10» или «пт 15:00–16:00».",
  reason_too_short: "Не удалось перенести. Напиши коротко, почему переносишь, ещё раз.",
  repeated_reschedule: "Это уже повторный перенос. Если проблема не только во времени, можно зафиксировать, что именно мешает начать.",

  // Follow-ups / snooze
  followup_failed_toast: "Не удалось изменить проверку",
  snooze_reminder_toast: "Напомню позже",
  snooze_15m_button: "⏰ Через 15 мин",
  snooze_1h_button: "⏰ Через час",

  // Reminder notices
  quiet_deferred_notice: "🔕 Было в тихие часы, показываю сейчас",
  escalation_header: "🔴 Срок прошёл — {n}-е напоминание",
  mute_escalation_button: "🔕 Хватит по этой задаче",
  mute_escalation_toast: "Больше не напоминаю по этой задаче",

  // Voice
  voice_suspended: "AI-обработка для аккаунта приостановлена. Голосовой ввод недоступен.",
  ai_spend_warning: "Предупреждение: оценочные расходы AI в этом месяце достигли ${amount}. Это только уведомление; AI автоматически не отключается.",
  ai_spend_owner_notice: "IPsycho: пользователь {userId} достиг AI spend warning ${amount}.",
  ops_alert: "IPsycho: очередь напоминаний требует внимания. {details}",
  voice_too_long: "Голосовое слишком длинное или большое. Отправь запись до {minutes} мин и {mb} МБ либо текст.",
  voice_openai_only: "Голосовой ввод сейчас доступен только при настроенном OpenAI.",
  voice_rate_limited: "Достигнут часовой лимит AI. Попробуй позже, кнопки и напоминания работают.",
  voice_recognizing: "🎙 Распознаю…",
  voice_consent_needed: "Нужно подтвердить AI-обработку.",
  voice_unavailable: "Голосовой ввод сейчас недоступен.",
  voice_unrecognized: "Не удалось распознать речь. Попробуй записать короче или отправь текст.",
  voice_failed: "Не удалось обработать голосовое. Попробуй отправить его короче или напиши текст.",

  // The browsing screens moved to the Mini App (task 11). Their commands and their buttons still
  // answer for one release, with this sentence and a launch button — an unanswered callback leaves a
  // spinner, and the sentence has to stand on its own when WEBAPP_ENABLED is off and there is no button.
  moved_to_app: "Списки, фильтры и настройки теперь живут в приложении IPsycho. Здесь остаётся разговор: скажи словами, что создать, изменить, перенести или закрыть.",
  moved_to_app_toast: "Это теперь в приложении",
} as const;
