import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Client } from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";

const APP_LOCK_NAMESPACE = 424242;
const APP_LOCK_KEY = 106;

/**
 * IPsycho intentionally runs as one application process per PostgreSQL database.
 * Holding a session advisory lock makes that architecture invariant executable instead
 * of relying on deployment discipline alone. Admin/maintenance CLI processes are not
 * blocked because this provider is registered only in AppModule.
 */
@Injectable()
export class SingleInstanceService implements OnModuleInit, OnApplicationShutdown {
  private readonly client: Client;
  private locked = false;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Client({ connectionString: config.databaseUrl, application_name: "ipsycho-single-instance-lock" });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    try {
      const result = await this.client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1, $2) as locked",
        [APP_LOCK_NAMESPACE, APP_LOCK_KEY],
      );
      this.locked = result.rows[0]?.locked === true;
      if (!this.locked) throw new Error("another IPsycho app instance is already active for this PostgreSQL database");
    } catch (error) {
      await this.client.end().catch(() => undefined);
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.locked) {
      await this.client.query("select pg_advisory_unlock($1, $2)", [APP_LOCK_NAMESPACE, APP_LOCK_KEY]).catch(() => undefined);
      this.locked = false;
    }
    await this.client.end().catch(() => undefined);
  }
}
