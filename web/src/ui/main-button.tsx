import { useEffect, useRef, type ReactNode } from "react";
import { isInsideTelegram, showMainButton } from "../lib/telegram.js";
import { Button } from "./primitives.js";

/**
 * The primary action of a screen, on both surfaces.
 *
 * Inside Telegram it is the client's own MainButton — the bar at the bottom of the webview that
 * users already reach for. In a browser tab (Telegram Web's iframe still has one, but a developer
 * running `VITE_API_MOCK=1` does not) there is no such button, so the same declaration renders an
 * ordinary block button in the screen's footer instead.
 *
 * That is why it is one component and not a hook plus a button: a form that wired only the native
 * button would have no submit at all in a plain browser, and that is exactly where it is built.
 */

export interface MainActionProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean | undefined;
  readonly loading?: boolean | undefined;
  /** Renders nothing and hides the native button; simpler than conditionally mounting the parent. */
  readonly hidden?: boolean | undefined;
}

export function useMainButton({ label, onClick, disabled, loading, hidden }: MainActionProps): boolean {
  const handler = useRef(onClick);
  handler.current = onClick;
  const native = isInsideTelegram();

  useEffect(() => {
    if (!native || hidden) return;
    return showMainButton({ text: label, enabled: !disabled, ...(loading === undefined ? {} : { loading }) }, () => handler.current());
  }, [native, hidden, label, disabled, loading]);

  return native;
}

/** Put it in `<Screen footer={…}>`. */
export function MainAction(props: MainActionProps): ReactNode {
  const native = useMainButton(props);
  if (native || props.hidden) return null;
  return (
    <Button block variant="primary" disabled={props.disabled} loading={props.loading} onClick={props.onClick}>
      {props.label}
    </Button>
  );
}
