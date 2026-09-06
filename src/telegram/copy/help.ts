import type { AppConfig } from "../../config.js";
import type { TelegramLocale } from "../telegram-locale.js";

/**
 * `/help` after task 11: three surfaces, named in the order a user meets them.
 *
 * The conversation is the product's centre and did not change. The app is where browsing went. The
 * cards are the few buttons that stayed, because they answer the message they are attached to.
 *
 * Two things this text must keep saying, because they are the floor the cleanup left behind:
 * settings still change by conversation — the agent's `settings` action is untouched — and the bot
 * remains usable without ever opening the app, minus browsing. `/context` is named under the
 * conversation and not under the app for the same reason it survived the cleanup: it starts an
 * interview, and the app only shows what that interview wrote. The `guide:` sub-navigation that
 * used to hang off this message was itself a screen tree and went with the rest.
 */
export function helpText(config: AppConfig, locale: TelegramLocale): string {
  const voiceMb = Math.floor(config.aiVoiceMaxBytes / (1024 * 1024));
  const voiceMinutes = Math.floor(config.aiVoiceMaxDurationSeconds / 60);
  if (locale === "en")
    return [
      "IPsycho, in short",
      "",
      "Write naturally or send a voice message — commands are not needed. I help you remember, plan, and return to what matters without adding bureaucracy.",
      "",
      "In this chat",
      "• “Remind me to call the doctor tomorrow at 16:00”",
      "• “Move ‘buy pet food’ to Friday”",
      "• “I want to prepare for a half marathon by October”",
      "• “Do not message me until morning” or “weekly review on Sunday at 18:00”",
      "Settings change the same way: briefing time, weekly-review day, quiet hours, timezone, language. Just say what you want.",
      "• /context — I ask what is worth knowing about you, and remember the answers. The app shows what came of it; the asking happens here.",
      "",
      "In the app",
      "Today, tasks and task detail, creating and editing, rescheduling, goals, the week plan and the pool, paused series, reminders, settings, memory, and the profile /context builds. Open it from the menu button next to the message field, or from the button on any card.",
      "",
      "On the cards here",
      "Only what answers the message it arrives with: Done, Snooze 15 min / 1 h, +1 h / This evening / Tomorrow, Skip on a repeat, and Undo after a change. Everything else is a tap into the app.",
      "",
      "Commands that stayed",
      "• /status — whether the bot, database, and AI are available",
      "• /retry_ai — process the last message again",
      "• /cancel — stop the current input and parsing",
      "• /clear — remove AI history only, not tasks, goals, or your profile",
      "• /delete_account and /restore — delete the account, or take it back during the grace period",
      "• /ai_revoke — withdraw consent for external AI processing",
      "",
      "Relative time uses your timezone; unclear or sensitive changes need confirmation.",
      "Do not send passwords or access keys in chat.",
      `Limits: ${config.aiMaxMessagesPerHour} messages / ${config.aiMaxCallsPerHour} AI calls per hour; voice up to ${voiceMinutes} min and ${voiceMb} MB.`,
    ].join("\n");
  if (locale === "uk")
    return [
      "IPsycho — коротко",
      "",
      "Пиши як людині або надсилай голосове повідомлення — команди не потрібні. Я допомагаю пам'ятати, планувати й повертатися до важливого без зайвої бюрократії.",
      "",
      "У цьому чаті",
      "• «Нагадай завтра о 16:00 зателефонувати лікарю»",
      "• «Перенеси “купити корм” на п'ятницю»",
      "• «Хочу підготуватися до напівмарафону до жовтня»",
      "• «Не пиши до ранку» або «щотижневий огляд у неділю о 18:00»",
      "Налаштування змінюються так само: час зведень, день тижневого огляду, тихі години, часовий пояс, мова. Просто скажи, що потрібно.",
      "• /context — я питаю, що варто про тебе враховувати, і запам'ятовую відповіді. У застосунку видно результат; сама розмова — тут.",
      "",
      "У застосунку",
      "Сьогодні, завдання й картка завдання, створення та редагування, перенесення, цілі, план тижня і пул, серії на паузі, нагадування, налаштування, пам'ять і профіль, який будує /context. Відкрити — кнопкою меню біля поля введення або кнопкою на будь-якій картці.",
      "",
      "На картках тут",
      "Лише те, що відповідає повідомленню, з яким картка прийшла: Готово, Через 15 хв / годину, +1 година / Увечері / Завтра, Пропустити для повтору і Повернути як було після зміни. Решта — тап у застосунок.",
      "",
      "Команди, що лишилися",
      "• /status — чи доступні бот, база та AI",
      "• /retry_ai — обробити останнє повідомлення ще раз",
      "• /cancel — зупинити поточне введення й розбір",
      "• /clear — очищає лише AI-історію, а не завдання, цілі чи профіль",
      "• /delete_account і /restore — видалити акаунт або повернути його протягом строку",
      "• /ai_revoke — відкликати згоду на зовнішню AI-обробку",
      "",
      "Відносний час рахується у твоєму поясі; неочевидні або чутливі зміни потребують підтвердження.",
      "Не надсилай у чат паролі чи ключі доступу.",
      `Ліміти: ${config.aiMaxMessagesPerHour} повідомлень / ${config.aiMaxCallsPerHour} AI-звернень за годину; голосове до ${voiceMinutes} хв і ${voiceMb} МБ.`,
    ].join("\n");
  return [
    "IPsycho — коротко",
    "",
    "Пиши как человеку или отправляй голосовое сообщение — команды не нужны. Я помогаю помнить, планировать и возвращаться к важному без лишней бюрократии.",
    "",
    "В этом чате",
    "• «Напомни завтра в 16:00 позвонить врачу»",
    "• «Перенеси “купить корм” на пятницу»",
    "• «Хочу подготовиться к полумарафону к октябрю»",
    "• «Не пиши до утра» или «еженедельный обзор в воскресенье в 18:00»",
    "Настройки меняются так же: время сводок, день еженедельного обзора, тихие часы, часовой пояс, язык. Просто скажи, что нужно.",
    "• /context — я спрашиваю, что полезно о тебе учитывать, и запоминаю ответы. В приложении видно результат; сам разговор — здесь.",
    "",
    "В приложении",
    "Сегодня, задачи и карточка задачи, создание и правка, перенос, цели, план недели и пул, серии на паузе, напоминания, настройки, память и профиль, который собирает /context. Открыть — кнопкой меню рядом с полем ввода или кнопкой на любой карточке.",
    "",
    "На карточках здесь",
    "Только то, что отвечает пришедшему сообщению: Готово, Через 15 мин / час, +1 час / Вечером / Завтра, Пропустить для повтора и Вернуть как было после изменения. Остальное — тап в приложение.",
    "",
    "Оставшиеся команды",
    "• /status — доступны ли бот, база и AI",
    "• /retry_ai — обработать последнее сообщение ещё раз",
    "• /cancel — остановить текущий ввод и разбор",
    "• /clear — очищает только AI-историю, а не задачи, цели или профиль",
    "• /delete_account и /restore — удалить аккаунт или вернуть его в течение срока",
    "• /ai_revoke — отозвать согласие на внешнюю AI-обработку",
    "",
    "Относительное время считается в твоём часовом поясе; неочевидные и чувствительные изменения требуют подтверждения.",
    "Не отправляй в чат пароли или ключи доступа.",
    `Лимиты: ${config.aiMaxMessagesPerHour} сообщений / ${config.aiMaxCallsPerHour} AI-обращений за час; голосовое до ${voiceMinutes} мин и ${voiceMb} МБ.`,
  ].join("\n");
}
