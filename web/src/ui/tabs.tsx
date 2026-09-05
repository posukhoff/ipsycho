import type { ReactNode } from "react";
import { haptics } from "../lib/telegram.js";
import { Badge } from "./primitives.js";

/**
 * The scope tabs of the task and goal lists.
 *
 * The count comes from the server (`counts` on the list response) rather than from the rows on
 * screen: a tab shows what the *other* filter holds, which is the whole reason it is worth a badge.
 * A client that counted its own rows would show the size of the current page instead.
 */

export interface TabItem<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  readonly count?: number | undefined;
  /** Renders the badge in the danger tone: the overdue tab. */
  readonly alarming?: boolean | undefined;
}

export function Tabs<Value extends string>({ value, items, onChange }: { value: Value; items: readonly TabItem<Value>[]; onChange: (value: Value) => void }): ReactNode {
  return (
    <div className="ip-tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={`ip-tab${item.value === value ? " ip-tab--active" : ""}`}
          onClick={() => {
            if (item.value === value) return;
            haptics.select();
            onChange(item.value);
          }}
        >
          {item.label}
          {item.count ? <Badge tone={item.alarming ? "danger" : "neutral"}>{item.count}</Badge> : null}
        </button>
      ))}
    </div>
  );
}
