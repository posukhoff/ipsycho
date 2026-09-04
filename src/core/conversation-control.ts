export type ConversationControl = "conclude" | "end" | "no_persist" | null;

const NORMALIZE_SPACES = /\s+/gu;

/**
 * Small deterministic escape hatches for a multi-turn AI discussion.
 * These phrases are intentionally conservative: ordinary prose should still go to AI.
 */
export function detectConversationControl(text: string): ConversationControl {
  const value = text.trim().toLocaleLowerCase().replace(NORMALIZE_SPACES, " ");
  if (!value) return null;

  if (/^(?:закончить|закончим|закончи|завершить|заверши|все[,. ]*хватит|всё[,. ]*хватит|досить|закінчити|завершити)[.!? ]*$/u.test(value)) {
    return "end";
  }
  if (
    /(?:хватит\s+(?:вопросов|спрашивать)|не\s+задавай\s+(?:больше\s+)?вопрос(?:ов|ы)?|сделай\s+вывод|дай\s+вывод|подведи\s+итог|досить\s+(?:питань|запитань)|зроби\s+висновок|підведи\s+підсумок)/u.test(
      value,
    )
  ) {
    return "conclude";
  }
  if (/(?:ничего\s+не\s+сохраняй|не\s+сохраняй\s+ничего|не\s+запоминай|нічого\s+не\s+зберігай|не\s+запам['’]?ятовуй)/u.test(value)) {
    return "no_persist";
  }
  return null;
}

/** A data action, deliberately narrower than general conversational controls. */
export function isClearConversationRequest(text: string): boolean {
  const value = text.trim().toLocaleLowerCase().replace(NORMALIZE_SPACES, " ");
  return /^(?:\/clear|очисти(?:ть)? (?:ai[- ]?)?истори(?:ю|ю чата)|удали(?:ть)? (?:ai[- ]?)?истори(?:ю|ю чата)|почисти(?:ть)? чат|очистити (?:ai[- ]?)?історію(?: чату)?|видали (?:ai[- ]?)?історію(?: чату)?|clear (?:ai |chat )?history|forget ai history)\s*[.!?]?$/iu.test(
    value,
  );
}

/** Only a message that is nothing but yes or no may answer a confirmation card. */
export function bareConfirmationDecision(text: string): "confirm" | "cancel" | null {
  const normalized = text
    .trim()
    .toLocaleLowerCase()
    .replace(/[!.…]+$/u, "")
    .trim();
  if (!normalized || normalized.length > 24) return null;
  if (/^(?:да|ага|давай|давайте|подтверждаю|согласен|согласна|верно|ок|окей|так|гаразд|підтверджую|подходит|yes|yep|ok|okay|confirm)$/u.test(normalized)) return "confirm";
  if (/^(?:нет|не надо|не нужно|отмена|отмени|стоп|ні|не треба|скасуй|no|nope|cancel|stop)$/u.test(normalized)) return "cancel";
  return null;
}
