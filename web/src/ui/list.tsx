import { useEffect, useRef, type ReactNode } from "react";
import { haptics } from "../lib/telegram.js";
import { useNavigate } from "../app/router.js";
import { routeHref, type Route } from "../app/routes.js";

/**
 * The list row, and the sentinel that turns a list into an infinite one.
 *
 * A row is one line of a list *or* one line of a settings screen — the same component, because they
 * are the same thing: leading control, title, subtitle, meta on the right, trailing control. Giving
 * the screens two row components is how a list ends up looking different on two screens.
 */

export interface ListRowProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode | undefined;
  /** Right-aligned, small: a time, a count, a status. */
  readonly meta?: ReactNode | undefined;
  /** A checkbox, an avatar, a status dot. */
  readonly leading?: ReactNode | undefined;
  /** A switch, a chevron, a button. Clicks inside it do not trigger the row. */
  readonly trailing?: ReactNode | undefined;
  readonly onClick?: () => void;
  /** Navigates instead of calling back; renders a real `<a>` so the link is copyable. */
  readonly to?: Route | undefined;
  readonly muted?: boolean | undefined;
  readonly danger?: boolean | undefined;
  readonly chevron?: boolean | undefined;
}

export function ListRow({ title, subtitle, meta, leading, trailing, onClick, to, muted, danger, chevron }: ListRowProps): ReactNode {
  const navigate = useNavigate();
  const tappable = Boolean(onClick ?? to);
  const classes = ["ip-row", tappable ? "ip-row--tappable" : "", muted ? "ip-row--muted" : ""].filter(Boolean).join(" ");

  const body = (
    <>
      {leading ? <div className="ip-row__leading">{leading}</div> : null}
      <div className="ip-row__main">
        <div className={`ip-row__title${danger ? " ip-danger" : ""}`}>{title}</div>
        {subtitle ? <div className="ip-row__subtitle">{subtitle}</div> : null}
      </div>
      {meta ? <div className="ip-row__meta">{meta}</div> : null}
      {trailing ? <div className="ip-row__trailing">{trailing}</div> : null}
      {chevron ? <div className="ip-row__chevron">›</div> : null}
    </>
  );

  if (to) {
    return (
      <a
        className={classes}
        href={routeHref(to)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          haptics.select();
          onClick?.();
          navigate.push(to);
        }}
      >
        {body}
      </a>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={() => {
          haptics.select();
          onClick();
        }}
      >
        {body}
      </button>
    );
  }

  return <div className={classes}>{body}</div>;
}

/**
 * Loads the next page when it scrolls into view. Put it after the last row.
 *
 * `IntersectionObserver` rather than a scroll handler: the observer fires once per crossing instead
 * of on every frame, which matters on the low-end Android devices a Telegram webview runs on.
 */
export function InfiniteSentinel({
  hasMore,
  isLoading,
  onLoadMore,
  label,
}: {
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  label?: ReactNode | undefined;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;

  useEffect(() => {
    const element = ref.current;
    if (!element || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadRef.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore]);

  if (!hasMore && !isLoading) return null;
  return (
    <div className="ip-sentinel" ref={ref}>
      {isLoading ? <span className="ip-spinner" /> : (label ?? null)}
    </div>
  );
}
