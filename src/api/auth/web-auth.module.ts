import { Module } from "@nestjs/common";

/**
 * Group 1: `initData` authentication.
 *
 * Reserved endpoints:
 * - `GET /api/v1/me` — the bootstrap call (`ENDPOINTS.me`).
 *
 * Everything else this module owns is infrastructure the other three modules consume: the guard
 * that verifies the Telegram signature and resolves the user through `AccessService`, the two
 * rate limiters, and whatever request-scoped state (`{ access, settings, locale }`) the presenters
 * read. Exporting those is this module's job — `ApiModule` imports it first for that reason.
 *
 * Empty on purpose: `api.module.ts` is group 0's file and imports this from the start, so group 1
 * never edits it.
 */
@Module({})
export class WebAuthModule {}
