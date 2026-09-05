/**
 * The Mini App contract.
 *
 * One frozen set of zod schemas for every screen — including the screens whose endpoint is still a
 * placeholder — so that nine agents can build against it in parallel and none of them has to widen
 * it. A group that needs a shape this does not have asks for the change here; extending it locally
 * is what turns one contract into four.
 *
 * The rule that keeps it honest: nothing in `src/api/**` may import `drizzle-orm` or touch a
 * repository. These files describe what a screen reads and writes, and the presenters map the
 * domain onto them.
 */
export * from "./primitives.js";
export * from "./errors.js";
export * from "./schedule.js";
export * from "./reminders.js";
export * from "./tasks.js";
export * from "./goals.js";
export * from "./week.js";
export * from "./settings.js";
export * from "./memory.js";
export * from "./me.js";
export * from "./endpoints.js";
