import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { ApiModule } from "../../dist/api/api.module.js";
import { ApiExceptionFilter } from "../../dist/api/http/api-exception.filter.js";
import { DomainRuleError } from "../../dist/core/errors.js";
import { AppModule } from "../../dist/app.module.js";
import { HealthController } from "../../dist/health.controller.js";
import { API_PREFIX, ENDPOINTS } from "../../dist/api/contracts/index.js";
import { isWebAppEnabled, loadConfig } from "../../dist/config.js";

/**
 * `WEBAPP_ENABLED=false` is the whole of rollout step 1: groups 0–9 merge to main, and production
 * behaviour must be unchanged until someone deliberately turns the flag on. These are the checks
 * that make that claim testable rather than asserted.
 */

const base = {
  DATABASE_URL: "postgres://x:y@localhost:5432/db",
  TELEGRAM_BOT_TOKEN: "123456:telegram-token-with-enough-length",
  AI_PROVIDER: "openai",
  AI_MODEL: "gpt-test",
  OPENAI_API_KEY: "sk-openai-key-with-enough-length",
};

test("the Mini App is off unless the flag says otherwise, and cannot be on without a URL", () => {
  const off = loadConfig(base);
  assert.equal(off.webAppEnabled, false);
  assert.equal(off.webAppUrl, undefined);

  assert.equal(loadConfig({ ...base, WEBAPP_ENABLED: "false" }).webAppEnabled, false);
  assert.equal(loadConfig({ ...base, WEBAPP_ENABLED: "" }).webAppEnabled, false);
  // A typo must not read as "on": anything but the two literals is a configuration error.
  assert.throws(() => loadConfig({ ...base, WEBAPP_ENABLED: "yes" }), /WEBAPP_ENABLED/);

  assert.throws(() => loadConfig({ ...base, WEBAPP_ENABLED: "true" }), /WEBAPP_URL/);
  const on = loadConfig({ ...base, WEBAPP_ENABLED: "true", WEBAPP_URL: "https://app.example.com/app" });
  assert.equal(on.webAppEnabled, true);
  assert.equal(on.webAppUrl, "https://app.example.com/app");
});

test("a Mini App URL is https, or http only on a loopback development host", () => {
  const withUrl = (url) => () => loadConfig({ ...base, WEBAPP_ENABLED: "true", WEBAPP_URL: url });
  assert.throws(withUrl("http://app.example.com/app"), /WEBAPP_URL/);
  assert.doesNotThrow(withUrl("http://localhost:5173/app"));
  assert.doesNotThrow(withUrl("https://app.example.com/app"));
});

test("the flag is readable without validating the rest of the environment", () => {
  // `AppModule`'s imports are evaluated before any provider exists, so this is the one answer
  // `ApiModule.register` can ask for. It must agree with `loadConfig` and must not throw on a
  // half-configured environment.
  assert.equal(isWebAppEnabled({}), false);
  assert.equal(isWebAppEnabled({ WEBAPP_ENABLED: "false" }), false);
  assert.equal(isWebAppEnabled({ WEBAPP_ENABLED: "true" }), true);
  assert.equal(isWebAppEnabled({ WEBAPP_ENABLED: "true" }), loadConfig({ ...base, WEBAPP_ENABLED: "true", WEBAPP_URL: "https://a.example.com" }).webAppEnabled);
});

test("with the flag off ApiModule contributes nothing at all", () => {
  const off = ApiModule.register(false);
  assert.deepEqual(off, { module: ApiModule });
  assert.equal(off.imports, undefined);
  assert.equal(off.controllers, undefined);
  assert.equal(off.providers, undefined);

  const on = ApiModule.register(true);
  assert.equal(on.imports.length, 4, "auth, tasks+goals, reminders+settings+memory, week");
  assert.equal(on.providers.length, 1, "the API exception filter");
});

