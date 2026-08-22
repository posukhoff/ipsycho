import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { ContextActionsRepository } from "./context-actions.repository.js";
import { ContextRepository } from "./context.repository.js";
import { ContextService } from "./context.service.js";

@Module({
  imports: [DatabaseModule],
  providers: [ContextRepository, ContextActionsRepository, ContextService],
  exports: [ContextRepository, ContextActionsRepository, ContextService],
})
export class ContextModule {}
