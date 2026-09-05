import { InlineKeyboard } from "grammy";
import type { AppConfig } from "../../config.js";
import type { TelegramLocale } from "../telegram-locale.js";
import { t } from "./index.js";

export type GuideSection = "tasks" | "goals" | "reminders" | "reports" | "ai";
export type GuideDestination = GuideSection | "help" | "index";

export function helpKeyboard(locale: TelegramLocale): InlineKeyboard {
  return new InlineKeyboard().text(t(locale, "help_button"), "guide:index");
}

export function guideKeyboard(locale: TelegramLocale, current?: GuideSection): InlineKeyboard {
  const labels =
    locale === "en"
      ? { tasks: "Tasks", goals: "Goals", reminders: "Reminders", reports: "Reports", ai: "AI processing", back: "← Help" }
      : locale === "uk"
        ? { tasks: "Завдання", goals: "Цілі", reminders: "Нагадування", reports: "Огляди", ai: "AI-обробка", back: "← Допомога" }
        : { tasks: "Задачи", goals: "Цели", reminders: "Напоминания", reports: "Отчёты", ai: "AI-обработка", back: "← Помощь" };
  if (current) return new InlineKeyboard().text(labels.back, "guide:index");
  return new InlineKeyboard()
    .text(labels.tasks, "guide:tasks")
    .text(labels.goals, "guide:goals")
    .row()
    .text(labels.reminders, "guide:reminders")
    .text(labels.reports, "guide:reports")
    .row()
    .text(labels.ai, "guide:ai");
}

export function guideIndexText(locale: TelegramLocale): string {
  if (locale === "en") return "📖 How it works\n\nChoose a topic. These guides explain behaviour and boundaries; manage everything by writing naturally in chat.";
  if (locale === "uk") return "📖 Як це працює\n\nОбери тему. Ці сторінки пояснюють логіку та межі; керувати всім можна звичайними повідомленнями в чаті.";
  return "📖 Как это работает\n\nВыбери тему. Эти страницы объясняют логику и границы; управлять всем можно обычными сообщениями в чате.";
}

