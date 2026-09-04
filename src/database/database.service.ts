import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { safeError } from "../observability/safe-error.js";
import * as schema from "./schema.js";
import { logger } from "../observability/logger.js";

/** Upper bound for one statement; a runaway query must not hold a pooled connection indefinitely. */
export const STATEMENT_TIMEOUT_MS = 30_000;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      application_name: "ipsycho-app",
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: STATEMENT_TIMEOUT_MS,
    });
    // pg emits 'error' for an idle client whose connection dropped (PostgreSQL restart, a NAT
    // timeout). Without a listener Node treats it as an uncaught exception and the process exits.
    this.pool.on("error", (error) => logger.error("postgres pool error on an idle connection", { error: safeError(error) }));
    this.db = drizzle({ client: this.pool, schema });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
