import { Controller, Get } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DatabaseService } from "./database/database.service.js";

@Controller()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get("health")
  async health() {
    await this.database.db.execute(sql`select 1`);
    return { status: "ok" };
  }
}