export function guideText(section: GuideSection, locale: TelegramLocale): string {
  const ru: Record<GuideSection, string> = {
    tasks:
      "📋 Задачи\n\nЗадача может быть точной по времени, с окном, с дедлайном или с примерным горизонтом. Сразу добавляй «зачем», ограничения, людей, материалы и следующий шаг — это контекст задачи. Он попадёт в план дня и недели.\n\nЕсли дело состоит из шагов, перечисли их: AI предложит чек-лист. Незакрытые пункты не отмечаются автоматически при выполнении задачи.\n\n/tasks по умолчанию показывает просроченное и ближайшие 7 дней; кнопками под списком можно переключиться на сегодня, месяц, все или задачи без даты. Одинаковые дела собираются в одну строку — стрелка ▸ раскрывает все её даты.",
    goals:
      "🎯 Цели\n\nЦель отвечает на «зачем»: она связывает задачи и помогает выбирать, чему уделить внимание. У неё можно менять название, формулировку «зачем» и контекст обычным сообщением.\n\nСвязанные задачи показываются в /goals. Цель ничего не меняет сама: она помогает выбрать, что взять на неделю в /week.",
    reminders:
      "🔔 Напоминания\n\nДля события приходят сообщения до начала и в момент старта; у события на весь день — утром этого дня. Задача с точным временем напоминается в запланированный момент. У важных дедлайнов есть дополнительные планировочные касания до и около срока.\n\nТихие часы и перенос учитываются. Любое напоминание можно отменить или перенести обычным сообщением; новое напоминание не создаётся в прошлом.",
    reports:
      "🗓 План дня и недели\n\nУтренняя карточка показывает, что запланировано на сегодня, и ниже — задачи, взятые на эту неделю: тап ставит задачу на сегодня.\n\nРаз в неделю приходит карточка недели: что закрыто, что взято и не начато, и приглашение выбрать задачи на следующую неделю в /week. Выбор — это тапы, бот ничего не меняет сам.\n\nВремя утренней карточки и день недельной настраиваются в /settings обычным сообщением.",
    ai: "🤖 AI-обработка\n\nAI читает только ограниченный релевантный контекст твоего личного workspace: текущий диалог, задачи, цели и несекретный профиль. Он не получает данные других пользователей, доступ к базе или ключам.\n\nНе присылай пароли и ключи. Для внешней AI-обработки требуется согласие; голосовое сначала расшифровывается, аудио не сохраняется. «Очистить AI-историю» удаляет только историю, используемую AI, а не задачи, цели или профиль.",
  };
  if (locale === "ru") return ru[section];
  const uk: Record<GuideSection, string> = {
    tasks:
      "📋 Завдання\n\nЗавдання може мати точний час, проміжок, дедлайн або приблизний горизонт. Одразу додавай «навіщо», обмеження, людей, матеріали й наступний крок — це контекст завдання для плану дня і тижня.\n\nЯкщо справа складається з кроків, переліч їх: AI запропонує чекліст. Незакриті пункти не відмічаються автоматично разом із завданням.\n\n/tasks типово показує прострочене та найближчі 7 днів; кнопками під списком можна перемкнутися на сьогодні, місяць, усі або завдання без дати. Однакові справи збираються в один рядок — стрілка ▸ розкриває всі його дати.",
    goals:
      "🎯 Цілі\n\nЦіль відповідає на «навіщо»: вона пов'язує завдання й допомагає обирати пріоритет. Назву, «навіщо» та контекст можна змінювати звичайним повідомленням.\n\nПов'язані завдання видно в /goals. Ціль нічого не змінює сама: вона допомагає вибрати, що взяти на тиждень у /week.",
    reminders:
      "🔔 Нагадування\n\nДля події приходять повідомлення до початку й у момент старту; для події на весь день — ранку того дня. Завдання з точним часом нагадується у запланований момент. Важливі дедлайни мають додаткові планувальні нагадування до та біля строку.\n\nТихі години й перенесення враховуються. Будь-яке нагадування можна скасувати або перенести звичайним повідомленням; минуле не створюється.",
    reports:
      "🗓 План дня і тижня\n\nРанкова картка показує, що заплановано на сьогодні, а нижче — завдання, узяті на цей тиждень: тап ставить завдання на сьогодні.\n\nРаз на тиждень приходить картка тижня: що закрито, що взято й не почато, і запрошення вибрати завдання на наступний тиждень у /week. Вибір — це тапи, бот нічого не змінює сам.\n\nЧас ранкової картки і день тижневої налаштовуються в /settings звичайним повідомленням.",
    ai: "🤖 AI-обробка\n\nAI бачить лише обмежений релевантний контекст твого особистого workspace: поточний діалог, завдання, цілі та несекретний профіль. Він не отримує дані інших користувачів, доступ до бази чи ключів.\n\nНе надсилай паролі та ключі. Для зовнішньої AI-обробки потрібна згода; голосове спершу розшифровується, аудіо не зберігається. «Очистити AI-історію» видаляє лише історію для AI, а не завдання, цілі чи профіль.",
  };
  const en: Record<GuideSection, string> = {
    tasks:
      "📋 Tasks\n\nA task can have an exact time, time window, deadline, or deliberately approximate horizon. Include why it matters, constraints, people, materials, and a next step — that becomes task context for the day and week plan.\n\nFor a multi-step job, list the steps and AI can propose a checklist. Unchecked items are never silently completed with the task.\n\n/tasks shows overdue work and the next 7 days by default; the buttons under the list switch to today, the month, everything, or tasks without a date. Identical items collapse into one line — the ▸ arrow opens all of its dates.",
    goals:
      "🎯 Goals\n\nA goal answers “why”: it connects related tasks and helps choose priorities. You can change its title, why, and context in an ordinary message.\n\nLinked tasks appear in /goals. A goal changes nothing by itself: it helps choose what to take for the week in /week.",
    reminders:
      "🔔 Reminders\n\nAn event is contacted before it starts and at the start; an all-day event is contacted that morning. A task with an exact time is contacted at its planned time. Important deadlines receive additional planning contacts before and around the due date.\n\nQuiet hours and rescheduling are respected. Cancel or move any reminder in a normal message; a reminder is never created in the past.",
    reports:
      "🗓 The day and the week\n\nThe morning card shows what is planned for today, and below it the tasks taken for this week: one tap sets a task for today.\n\nOnce a week a week card arrives: what closed, what was taken and not started, and an invitation to pick the next week in /week. Picking is taps; the bot changes nothing on its own.\n\nThe morning time and the weekly day are set in /settings in ordinary language.",
    ai: "🤖 AI processing\n\nAI receives only limited relevant context from your personal workspace: the current conversation, tasks, goals, and non-sensitive profile. It cannot access other users' data, the database, or credentials.\n\nDo not send passwords or access keys. External AI processing requires consent; voice is transcribed first and audio is not stored. “Clear AI history” removes only history used by AI, not tasks, goals, or your profile.",
  };
  return locale === "uk" ? uk[section] : en[section];
}

