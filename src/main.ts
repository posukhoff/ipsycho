import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { APP_CONFIG, type AppConfig } from "./config.js";
import { safeError } from "./observability/safe-error.js";

let fatalShutdownRequested = false;

function stopAfterFatalError(event: "Unhandled promise rejection" | "Uncaught application exception", error: unknown): void {
  console.error(event, { error: safeError(error) });
  if (fatalShutdownRequested) return;
  fatalShutdownRequested = true;
  process.exitCode = 1;
  setImmediate(() => process.kill(process.pid, "SIGTERM"));
}

process.on("unhandledRejection", (reason) => stopAfterFatalError("Unhandled promise rejection", reason));
process.on("uncaughtException", (error) => stopAfterFatalError("Uncaught application exception", error));

const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
app.enableShutdownHooks();
const config = app.get<AppConfig>(APP_CONFIG);
await app.listen(config.port, config.host);
console.log(`IPsycho health endpoint: http://${config.host}:${config.port}/health`);
