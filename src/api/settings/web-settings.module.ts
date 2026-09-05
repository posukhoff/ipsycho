import { Module } from "@nestjs/common";

/**
 * Group 3: reminders, settings and memory.
 *
 * Reserved endpoints (`ENDPOINTS`, `group: 3`):
 * - `GET    /api/v1/reminders`
 * - `POST   /api/v1/reminders/:deliveryId/{snooze,repeat}`
 * - `DELETE /api/v1/reminders/:deliveryId`
 * - `GET    /api/v1/settings`, `PATCH /api/v1/settings`
 * - `GET    /api/v1/settings/timezones`          — the picker's search
 * - `GET    /api/v1/memory`, `PATCH /api/v1/memory/:id`, `DELETE /api/v1/memory/:id`
 * - `GET    /api/v1/profile`
 * - `POST   /api/v1/chat/history/clear`
 * - `GET    /api/v1/consent`, `POST /api/v1/consent/{grant,revoke}`
 * - `POST   /api/v1/account/delete`
 *
 * Account deletion lives here rather than in its own group: it is the settings screen's last row,
 * and it is the one endpoint with no counterpart — restore stays a chat command, because the guard
 * refuses a deletion-pending user by design.
 *
 * This module also owns `src/api/reminders/**` and `src/api/memory/**`.
 */
@Module({})
export class WebSettingsModule {}
