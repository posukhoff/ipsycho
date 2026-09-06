import test from "node:test";
import assert from "node:assert/strict";
import { canCreateRegistrationInvite, deterministicCopy, helpText, registrationTokenFromStart } from "../../dist/telegram/telegram-handlers.service.js";
import { telegramLocale } from "../../dist/telegram/telegram-locale.js";
import { TelegramService } from "../../dist/telegram/telegram.service.js";
import { deployedBuildLine, reminderCardText, taskCardText, todayLine } from "../../dist/telegram/telegram-ui.js";

const config = { aiVoiceMaxBytes: 20 * 1024 * 1024, aiVoiceMaxDurationSeconds: 300, aiMaxMessagesPerHour: 60, aiMaxCallsPerHour: 60 };

/** The commands task 11 deleted. `/help` must not send anyone to one of them. */
const REMOVED = /\/(tasks|task|today|week|goals|reminders|settings|memory|timezone|language|morning|weekly|quiet|snooze|reminder_defaults)\b/u;

test("start and help copy make natural language the primary interface in Russian", () => {
  assert.match(deterministicCopy("ru").ready, /Пиши как человеку/);
  assert.match(deterministicCopy("ru").ready, /голосовое/);
  const help = helpText(config, "ru");
  assert.match(help, /команды не нужны/);
  assert.match(help, /голосовое сообщение/);
  // Three surfaces, named: the conversation, the app, and the buttons that stayed on the cards.
  assert.match(help, /В этом чате/);
  assert.match(help, /В приложении/);
  assert.match(help, /На карточках здесь/);
  // Settings still change by conversation — the agent's `settings` action was never touched.
  assert.match(help, /Настройки меняются так же/);
  // The profile is an interview, not a screen: /help must offer it as something you start in chat.
  assert.match(help, /\/context — я спрашиваю/);
  assert.match(help, /\/status/);
  assert.doesNotMatch(help, /\/invite/);
  assert.doesNotMatch(help, REMOVED);
  assert.doesNotMatch(deterministicCopy("ru").ready, REMOVED);
  assert.match(help, /Не отправляй в чат пароли/);
});

test("start and help copy are genuinely localized in Ukrainian", () => {
  assert.match(deterministicCopy("uk").ready, /Пиши як людині/);
  assert.match(deterministicCopy("uk").ready, /голосове/);
  const help = helpText(config, "uk");
  assert.match(help, /команди не потрібні/);
  assert.match(help, /голосове повідомлення/);
  assert.match(help, /У цьому чаті/);
  assert.match(help, /У застосунку/);
  assert.match(help, /На картках тут/);
  assert.match(help, /Налаштування змінюються так само/);
  assert.match(help, /\/context — я питаю/);
  assert.doesNotMatch(help, /\/invite/);
  assert.doesNotMatch(help, REMOVED);
  assert.doesNotMatch(deterministicCopy("uk").ready, REMOVED);
  assert.match(help, /Не надсилай у чат паролі/);
});

test("English is a first-class locale and what the bot still renders does not fall back to Russian", () => {
  assert.equal(telegramLocale(null, "en-US"), "en");
  assert.match(deterministicCopy("en").ready, /For example/);
  assert.match(deterministicCopy("en").ready, /voice message/);
  const help = helpText(config, "en");
  assert.match(help, /voice message/);
  assert.match(help, /In the app/);
  assert.match(help, /On the cards here/);
  assert.match(help, /Settings change the same way/);
  assert.match(help, /\/context — I ask what is worth knowing/);
  assert.doesNotMatch(help, /\/invite/);
  assert.doesNotMatch(help, REMOVED);
  assert.doesNotMatch(deterministicCopy("en").ready, REMOVED);

  const task = { id: "task", title: "Call doctor", importance: "normal", recurrenceRule: null, fuzzyHorizonText: null, timezone: "Europe/Kyiv" };
  const occurrence = {
    id: "occ",
    status: "open",
    timezone: "Europe/Kyiv",
    plannedStartAt: "2026-08-12T09:00:00+03:00",
    plannedEndAt: null,
    plannedLocalDate: null,
    dueAt: null,
    dueLocalDate: null,
    overdue: true,
  };
  const rendered = [
    help,
    deterministicCopy("en").ready,
    taskCardText(task, occurrence, new Date("2026-08-12T05:00:00Z"), "en"),
    reminderCardText({ task, occurrence, purpose: "user_reminder", now: new Date("2026-08-12T05:00:00Z"), locale: "en" }),
    todayLine(task, occurrence, "2026-08-12", "en", new Date("2026-08-12T05:00:00Z")),
  ];
  for (const text of rendered) assert.doesNotMatch(text, /[А-Яа-яЁёІіЇїЄє]/);
});

test("registration deep links and invitation authority stay deterministic", async () => {
  const token = "A".repeat(43);
  assert.equal(registrationTokenFromStart(`/start join_${token}`), token);
  assert.equal(registrationTokenFromStart(`/start join_${token} extra`), null);
  assert.equal(registrationTokenFromStart("/start hello"), null);
  assert.equal(canCreateRegistrationInvite(42, 42), true);
  assert.equal(canCreateRegistrationInvite(42, 7), false);
  assert.equal(canCreateRegistrationInvite(undefined, 42), false);

  const telegram = Object.create(TelegramService.prototype);
  telegram.bot = { api: { getMe: async () => ({ username: "IPsychoTestBot" }) } };
  assert.equal(await telegram.registrationLink(token), `https://t.me/IPsychoTestBot?start=join_${token}`);
  telegram.bot = { api: { getMe: async () => ({ username: undefined }) } };
  await assert.rejects(() => telegram.registrationLink(token), /username/i);
});

test("status reports the deployed build so a deploy can be verified from Telegram", () => {
  assert.equal(deployedBuildLine("ddaba510e6feb22f67f3130d16501a039284a73d", "ru"), "🏷 Сборка: ddaba51");
  assert.equal(deployedBuildLine("ddaba510e6feb22f67f3130d16501a039284a73d", "uk"), "🏷 Збірка: ddaba51");
  assert.equal(deployedBuildLine("ddaba510e6feb22f67f3130d16501a039284a73d", "en"), "🏷 Build: ddaba51");
  assert.match(deployedBuildLine(undefined, "ru"), /неизвестна/);
});
