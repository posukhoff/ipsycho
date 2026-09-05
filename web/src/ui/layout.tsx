import type { ReactNode } from "react";

/**
 * The frame every screen sits in.
 *
 * `Screen` owns the only scroll container in the app. That matters more than it looks: a Mini App
 * webview closes on a downward swipe at the top of the *page*, so the page itself must not scroll —
 * `overscroll-behavior: none` plus one inner scroller is what stops a fast flick up a list from
 * dismissing the app.
 */

export function Screen({
  header,
  children,
  footer,
  flush,
}: {
  header?: ReactNode | undefined;
  children: ReactNode;
  footer?: ReactNode | undefined;
  flush?: boolean | undefined;
}): ReactNode {
  return (
    <div className="ip-screen">
      {header}
      <div className={`ip-screen__body${flush ? " ip-screen__body--flush" : ""}`}>{children}</div>
      {footer ? <div className="ip-screen__footer">{footer}</div> : null}
    </div>
  );
}

/**
 * The sticky title bar. It carries no back arrow of its own: inside Telegram the client's
 * BackButton is the back affordance, and the shell wires it. `leading` is for the browser-tab case
 * the shell fills in, not for a screen to reinvent.
 */
export function ScreenHeader({
  title,
  subtitle,
  actions,
  leading,
}: {
  title: ReactNode;
  subtitle?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  leading?: ReactNode | undefined;
}): ReactNode {
  return (
    <header className="ip-header">
      {leading}
      <div className="ip-header__titles">
        <h1 className="ip-header__title ip-truncate">{title}</h1>
        {subtitle ? <p className="ip-header__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ip-header__actions">{actions}</div> : null}
    </header>
  );
}

/** A titled group of rows, the way a settings screen is built. */
export function Section({ title, footer, children }: { title?: ReactNode | undefined; footer?: ReactNode | undefined; children: ReactNode }): ReactNode {
  return (
    <section className="ip-section">
      {title ? <h2 className="ip-section__title">{title}</h2> : null}
      <div className="ip-card">
        <div className="ip-row-group">{children}</div>
      </div>
      {footer ? <p className="ip-section__footer">{footer}</p> : null}
    </section>
  );
}

/** A free-form card: the task detail's description block, the week summary. */
export function Card({ children, padded = true }: { children: ReactNode; padded?: boolean | undefined }): ReactNode {
  return <div className={`ip-card${padded ? " ip-card--padded" : ""}`}>{children}</div>;
}

export function Stack({ children, gap }: { children: ReactNode; gap?: 1 | 2 | 3 | 4 }): ReactNode {
  return (
    <div className="ip-stack" style={gap ? { gap: `var(--space-${gap})` } : undefined}>
      {children}
    </div>
  );
}

/** A row of small things that wraps: pills, chips, two buttons side by side. */
export function Inline({ children }: { children: ReactNode }): ReactNode {
  return <div className="ip-inline">{children}</div>;
}
