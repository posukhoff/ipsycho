import { API_PREFIX } from "../contracts/index.js";

/**
 * The `/api/v1` prefix, as a controller path.
 *
 * `@Controller(apiRoute("tasks"))` rather than `app.setGlobalPrefix("api/v1")`, because a global
 * prefix would move `/health` and `/ready` too. Those two are named by Docker's healthcheck and by
 * the Caddyfile that must *refuse* them from the internet, and neither would notice the change
 * until production.
 *
 * One rule about status codes, since the contract pins none and Nest's default would have decided
 * it per controller: **every `POST` here answers `200`**, which is why each one carries
 * `@HttpCode(200)`. None of them creates a resource at a new address — there is no `Location` to
 * send, and `POST /undo`, `POST /account/delete` and `POST /week/pick/:taskId` are commands whose
 * body is the state the client re-renders. `201` on those is a lie about what happened, and a
 * surface where two of fourteen writes answered `200` and the rest `201` is a distinction no
 * client could act on.
 */
export function apiRoute(segment = ""): string {
  const trimmed = segment.replace(/^\/+|\/+$/gu, "");
  return trimmed ? `${API_PREFIX}/${trimmed}` : API_PREFIX;
}
