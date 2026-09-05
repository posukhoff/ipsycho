import { ENDPOINTS, type EndpointName } from "../api/contracts.js";
import { answer, type MockRequest } from "./answers.js";

/**
 * The mock backend, reached only when `VITE_API_MOCK=1`.
 *
 * `npm -w @ipsycho/web run dev` with the flag set renders every screen with no Postgres, no bot
 * token and no `initData` — which is what lets groups 5–8 start the moment this file exists instead
 * of waiting for groups 1–4.
 *
 * Every answer is parsed against the endpoint's own response schema before it is returned. That
 * turns a drifted fixture into a loud failure in the client the frontend agent is already looking
 * at, rather than a screen that renders happily against a shape the server will never send.
 *
 * The answers themselves are `./answers.ts`, which knows nothing about the schemas — that split is
 * what lets `tests/app/webapp-mocks.test.mjs` run the same parse in CI, where four drifted fixtures
 * were previously found by reading them.
 */

const LATENCY_MS = 120;

export type { MockRequest } from "./answers.js";

export async function mockRequest(name: EndpointName, request: MockRequest = {}): Promise<unknown> {
  // A little latency on purpose: a screen that only ever saw an instant answer has no loading state.
  await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  return ENDPOINTS[name].response.parse(answer(name, request));
}
