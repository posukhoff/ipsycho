import type { PageInfo } from "../contracts/index.js";

/**
 * `PageInfo` from what `paginate` in `src/core/task-list-view.ts` already worked out.
 *
 * Every paged endpoint reads its rows whole — the domain has no offset parameter for any of these
 * queries, and inventing one in the API would mean a second query shape with its own idea of
 * ordering — cuts the window with `paginate`, and then has to say the same five numbers. Four
 * endpoints said them four slightly different ways, one of which computed `hasMore` from `rest`
 * and another from the page arithmetic.
 *
 * `paginate` clamps a page past the end to the last page rather than answering an empty list: the
 * client scrolls an infinite list, and an empty page in the middle of one reads as «nothing left».
 */
export function pageInfo(view: { page: number; pages: number }, total: number, pageSize: number): PageInfo {
  return { page: view.page, pages: view.pages, pageSize, total, hasMore: (view.page + 1) * pageSize < total };
}
