import type { ReactNode } from "react";
import { haptics } from "../lib/telegram.js";

/**
 * Buttons, badges and the spinner.
 *
 * Every tappable thing here fires a light haptic. That is the rule the shell follows throughout:
 * a tap that changes something buzzes, navigation does not (`haptics.select` in `Link` is the
 * quieter selection tick), and a failure gets `notification("error")` from the mutation layer.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly variant?: ButtonVariant | undefined;
  readonly block?: boolean | undefined;
  readonly small?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly loading?: boolean | undefined;
  readonly type?: "button" | "submit";
  readonly title?: string | undefined;
}

export function Button({ children, onClick, variant = "secondary", block, small, disabled, loading, type = "button", title }: ButtonProps): ReactNode {
  const classes = ["ip-button", `ip-button--${variant}`, block ? "ip-button--block" : "", small ? "ip-button--small" : ""].filter(Boolean).join(" ");
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      {...(title === undefined ? {} : { title })}
      onClick={
        onClick &&
        (() => {
          haptics.impact("light");
          onClick();
        })
      }
    >
      {loading ? <span className="ip-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function IconButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean | undefined }): ReactNode {
  return (
    <button
      type="button"
      className="ip-icon-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        haptics.impact("light");
        onClick();
      }}
    >
      {icon}
    </button>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "danger" }): ReactNode {
  return <span className={`ip-badge${tone === "neutral" ? "" : ` ip-badge--${tone}`}`}>{children}</span>;
}

/** A small inline label: «просрочено», «повтор», the goal a task belongs to. */
export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "danger" }): ReactNode {
  return <span className={`ip-pill${tone === "neutral" ? "" : ` ip-pill--${tone}`}`}>{children}</span>;
}

export function Spinner({ label }: { label?: string | undefined }): ReactNode {
  return <span className="ip-spinner" role="status" aria-label={label ?? "loading"} />;
}
