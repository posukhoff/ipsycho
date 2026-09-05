import { useEffect, type ReactNode } from "react";
import { useBackInterceptor } from "../app/router.js";
import { useT } from "../i18n/index.js";
import { Button, IconButton } from "./primitives.js";

/**
 * The bottom sheet: reschedule, «what is blocking it», the timezone picker, a confirmation.
 *
 * It intercepts back while it is open, so the Telegram BackButton and the Android gesture close the
 * sheet instead of leaving the screen. That is the behaviour a native app has, and its absence is
 * the single most jarring thing about a web UI inside Telegram.
 */

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode | undefined;
  children: ReactNode;
  footer?: ReactNode | undefined;
}): ReactNode {
  useBackInterceptor(open ? onClose : null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="ip-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ip-sheet">
        <div className="ip-sheet__grabber" />
        {title ? (
          <div className="ip-sheet__header">
            <h2 className="ip-sheet__title">{title}</h2>
            <IconButton label="✕" icon="✕" onClick={onClose} />
          </div>
        ) : null}
        <div className="ip-sheet__body">{children}</div>
        {footer ? <div className="ip-sheet__body">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * A deterministic confirmation. Used for the risky answers the product already gates in chat —
 * cancelling a series, deleting a memory entry, requesting account deletion.
 */
export function ConfirmSheet({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  destructive,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode | undefined;
  confirmLabel?: ReactNode | undefined;
  destructive?: boolean | undefined;
  pending?: boolean | undefined;
}): ReactNode {
  const t = useT();
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {description ? <p className="ip-muted">{description}</p> : null}
      <div className="ip-stack">
        <Button block variant={destructive ? "danger" : "primary"} loading={pending} onClick={onConfirm}>
          {confirmLabel ?? t("common.confirm")}
        </Button>
        <Button block variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </Sheet>
  );
}
