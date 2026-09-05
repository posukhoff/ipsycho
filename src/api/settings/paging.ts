import type { PageInfo, PageQuery } from "../contracts/index.js";

/**
 * Offset paging over a list the domain already read whole.
 *
 * The reminder and memory reads both return a bounded set in one query — the domain has no offset
 * parameter for either, and inventing one in the API would mean a second query shape with its own
 * idea of ordering. So the window is cut here, over the rows the service returned, which is also
 * what `paginate` in `screens.service.ts` does for the bot's eight-line pages.
 *
 * A page past the end clamps to the last page rather than answering an empty list: the client
 * scrolls an infinite list, and an empty page in the middle of one reads as «nothing left».
 */
export function paginate<T>(all: readonly T[], query: PageQuery): { rows: T[]; page: PageInfo } {
  const pageSize = query.pageSize;
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  const page = Math.min(query.page, pages - 1);
  const offset = page * pageSize;
  const rows = all.slice(offset, offset + pageSize);
  return { rows, page: { page, pages, pageSize, total: all.length, hasMore: offset + rows.length < all.length } };
}
