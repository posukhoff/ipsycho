import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { adminAuditLog, aiProviderConsents, aiUsage } from "../database/schema.js";

@Injectable()
export class AiRepository {
  constructor(private readonly database: DatabaseService) {}

  async recordProviderActivation(provider: string, consentVersion: string): Promise<void> {
    const metadata = JSON.stringify({ provider, consentVersion });
    const [latest] = await this.database.db
      .select({ metadata: adminAuditLog.metadata })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "ai:provider-active"))
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(1);
    if (latest?.metadata === metadata) return;
    await this.database.db.insert(adminAuditLog).values({ action: "ai:provider-active", metadata });
  }

  async hasConsent(userId: string, provider: string, consentVersion: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: aiProviderConsents.id })
      .from(aiProviderConsents)
      .where(
        and(
          eq(aiProviderConsents.userId, userId),
          eq(aiProviderConsents.provider, provider),
          eq(aiProviderConsents.consentVersion, consentVersion),
          isNull(aiProviderConsents.revokedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async grantConsent(userId: string, provider: string, consentVersion: string): Promise<void> {
    await this.database.db
      .insert(aiProviderConsents)
      .values({ userId, provider, consentVersion, revokedAt: null })
      .onConflictDoUpdate({
        target: [aiProviderConsents.userId, aiProviderConsents.provider, aiProviderConsents.consentVersion],
        set: { grantedAt: new Date(), revokedAt: null },
      });
  }

  async revokeConsent(userId: string, provider: string, consentVersion: string): Promise<void> {
    await this.database.db
      .update(aiProviderConsents)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(aiProviderConsents.userId, userId),
          eq(aiProviderConsents.provider, provider),
          eq(aiProviderConsents.consentVersion, consentVersion),
          isNull(aiProviderConsents.revokedAt),
        ),
      );
  }

  async recordUsage(input: {
    workspaceId: string;
    userId: string;
    provider: string;
    model: string;
    providerRequestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    attempts?: number;
    latencyMs: number;
    status: string;
    pricingRevision?: string;
    estimatedCostUsd?: number;
  }): Promise<void> {
    await this.database.db.insert(aiUsage).values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      latencyMs: input.latencyMs,
      status: input.status,
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.cachedInputTokens !== undefined ? { cachedInputTokens: input.cachedInputTokens } : {}),
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      ...(input.pricingRevision ? { pricingRevision: input.pricingRevision } : {}),
      ...(input.estimatedCostUsd !== undefined ? { estimatedCostUsd: input.estimatedCostUsd.toFixed(6) } : {}),
    });
  }

  /** Provider requests, not AiService calls: a repaired turn counts twice against the hourly limit. */
  async countCallsSince(userId: string, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`coalesce(sum(${aiUsage.attempts}), 0)::int` })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, since)));
    return row?.count ?? 0;
  }

  /** Estimated spend since `since` for every user with usage, in one grouped query. */
  async monthlySpendByUser(since: Date): Promise<Map<string, number>> {
    const rows = await this.database.db
      .select({ userId: aiUsage.userId, total: sql<string>`coalesce(sum(${aiUsage.estimatedCostUsd}), 0)::text` })
      .from(aiUsage)
      .where(gte(aiUsage.createdAt, since))
      .groupBy(aiUsage.userId);
    return new Map(rows.map((row) => [row.userId, Number(row.total)]));
  }

  async monthlySpendUsd(userId: string, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ total: sql<string>`coalesce(sum(${aiUsage.estimatedCostUsd}), 0)::text` })
      .from(aiUsage)
      .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, since)));
    return Number(row?.total ?? 0);
  }
}
