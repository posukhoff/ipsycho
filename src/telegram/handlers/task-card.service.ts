import { Injectable } from "@nestjs/common";
import { InlineKeyboard } from "grammy";
import { ReminderSchedulingService } from "../../reminders/reminder-scheduling.service.js";
import { TasksService } from "../../tasks/tasks.service.js";
import { t } from "../copy/index.js";
import { activeState, type AppContext } from "../telegram-context.js";
import type { TelegramLocale } from "../telegram-locale.js";
import { taskCardText, taskKeyboard } from "../telegram-ui.js";

export type OccurrenceContext = NonNullable<Awaited<ReturnType<TasksService["getOccurrenceContext"]>>>;

/**
 * The one card the chat still draws: a task, and the buttons that answer it in the moment.
 *
 * It is what remains of the screen tree after task 11 — every list, filter and detail screen moved
 * to the Mini App, but a reminder card, a completed reschedule and a reason typed in free text all
 * still redraw the same occurrence in place, so the body and the keyboard live here rather than in
 * whichever handler happened to need them last.
 */
@Injectable()
export class TaskCardService {
  constructor(
    private readonly tasks: TasksService,
    private readonly reminders: ReminderSchedulingService,
  ) {}

  /** Full task card: row fields plus checklist, goal and the next reminder that will actually fire. */
  async text(workspaceId: string, context: OccurrenceContext, locale: TelegramLocale = "ru"): Promise<string> {
    const [extras, nextReminderAt] = await Promise.all([
      this.tasks.getTaskCardExtras(workspaceId, context.task.id).catch(() => ({ checklist: [], goalTitle: null })),
      this.reminders.nextUserReminderAt(workspaceId, context.occurrence.id).catch(() => null),
    ]);
    return taskCardText({ ...context.task, ...extras, nextReminderAt }, context.occurrence, new Date(), locale);
  }

  /** The card's own keyboard for its current state, optionally with an Undo row for what just happened. */
  keyboard(ctx: AppContext, context: OccurrenceContext, undoGroupId?: string, undoLabel: "undo_button" | "undo_reschedule_button" = "undo_button"): InlineKeyboard {
    const { locale, webAppUrl } = activeState(ctx);
    const keyboard = taskKeyboard(context.occurrence.id, locale, { recurring: Boolean(context.task.recurrenceRule), webAppUrl });
    if (undoGroupId) keyboard.row().text(t(locale, undoLabel), `act:undo:${undoGroupId}`);
    return keyboard;
  }
}
