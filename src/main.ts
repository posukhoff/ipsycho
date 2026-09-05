import "dotenv/config";
import "reflect-metadata";
import { existsSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { APP_CONFIG, configWarnings, type AppConfig } from "./config.js";
import { safeError } from "./observability/safe-error.js";
import { logger } from "./observability/logger.js";

let fatalShutdownRequested = false;

function stopAfterFatalError(event: "Unhandled promise rejection" | "Uncaught application exception", error: unknown): void {
  logger.error(event, { error: safeError(error) });
  if (fatalShutdownRequested) return;
  fatalShutdownRequested = true;
  process.exitCode = 1;
  setImmediate(() => process.kill(process.pid, "SIGTERM"));
}

process.on("unhandledRejection", (reason) => stopAfterFatalError("Unhandled promise rejection", reason));
process.on("uncaughtException", (error) => stopAfterFatalError("Uncaught application exception", error));

/**
 * One proxy hop: Caddy, on the compose network. Express then reads `req.ip` from the last entry of
 * `X-Forwarded-For` rather than trusting the whole chain.
 *
 * Both extremes are a real bug. Left at the default, every request looks like it came from Caddy's
 * container address, so the IP limiter shares one bucket and an unauthenticated attacker can lock
 * out the only legitimate user. Set to `true`, the client's own header is believed and the limiter
 * is bypassed by adding a line to it. Caddy discards a client-supplied `X-Forwarded-For` unless the
 * sender is in `trusted_proxies`, and this number says how much of what survives to believe.
 */
const TRUSTED_PROXY_HOPS = 1;

/** 64 KB. The largest legitimate request is a task with a 20-item checklist; this is far above it. */
const JSON_BODY_LIMIT = "64kb";

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ["log", "warn", "error"] });
app.enableShutdownHooks();
const config = app.get<AppConfig>(APP_CONFIG);
for (const warning of configWarnings(config)) logger.warn("configuration", { warning });

if (config.webAppEnabled) {
  app.set("trust proxy", TRUSTED_PROXY_HOPS);
  app.useBodyParser("json", { limit: JSON_BODY_LIMIT });
  // No `enableCors()`: the client is served from this same origin and carries no cookie, so there is
  // nothing for CORS to permit and every relaxation would only widen who can call the API.
  if (existsSync(config.webAppDistPath)) {
    app.useStaticAssets(config.webAppDistPath, {
      prefix: "/app",
      index: "index.html",
      redirect: true,
      setHeaders: (response, path) => {
        // Vite fingerprints everything but the entry document, so the document is the only file
        // whose URL can be stale. Caching it would pin a deployed client to an old contract.
        response.setHeader("Cache-Control", path.endsWith(".html") ? "no-store" : "public, max-age=31536000, immutable");
      },
    });
  } else {
    logger.warn("web client is not built; /app will not answer", { path: config.webAppDistPath });
  }
}

await app.listen(config.port, config.host);
logger.info("IPsycho listening", { host: config.host, port: config.port, webApp: config.webAppEnabled });
