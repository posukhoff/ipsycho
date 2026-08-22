import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { MessagesRepository } from "./messages.repository.js";

@Module({
  imports: [DatabaseModule],
  providers: [MessagesRepository],
  exports: [MessagesRepository],
})
export class MessagesModule {}
