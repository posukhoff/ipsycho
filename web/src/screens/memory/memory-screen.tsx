import { useState, type ReactNode } from "react";
import type { MemoryRow } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { useInfiniteQuery, useQueryCache } from "../../lib/index.js";
import { EmptyState, ErrorState, InfiniteSentinel, Screen, ScreenHeader, Section, SkeletonList } from "../../ui/index.js";
import { MemoryEntryRow, MemoryEntrySheet } from "./memory-entry.js";

/**
 * Everything the bot remembers, newest first, sensitive entries included.
 *
 * That last part is the reason the screen exists. A sensitive fact is deliberately withheld from
 * the model's context, and until now that also kept it off every surface: the user could not see,
 * correct or delete what had been recorded about them. Here it is listed, marked, and editable —
 * with the marking spelled out, so nothing on this screen suggests the model is reading it.
 */
export function MemoryScreen(): ReactNode {
  const t = useT();
  const cache = useQueryCache();
  const list = useInfiniteQuery("memory", { items: (data) => data.rows });
  const [editing, setEditing] = useState<MemoryRow | null>(null);

  // The total count of sensitive entries is a property of the whole set, not of a page, so it comes
  // off the first page's response rather than from counting the rows on screen.
  const sensitiveCount = cache.peek("memory", { query: { page: 0 } })?.data?.sensitiveCount ?? 0;

  return (
    <Screen header={<ScreenHeader title={t("memory.title")} {...(sensitiveCount > 0 ? { subtitle: t("memory.sensitive_count", { count: sensitiveCount }) } : {})} />}>
      {list.isLoading ? <SkeletonList /> : null}
      {!list.isLoading && list.error !== undefined && list.items.length === 0 ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}
      {!list.isLoading && list.error === undefined && list.items.length === 0 ? <EmptyState icon="🧠" title={t("memory.empty")} body={t("memory.hint")} /> : null}

      {list.items.length > 0 ? (
        <Section footer={t("memory.sensitive_hint")}>
          {list.items.map((row) => (
            <MemoryEntryRow key={row.id} row={row} onOpen={() => setEditing(row)} />
          ))}
        </Section>
      ) : null}

      <InfiniteSentinel hasMore={list.hasMore} isLoading={list.isLoadingMore} onLoadMore={list.loadMore} label={t("tasks.load_more")} />

      {editing ? <MemoryEntrySheet row={editing} onClose={() => setEditing(null)} onReload={list.refresh} /> : null}
    </Screen>
  );
}
