import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EndpointName } from "../api/contracts.js";
import { useT } from "../i18n/index.js";
import { useMutation, useQueryCache } from "../lib/query.js";
import { haptics } from "../lib/telegram.js";

/**
 * Toasts, and the Undo snackbar.
 *
 * `useUndo` is the reason this file is not just a toast queue. Every write endpoint answers with an
 * `undoGroupId` **or `null`**, and the contract is explicit about what the null means: the change is
 * not truthfully reversible. So the snackbar offers the Undo button only when the server said it
 * can, and shows a plain confirmation otherwise. Offering an Undo that cannot restore the previous
 * state is the one thing `AGENTS.md` forbids by name.
 *
 * The optimistic patch and this snackbar are two halves of the same interaction: the row flips at
 * the tap (`useMutation`'s `optimistic`), the snackbar says what happened, and Undo asks the server
 * to reverse the journalled group. Nothing here reverses anything locally.
 */

export type ToastTone = "neutral" | "error";

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastOptions {
  readonly tone?: ToastTone;
  readonly durationMs?: number | undefined;
  readonly action?: ToastAction | undefined;
}

interface Toast extends ToastOptions {
  readonly id: number;
  readonly text: string;
}

interface ToastApi {
  readonly show: (text: string, options?: ToastOptions) => void;
  readonly dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DEFAULT_DURATION_MS = 4000;
/** Long enough to read the sentence and reach the button, short enough not to cover a list. */
const UNDO_DURATION_MS = 7000;

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback((text: string, options: ToastOptions = {}) => {
    const id = nextId.current++;
    // One at a time: two stacked toasts in a webview cover the list they are talking about.
    setToasts([{ id, text, ...options }]);
  }, []);

  const dismiss = useCallback(() => setToasts([]), []);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: () => void }): ReactNode {
  const current = toasts[0];

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(onDismiss, current.durationMs ?? DEFAULT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [current, onDismiss]);

  if (!current) return null;

  return (
    <div className="ip-toasts">
      <div className={`ip-toast${current.tone === "error" ? " ip-toast--error" : ""}`} role="status">
        <span className="ip-toast__text">{current.text}</span>
        {current.action ? (
          <button
            type="button"
            className="ip-toast__action"
            onClick={() => {
              haptics.impact("light");
              onDismiss();
              current.action?.onClick();
            }}
          >
            {current.action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("ToastProvider is missing above this component");
  return api;
}

export interface UndoApi {
  /**
   * Shows the confirmation for a write that just succeeded.
   *
   * Pass the `undoGroupId` the mutation answered with. `null` means the change cannot be reversed,
   * and the snackbar then carries no Undo button. `invalidate` lists the endpoints to refetch after
   * an Undo actually goes through.
   */
  readonly offer: (message: string, undoGroupId: string | null, invalidate?: readonly EndpointName[]) => void;
}

export function useUndo(): UndoApi {
  const t = useT();
  const toast = useToast();
  const invalidateRef = useRef<readonly EndpointName[]>([]);

  const cache = useQueryCache();

  const undo = useMutation("undo", {
    haptic: false,
    onSuccess: (result) => {
      if (!result.undone) {
        toast.show(t("undo.failed"), { tone: "error" });
        return;
      }
      haptics.notify("success");
      // The screens the change touched are refetched rather than patched back: an Undo restores a
      // server-side group, and guessing what that group was is how the two copies drift apart.
      cache.invalidate(invalidateRef.current);
      toast.show(t("undo.done"));
    },
    onError: () => toast.show(t("undo.failed"), { tone: "error" }),
  });

  const offer = useCallback<UndoApi["offer"]>(
    (message, undoGroupId, invalidate = []) => {
      invalidateRef.current = invalidate;
      if (!undoGroupId) {
        toast.show(message);
        return;
      }
      toast.show(message, {
        durationMs: UNDO_DURATION_MS,
        action: { label: t("undo.action"), onClick: () => void undo.mutate({ body: { groupId: undoGroupId } }) },
      });
    },
    [toast, t, undo],
  );

  return useMemo(() => ({ offer }), [offer]);
}
