export const ACTION_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;
export const ACTION_UNDO_TTL_MS = 24 * 60 * 60 * 1000;

export function actionExpiry(now: Date, ttlMs: number): Date {
  return new Date(now.getTime() + ttlMs);
}

export function canConfirmAction(status: string, expiresAt: Date, now: Date): boolean {
  return status === "pending" && expiresAt.getTime() > now.getTime();
}

export function canUndoAction(status: string, undoExpiresAt: Date | null, now: Date): boolean {
  return status === "applied" && Boolean(undoExpiresAt && undoExpiresAt.getTime() > now.getTime());
}
