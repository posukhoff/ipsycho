import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "./config.js";
import { DatabaseService } from "./database/database.service.js";

@Controller()
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get("health")
  async health() {
    await this.database.db.execute(sql`select 1`);
    return { status: "ok", commit: this.config.appCommit ?? null };
  }
}