export function helpText(config: AppConfig, locale: TelegramLocale): string {
  const voiceMb = Math.floor(config.aiVoiceMaxBytes / (1024 * 1024));
  if (locale === "en")
    return [
      "IPsycho, in short",
      "",
      "Write naturally or send a voice message — commands are not needed to create tasks. I help you remember, plan, and return to what matters without adding bureaucracy.",
      "",
      "What you can write",
      "• “Remind me to call the doctor tomorrow at 16:00”",
      "• “Move ‘buy pet food’ to Friday”",
      "• “I want to prepare for a half marathon by October”",
      "• “For the presentation, it is important to align the numbers with Lena”",
      "• “Do not message me until morning” or “weekly review on Sunday at 18:00”",
      "",
      "View and manage",
      "• /today — today’s plan",
      "• /tasks or /task — all active tasks\n• /week — the pool of undated tasks and the week plan",
      "• /goals — goals and linked tasks",
      "• /reminders — upcoming reminders",
      "• /settings — notification and chat settings",
      "• /context — what is useful to know about you",
      "• /memory — everything I remember, sensitive facts included",
      "• /status — whether the bot, database, and AI are available",
      "",
      "Use the button below for details about tasks, goals, reminders, reports, and AI processing.",
      "Relative time uses your timezone; unclear or sensitive changes need confirmation. /clear removes only AI history.",
      "Do not send passwords or access keys in chat.",
      `Limits: ${config.aiMaxMessagesPerHour} messages / ${config.aiMaxCallsPerHour} AI calls per hour; voice up to ${Math.floor(config.aiVoiceMaxDurationSeconds / 60)} min and ${voiceMb} MB.`,
    ].join("\n");
  if (locale === "uk")
    return [
      "IPsycho — коротко",
      "",
      "Пиши як людині або надсилай голосове повідомлення — команди для створення завдань не потрібні. Я допомагаю пам'ятати, планувати й повертатися до важливого без зайвої бюрократії.",
      "",
      "Що можна написати",
      "• «Нагадай завтра о 16:00 зателефонувати лікарю»",
      "• «Перенеси “купити корм” на п'ятницю»",
      "• «Хочу підготуватися до напівмарафону до жовтня»",
      "• «У презентації важливо узгодити цифри з Леною»",
      "• «Не пиши до ранку» або «щотижневий огляд у неділю о 18:00»",
      "",
      "Перегляд і керування",
      "• /today — план на сьогодні",
      "• /tasks або /task — усі активні завдання\n• /week — пул завдань без дати і план тижня",
      "• /goals — цілі та пов'язані завдання",
      "• /reminders — найближчі нагадування",
      "• /settings — налаштування повідомлень і чату",
      "• /context — що корисно враховувати про тебе",
      "• /memory — усе, що я пам’ятаю, включно з чутливим",
      "• /status — чи доступні бот, база та AI",
      "",
      "Кнопка нижче відкриє деталі про завдання, цілі, нагадування, огляди та AI-обробку.",
      "Відносний час рахується у твоєму поясі; неочевидні або чутливі зміни потребують підтвердження. /clear очищає лише AI-історію.",
      "Не надсилай у чат паролі чи ключі доступу.",
      `Ліміти: ${config.aiMaxMessagesPerHour} повідомлень / ${config.aiMaxCallsPerHour} AI-звернень за годину; голосове до ${Math.floor(config.aiVoiceMaxDurationSeconds / 60)} хв і ${voiceMb} МБ.`,
    ].join("\n");
  return [
    "IPsycho — коротко",
    "",
    "Пиши как человеку или отправляй голосовое сообщение — команды для создания задач не нужны. Я помогаю помнить, планировать и возвращаться к важному без лишней бюрократии.",
    "",
    "Что можно написать",
    "• «Напомни завтра в 16:00 позвонить врачу»",
    "• «Перенеси “купить корм” на пятницу»",
    "• «Хочу подготовиться к полумарафону к октябрю»",
    "• «В презентации важно согласовать цифры с Леной»",
    "• «Не пиши до утра» или «еженедельный обзор в воскресенье в 18:00»",
    "",
    "Просмотр и управление",
    "• /today — план на сегодня",
    "• /tasks или /task — все активные задачи\n• /week — пул задач без даты и план недели",
    "• /goals — цели и связанные задачи",
    "• /reminders — ближайшие напоминания",
    "• /settings — настройки уведомлений и чата",
    "• /context — что полезно учитывать о тебе",
    "• /memory — всё, что я помню, включая чувствительное",
    "• /status — доступны ли бот, база и AI",
    "",
    "Кнопка ниже откроет подробности о задачах, целях, напоминаниях, отчётах и AI-обработке.",
    "Относительное время считается в твоём часовом поясе; неочевидные и чувствительные изменения требуют подтверждения. /clear очищает только AI-историю.",
    "Не отправляй в чат пароли или ключи доступа.",
    `Лимиты: ${config.aiMaxMessagesPerHour} сообщений / ${config.aiMaxCallsPerHour} AI-обращений за час; голосовое до ${Math.floor(config.aiVoiceMaxDurationSeconds / 60)} мин и ${voiceMb} МБ.`,
  ].join("\n");
}
