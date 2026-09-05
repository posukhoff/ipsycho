import { useState, type ReactNode } from "react";
import type { MemoryRow } from "../../api/contracts.js";
import { useT } from "../../i18n/index.js";
import { useQuery } from "../../lib/index.js";
import { AsyncContent, EmptyState, Screen, ScreenHeader, Section } from "../../ui/index.js";
import { MemoryEntryRow, MemoryEntrySheet } from "../memory/memory-entry.js";

/**
 * The durable personal context — the read side of `/context`.
 *
 * These are `memory_items` of type `context`, so they are edited with the same sheet the memory
 * screen uses; the type is fixed here, because a context row that quietly became a note would
 * vanish from this screen with no way back to it. Adding to it is deliberately not a form: the
 * profile is built by talking, and the hint says so.
 */
export function ProfileScreen(): ReactNode {
  const t = useT();
  const profile = useQuery("profile");
  const [editing, setEditing] = useState<MemoryRow | null>(null);

  return (
    <Screen header={<ScreenHeader title={t("profile.title")} />}>
      <AsyncContent query={profile}>
        {(data) =>
          data.rows.length === 0 ? (
            <EmptyState icon="📇" title={t("profile.empty")} body={t("profile.hint")} />
          ) : (
            <Section footer={t("profile.hint")}>
              {data.rows.map((row) => (
                <MemoryEntryRow key={row.id} row={row} onOpen={() => setEditing(row)} />
              ))}
            </Section>
          )
        }
      </AsyncContent>

      {editing ? <MemoryEntrySheet row={editing} allowTypeChange={false} onClose={() => setEditing(null)} onReload={() => void profile.refetch()} /> : null}
    </Screen>
  );
}
