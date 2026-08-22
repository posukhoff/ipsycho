import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { AccessService } from "./access.service.js";

@Module({ imports: [DatabaseModule], providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
