import type { ContextService } from "../../context/context.service.js";
import type { MemoryRow } from "../contracts/index.js";

/**
 * One `memory_items` row, as the memory and profile screens read it.
 *
 * The marking travels with the fact. A sensitive entry is kept out of the model's retrieved context
 * — that is the point of the flag and it stays true — but keeping it off the *screen* as well meant
 * the user could not see, correct or delete what the bot had been told to remember. This is the one
 * surface that shows all of it, and `sensitive` is what makes the client mask it until asked and
 * demand a confirmation before writing it.
 */
export type MemoryItem = NonNullable<Awaited<ReturnType<ContextService["findMemory"]>>>;

export function presentMemory(row: MemoryItem): MemoryRow {
  return {
    id: row.id,
    version: row.version,
    type: row.type,
    content: row.content,
    sensitive: row.sensitive,
    // A token — `ai`, `user_explicit`, `onboarding` — rendered by the client, never a sentence.
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
