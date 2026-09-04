import { InlineKeyboard } from "grammy";

/**
 * A fake grammY callback-query context. It records what the handler answered, how it edited the
 * message and which keyboard it left behind, so a test can assert the user-visible outcome of a
 * button without a bot, a network or a database.
 */
export function callbackContext(data, options = {}) {
  const { workspaceId = "ws-1", userId = "user-1", locale = "ru", settings = { version: 1, timezone: "Europe/Kyiv", morningReferenceTime: "09:00" }, editFails = false } = options;
  const answers = [];
  const edits = [];
  const markups = [];
  const ctx = {
    callbackQuery: { data, message: { message_id: 42, chat: { id: 777 } } },
    chat: { id: 777, type: "private" },
    from: { id: 777, language_code: locale },
    state: { access: { workspaceId, user: { id: userId, telegramUserId: 777 } }, settings, locale },
    answers,
    edits,
    markups,
    answerCallbackQuery: async (payload) => void answers.push(payload?.text ?? null),
    editMessageText: async (text, extra) => {
      if (editFails) throw new Error("message is not modified");
      edits.push(text);
      markups.push(extra?.reply_markup ?? null);
    },
    editMessageReplyMarkup: async (extra) => {
      if (editFails) throw new Error("message is not modified");
      markups.push(extra?.reply_markup ?? null);
    },
    reply: async (text) => void edits.push(text),
  };
  return ctx;
}

/** Callback payloads of the keyboard the handler left on the card. */
export function buttonsOf(markup) {
  if (!markup) return [];
  const rows = markup instanceof InlineKeyboard ? markup.inline_keyboard : (markup.inline_keyboard ?? []);
  return rows.flat().map((button) => button.callback_data);
}

/** The last keyboard the handler set, as callback payloads. */
export function lastButtons(ctx) {
  return buttonsOf(ctx.markups[ctx.markups.length - 1]);
}