test("the error envelope covers /api/v1 and nothing else", () => {
  // The filter is registered through APP_FILTER, which is application-wide however narrowly it is
  // declared. Without the path check, turning the flag on would change what /ready answers to
  // Docker's healthcheck — a regression that only shows up in production.
  const replies = [];
  const adapterHost = {
    httpAdapter: {
      getRequestUrl: (request) => request.url,
      reply: (response, body, status) => replies.push({ response, body, status }),
    },
  };
  const filter = new ApiExceptionFilter(adapterHost);
  let delegated = 0;
  Object.getPrototypeOf(Object.getPrototypeOf(filter)).catch = () => void (delegated += 1);

  filter.catch(new Error("boom"), hostFor({ url: "/ready" }));
  assert.equal(delegated, 1, "a non-API path keeps Nest's own error shape");
  assert.equal(replies.length, 0);

  filter.catch(new Error("boom"), hostFor({ url: "/api/v1/tasks?scope=week" }));
  assert.equal(delegated, 1);
  assert.deepEqual(replies.at(-1).body, { error: { code: "internal", message: "Internal error" } });
  assert.equal(replies.at(-1).status, 500);

  filter.catch(new DomainRuleError("timezone is not a valid IANA timezone", "timezone"), hostFor({ url: "/api/v1/settings" }));
  assert.deepEqual(replies.at(-1).body, {
    error: { code: "domain_rule", message: "The change is not allowed by a domain rule", details: { kind: "rule", rule: "timezone" } },
  });

  // The thrown message is logged, never returned: it is the one string an attacker can influence.
  const bodies = JSON.stringify(replies.map((reply) => reply.body));
  assert.ok(!bodies.includes("boom"));
  assert.ok(!bodies.includes("IANA"));
});

function hostFor(request) {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) };
}

test("the application graph with the flag off exposes only the health controller", () => {
  // The test process has no WEBAPP_ENABLED, so `AppModule` was built with the flag off.
  const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) ?? [];
  assert.deepEqual(controllers, [HealthController]);

  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? [];
  const api = imports.find((entry) => entry && entry.module === ApiModule);
  assert.ok(api, "ApiModule is registered so that turning the flag on needs no edit here");
  assert.deepEqual(api, { module: ApiModule }, "and contributes nothing while the flag is off");
});

test("every reserved endpoint sits under the versioned prefix and names its owning group", () => {
  const paths = new Set();
  for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
    assert.ok(endpoint.path.startsWith("/"), `${name} path must be rooted`);
    assert.ok([1, 2, 3, 4].includes(endpoint.group), `${name} must name the group that implements it`);
    assert.ok(endpoint.response, `${name} must declare a response schema`);
    const key = `${endpoint.method} ${endpoint.path}`;
    assert.ok(!paths.has(key), `${key} is declared twice`);
    paths.add(key);
  }
  assert.equal(API_PREFIX, "/api/v1");
  // A global prefix would move /health and /ready too, which Docker and the Caddyfile both name.
  assert.ok(!API_PREFIX.includes("health"));
});

/**
 * The presentation-layer rule from design.md § 5, enforced rather than reviewed. A controller may
 * call a service and map the result; the moment it reaches for a repository or drizzle, the API has
 * become a second domain with its own idea of workspace scoping.
 */
test("nothing under src/api touches the database", () => {
  const offenders = [];
  for (const file of walk("src/api")) {
    // Every form that names a module: `from "x"`, a bare side-effect `import "x"`, and a dynamic
    // `import("x")` — in either quote style. A grep that only knew `from "…"` would pass a file
    // that reached for drizzle through `await import(...)`, which is the shape a "just this once"
    // edit takes. Comments are stripped so the prose that states this rule is not itself a hit.
    const source = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/gu)) {
      if (/^drizzle-orm/u.test(specifier)) offenders.push(`${file}: imports drizzle-orm`);
      if (/\.repository(\.js)?$/u.test(specifier)) offenders.push(`${file}: imports a repository`);
      if (/(^|\/)database\//u.test(specifier)) offenders.push(`${file}: imports the database module`);
    }
  }
  assert.deepEqual(offenders, []);
});

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx|mts|mjs|js)$/u.test(path)) out.push(path);
  }
  return out;
}
