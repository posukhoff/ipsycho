import { Module } from "@nestjs/common";
import { ConfigModule } from "../config.module.js";
import { JobQueueService } from "./job-queue.service.js";

@Module({ imports: [ConfigModule], providers: [JobQueueService], exports: [JobQueueService] })
export class QueueModule {}
