import { Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import * as schema from "./schema.js";

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    this.db = drizzle({ client: this.pool, schema });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
