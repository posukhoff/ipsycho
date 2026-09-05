import { Component, type ErrorInfo, type ReactNode } from "react";
import { createTranslator, resolveLocale } from "../i18n/index.js";
import { telegramLanguageCode } from "../lib/telegram.js";

/**
 * The last line of defence.
 *
 * A thrown render is a bug in a screen, not a state the user can act on, so this says one sentence
 * and offers a reload. What it must not do is print the error: a message can carry an id or a task
 * title, and this app runs on a screen somebody may be sharing. The console gets the error in a dev
 * build only, which is where a stack trace is any use.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const t = createTranslator(resolveLocale(null, telegramLanguageCode()));
    return (
      <div className="ip-screen">
        <div className="ip-screen__body">
          <div className="ip-empty">
            <div className="ip-empty__icon">💥</div>
            <h2 className="ip-empty__title">{t("error.boundary_title")}</h2>
            <p className="ip-empty__body">{t("error.boundary_body")}</p>
            <button type="button" className="ip-button ip-button--primary" onClick={() => window.location.reload()}>
              {t("error.retry")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
