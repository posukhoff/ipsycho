import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Client } from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { safeError } from "../observability/safe-error.js";
import { logger } from "../observability/logger.js";

export const APP_LOCK_NAMESPACE = 424242;
export const APP_LOCK_KEY = 106;
const LOCK_CHECK_INTERVAL_MS = 30_000;

type LockClient = Pick<Client, "connect" | "query" | "end" | "on">;

/**
 * IPsycho intentionally runs as one application process per PostgreSQL database.
 * Holding a session advisory lock makes that architecture invariant executable instead
 * of relying on deployment discipline alone. Admin/maintenance CLI processes are not
 * blocked because this provider is registered only in AppModule.
 *
 * The lock lives on one dedicated session. If that session dies, PostgreSQL releases the lock
 * while this process keeps running, and a second instance could start; the periodic check
 * turns that into a deliberate exit so the supervisor restarts one process, not two.
 */
@Injectable()
export class SingleInstanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly client: LockClient;
  private locked = false;
  private checkTimer?: NodeJS.Timeout;
  private readonly onLost: (reason: string) => void;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Client({ connectionString: config.databaseUrl, application_name: "ipsycho-single-instance-lock" });
    this.onLost = (reason) => {
      logger.error("single-instance lock lost; stopping so exactly one process runs", { reason });
      process.exitCode = 1;
      process.kill(process.pid, "SIGTERM");
    };
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.client.on("error", (error) => {
      if (!this.locked) return;
      this.locked = false;
      logger.error("single-instance lock connection failed", { error: safeError(error) });
      this.onLost("connection error");
    });
    try {
      const result = await this.client.query<{ locked: boolean }>("select pg_try_advisory_lock($1, $2) as locked", [APP_LOCK_NAMESPACE, APP_LOCK_KEY]);
      this.locked = result.rows[0]?.locked === true;
      if (!this.locked) throw new Error("another IPsycho app instance is already active for this PostgreSQL database");
    } catch (error) {
      await this.client.end().catch(() => undefined);
      throw error;
    }
    this.checkTimer = setInterval(() => void this.verifyLock(), LOCK_CHECK_INTERVAL_MS);
    this.checkTimer.unref();
  }

  /** True while this session still holds the lock; false ends the process. */
  async verifyLock(): Promise<boolean> {
    if (!this.locked) return false;
    try {
      const result = await this.client.query<{ held: boolean }>(
        "select exists(select 1 from pg_locks where locktype = 'advisory' and classid = $1 and objid = $2 and pid = pg_backend_pid() and granted) as held",
        [APP_LOCK_NAMESPACE, APP_LOCK_KEY],
      );
      if (result.rows[0]?.held === true) return true;
      this.locked = false;
      this.onLost("lock no longer held by this session");
      return false;
    } catch (error) {
      logger.error("single-instance lock check failed", { error: safeError(error) });
      return true;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.locked) {
      await this.client.query("select pg_advisory_unlock($1, $2)", [APP_LOCK_NAMESPACE, APP_LOCK_KEY]).catch(() => undefined);
      this.locked = false;
    }
    await this.client.end().catch(() => undefined);
  }
}
