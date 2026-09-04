import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "./config.js";
import { DatabaseService } from "./database/database.service.js";
import { loopHealth } from "./observability/loop-health.js";

const READY_DB_TIMEOUT_MS = 2000;

@Controller()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** The process is up. Never touches the database, so an exhausted pool cannot make it hang. */
  @Get("health")
  health() {
    return { status: "ok", commit: this.config.appCommit ?? null };
  }

  /**
   * The process can do useful work: the database answers within two seconds and none of the
   * periodic loops has gone silent. Docker's healthcheck polls this one.
   */
  @Get("ready")
  async ready() {
    const now = Date.now();
    const database = await this.probeDatabase();
    const loops = loopHealth.snapshot(now);
    const stale = loops.filter((loop) => loop.stale).map((loop) => loop.name);
    const body = { status: database === "ok" && !stale.length ? "ok" : "degraded", commit: this.config.appCommit ?? null, database, staleLoops: stale, loops };
    if (body.status !== "ok") throw new ServiceUnavailableException(body);
    return body;
  }

  private async probeDatabase(): Promise<"ok" | "timeout" | "error"> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), READY_DB_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.database.db.execute(sql`select 1`).then(() => "ok" as const), timeout]);
    } catch {
      return "error";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
