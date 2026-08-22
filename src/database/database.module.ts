import { Module } from "@nestjs/common";
import { ConfigModule } from "../config.module.js";
import { DatabaseService } from "./database.service.js";

@Module({ imports: [ConfigModule], providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
