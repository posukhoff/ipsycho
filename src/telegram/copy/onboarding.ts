import type { TelegramLocale } from "../telegram-locale.js";

export function deterministicCopy(locale: TelegramLocale) {
  if (locale === "en")
    return {
      startOnboarding:
        "Hi, I’m IPsycho — a personal assistant for tasks and plans. Write naturally: I can save a task, remind you, or break a goal into steps.\n\nA few quick questions first; everything can be changed later in /settings.",
      digestsPrompt: "Would you like morning and evening briefings? The default times are 09:00 and 20:00.",
      ready:
        "Hi — I help you remember, plan, and follow through on what matters.\n\nWrite naturally or send a voice message. For example: “Remind me to call the doctor tomorrow at 16:00” or “I want to prepare for a half marathon by October”.\n\nYour plan: /today · tasks: /tasks · goals: /goals\nFull guide: /help.",
      yes: "Yes",
      no: "No",
      ping: "Check connection",
      defaultLabel: "Use defaults",
      off: "Turn off",
      saved: "Saved",
      done: "Done",
      quietPrompt: "Turn on quiet hours? Defaults: weekdays 22:00–08:00, weekends 23:00–09:00.",
      weeklyPrompt: "Would you like a weekly review of goals and habits every Sunday at 20:00?",
      onboardingDone: "Setup is complete. Write naturally, for example: “remind me to call the doctor tomorrow at 16:00”.",
    };
  return locale === "uk"
    ? {
        startOnboarding:
          "Привіт, я IPsycho — особистий помічник для справ і планів. Пиши звичайними словами: я допоможу зберегти задачу, нагадати або розкласти мету на кроки.\n\nСпочатку кілька коротких питань; усе можна змінити пізніше в /settings.",
        digestsPrompt: "Потрібні ранкове й вечірнє зведення? Типовий час — 09:00 і 20:00.",
        ready:
          "Привіт — я допомагаю пам'ятати, планувати й доводити важливе до результату.\n\nПиши як людині або надсилай голосове повідомлення. Наприклад: «нагадай завтра о 16:00 зателефонувати лікарю» або «хочу підготуватися до напівмарафону до жовтня».\n\nПлан: /today · завдання: /tasks · цілі: /goals\nПовний гід: /help.",
        yes: "Так",
        no: "Ні",
        ping: "Перевірити зв’язок",
        defaultLabel: "За замовчуванням",
        off: "Вимкнути",
        saved: "Збережено",
        done: "Готово",
        quietPrompt: "Увімкнути тихі години? За замовчуванням: будні 22:00–08:00, вихідні 23:00–09:00.",
        weeklyPrompt: "Потрібен тижневий огляд цілей і звичок щонеділі о 20:00?",
        onboardingDone: "Налаштування завершено. Пиши звичайним текстом, наприклад: «нагадай завтра о 16:00 зателефонувати лікарю».",
      }
    : {
        startOnboarding:
          "Привет, я IPsycho — личный помощник для дел и планов. Пиши обычными словами: я помогу сохранить задачу, напомнить или разложить цель на шаги.\n\nСначала пара коротких вопросов; всё можно изменить позже в /settings.",
        digestsPrompt: "Нужны утренняя и вечерняя сводки? Обычное время — 09:00 и 20:00.",
        ready:
          "Привет — я помогаю помнить, планировать и доводить важное до результата.\n\nПиши как человеку или отправляй голосовое сообщение. Например: «напомни завтра в 16:00 позвонить врачу» или «хочу подготовиться к полумарафону к октябрю».\n\nПлан: /today · задачи: /tasks · цели: /goals\nПолный гид: /help.",
        yes: "Да",
        no: "Нет",
        ping: "Проверить связь",
        defaultLabel: "По умолчанию",
        off: "Выключить",
        saved: "Сохранено",
        done: "Готово",
        quietPrompt: "Включить тихие часы? По умолчанию: будни 22:00–08:00, выходные 23:00–09:00.",
        weeklyPrompt: "Нужен недельный обзор целей и привычек по воскресеньям в 20:00?",
        onboardingDone: "Настройка завершена. Пиши обычным текстом, например: «напомни завтра в 16:00 позвонить врачу».",
      };
}
