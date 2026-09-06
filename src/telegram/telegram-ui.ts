/**
 * One import site for every Telegram view. The implementations live next door: shared vocabulary
 * and formatters in telegram-format, message bodies in telegram-cards, inline keyboards in
 * telegram-keyboards, Mini App deep links in telegram-webapp.
 *
 * The screen bodies used to be here too, in telegram-screens; task 11 deleted that file with the
 * screens themselves. What is left is what a card needs, plus the two pure helpers the rest of the
 * codebase imports from this directory (`reminderCardText`, `todayLine`).
 */
export * from "./telegram-format.js";
export * from "./telegram-cards.js";
export * from "./telegram-keyboards.js";
export * from "./telegram-webapp.js";
