import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { PgBoss } from "pg-boss";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { safeError } from "../observability/safe-error.js";

/**
 * One pg-boss instance for the whole process.
 *
 * Every delivery queue uses the `short` policy: at most one job in the `created` state per
 * `singletonKey`. With the default `standard` policy pg-boss keeps no uniqueness index at
 * all, so each reconciliation pass would add another job for the same delivery. The policy
 * is immutable once a queue exists; a queue found with a different policy is dropped and
 * recreated. Its queued jobs are lost, which is safe because the delivery tables are the
 * source of truth and the owning service re-enqueues pending rows on boot.
 */
export const QUEUE_POLICY = "short";
export const JOB_EXPIRE_SECONDS = 180;

export type JobHandler<T> = (data: T) => Promise<void>;

@Injectable()
export class JobQueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly boss: PgBoss;
  private started = false;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.boss = new PgBoss({ connectionString: config.databaseUrl, max: 5, application_name: "ipsycho-jobs" });
    this.boss.on("error", (error) => console.error("pg-boss error", { error: safeError(error) }));
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    this.started = true;
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }

  /** Creates the queue and its dead-letter queue, replacing a queue created under another policy. */
  async ensureQueue(name: string, options: { retryLimit: number; retryDelaySeconds: number }): Promise<void> {
    const deadLetter = `${name}-dead`;
    const existing = await this.boss.getQueue(name);
    if (existing && existing.policy !== QUEUE_POLICY) {
      console.warn("recreating queue under the short policy", { queue: name, previousPolicy: existing.policy });
      await this.boss.deleteQueue(name);
    }
    if (!(await this.boss.getQueue(deadLetter))) {
      await this.boss.createQueue(deadLetter, { policy: QUEUE_POLICY, retryLimit: 0 });
    }
    if (!existing || existing.policy !== QUEUE_POLICY) {
      await this.boss.createQueue(name, {
        policy: QUEUE_POLICY,
        deadLetter,
        expireInSeconds: JOB_EXPIRE_SECONDS,
        retryLimit: options.retryLimit,
        retryDelay: options.retryDelaySeconds,
        retryBackoff: true,
      });
    }
  }

  /** Returns the job id, or null when a job with the same singleton key is already queued. */
  async send<T extends object>(name: string, data: T, options: { startAfter: Date; singletonKey: string }): Promise<string | null> {
    return this.boss.send(name, data, { startAfter: options.startAfter, singletonKey: options.singletonKey });
  }

  async work<T extends object>(name: string, handler: JobHandler<T>): Promise<void> {
    await this.boss.work<T>(name, { batchSize: 1, localConcurrency: 5, pollingIntervalSeconds: 1 }, async ([job]) => {
      if (job) await handler(job.data);
    });
  }

  /** Jobs that exhausted their retries and were copied to the dead-letter queue. */
  async deadLetterCount(name: string): Promise<number> {
    const deadLetter = `${name}-dead`;
    const stats = await this.boss.getQueueStats(deadLetter);
    return stats.find((queue) => queue.name === deadLetter)?.queuedCount ?? 0;
  }
}
