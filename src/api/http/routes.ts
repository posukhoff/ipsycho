import { API_PREFIX } from "../contracts/index.js";

/**
 * The `/api/v1` prefix, as a controller path.
 *
 * `@Controller(apiRoute("tasks"))` rather than `app.setGlobalPrefix("api/v1")`, because a global
 * prefix would move `/health` and `/ready` too. Those two are named by Docker's healthcheck and by
 * the Caddyfile that must *refuse* them from the internet, and neither would notice the change
 * until production.
 */
export function apiRoute(segment = ""): string {
  const trimmed = segment.replace(/^\/+|\/+$/gu, "");
  return trimmed ? `${API_PREFIX}/${trimmed}` : API_PREFIX;
}
