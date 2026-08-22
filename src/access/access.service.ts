import { Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { adminAuditLog, briefingDeliveries, registrationInvites, reminderDeliveries, userSettings, users, workspaceMembers, workspaces } from "../database/schema.js";

const DELETION_GRACE_MS = 14 * 24 * 60 * 60_000;
const REGISTRATION_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

@Injectable()
export class AccessService {
  constructor(private readonly database: DatabaseService) {}

  async resolveActiveUser(telegramUserId: number) {
    const rows = await this.database.db
      .select({ user: users, workspaceId: workspaceMembers.workspaceId })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .innerJoin(workspaces, and(eq(workspaces.id, workspaceMembers.workspaceId), eq(workspaces.ownerUserId, users.id), eq(workspaces.kind, "personal")))
      .where(and(eq(users.telegramUserId, telegramUserId), eq(users.status, "active")))
      .limit(1);
    return rows[0] ?? null;
  }

  async resolveUserAnyStatus(telegramUserId: number) {
    const rows = await this.database.db
      .select({ user: users, workspaceId: workspaceMembers.workspaceId })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .innerJoin(workspaces, and(eq(workspaces.id, workspaceMembers.workspaceId), eq(workspaces.ownerUserId, users.id), eq(workspaces.kind, "personal")))
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);
    return rows[0] ?? null;
  }

  async getUserSettings(userId: string) {
    const [settings] = await this.database.db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1);
    return settings ?? null;
  }

  async addUser(telegramUserId: number): Promise<string> {
    return this.database.db.transaction(async (tx) => {
      const existing = await tx.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
      if (existing[0]) throw new Error("user already exists");
      const [user] = await tx.insert(users).values({ telegramUserId }).returning();
      if (!user) throw new Error("failed to create user");
      const [workspace] = await tx.insert(workspaces).values({ ownerUserId: user.id, kind: "personal" }).returning();
      if (!workspace) throw new Error("failed to create workspace");
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "owner" });
      await tx.insert(userSettings).values({ userId: user.id });
      await tx.insert(adminAuditLog).values({ action: "users:add", targetUserId: user.id });
      return user.id;
    });
  }

  /** Creates a one-time link token. Redemption never joins the inviter's workspace. */
  async createRegistrationInvite(createdByUserId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(now.getTime() + REGISTRATION_INVITE_TTL_MS);
    const token = randomBytes(32).toString("base64url");
    await this.database.db.insert(registrationInvites).values({ token, createdByUserId, expiresAt });
    await this.database.db.insert(adminAuditLog).values({ action: "registration-invite:create", targetUserId: createdByUserId });
    return { token, expiresAt };
  }

  /**
   * Redeems a link exactly once and creates a new owner + personal workspace in
   * the same transaction. Existing accounts cannot consume or repurpose a link.
   */
  async registerFromInvite(token: string, telegramUserId: number, now = new Date()): Promise<{ kind: "created" } | { kind: "invalid" | "already_registered" }> {
    if (!/^[A-Za-z0-9_-]{32,64}$/u.test(token)) return { kind: "invalid" };
    return this.database.db.transaction(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
      if (existing[0]) return { kind: "already_registered" as const };

      const [invite] = await tx.update(registrationInvites)
        .set({ usedAt: now })
        .where(and(eq(registrationInvites.token, token), isNull(registrationInvites.usedAt), gt(registrationInvites.expiresAt, now)))
        .returning({ id: registrationInvites.id, createdByUserId: registrationInvites.createdByUserId });
      if (!invite) return { kind: "invalid" as const };

      const [user] = await tx.insert(users).values({ telegramUserId }).returning();
      if (!user) throw new Error("failed to create invited user");
      const [workspace] = await tx.insert(workspaces).values({ ownerUserId: user.id, kind: "personal" }).returning();
      if (!workspace) throw new Error("failed to create invited workspace");
      await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: user.id, role: "owner" });
      await tx.insert(userSettings).values({ userId: user.id });
      await tx.update(registrationInvites).set({ usedByUserId: user.id }).where(eq(registrationInvites.id, invite.id));
      await tx.insert(adminAuditLog).values({ action: "registration-invite:redeem", targetUserId: user.id });
      return { kind: "created" as const };
    });
  }

  async setUserStatus(telegramUserId: number, status: "active" | "disabled"): Promise<void> {
    const [user] = await this.database.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
    if (!user) throw new Error("user not found");
    await this.database.db.transaction(async (tx) => {
      const now = new Date();
      await tx.update(users).set({
        status,
        updatedAt: now,
        ...(status === "active" ? { deletionRequestedAt: null, deleteAfter: null } : {}),
      }).where(eq(users.id, user.id));

      if (status === "disabled") await suppressPendingForUser(tx, user.id);
      else await restoreFutureAccessSuppressed(tx, user.id, now);

      await tx.insert(adminAuditLog).values({ action: status === "active" ? "users:restore" : "users:disable", targetUserId: user.id });
    });
  }

  async setAiStatus(telegramUserId: number, status: "enabled" | "suspended"): Promise<void> {
    const [user] = await this.database.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
    if (!user) throw new Error("user not found");
    await this.database.db.transaction(async (tx) => {
      await tx.update(users).set({ aiStatus: status, updatedAt: new Date() }).where(eq(users.id, user.id));
      await tx.insert(adminAuditLog).values({ action: status === "enabled" ? "ai:enable" : "ai:suspend", targetUserId: user.id });
    });
  }

  async requestDeletion(telegramUserId: number, now = new Date()): Promise<Date> {
    const [user] = await this.database.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
    if (!user) throw new Error("user not found");
    if (user.status !== "active") throw new Error("only an active account can request deletion");
    const deleteAfter = new Date(now.getTime() + DELETION_GRACE_MS);
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx.update(users).set({
        status: "deletion_pending",
        deletionRequestedAt: now,
        deleteAfter,
        updatedAt: now,
      }).where(and(eq(users.id, user.id), eq(users.status, "active"))).returning({ id: users.id });
      if (!updated) throw new Error("account state changed");
      await suppressPendingForUser(tx, user.id);
      await tx.insert(adminAuditLog).values({ action: "users:delete-request", targetUserId: user.id });
    });
    return deleteAfter;
  }

  async restoreDeletion(telegramUserId: number, now = new Date()): Promise<boolean> {
    const [user] = await this.database.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
    if (!user || user.status !== "deletion_pending" || !user.deleteAfter || user.deleteAfter <= now) return false;
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx.update(users).set({
        status: "active",
        deletionRequestedAt: null,
        deleteAfter: null,
        updatedAt: now,
      }).where(and(
        eq(users.id, user.id),
        eq(users.status, "deletion_pending"),
        gt(users.deleteAfter, now),
      )).returning({ id: users.id });
      if (!updated) throw new Error("account state changed");
      await restoreFutureAccessSuppressed(tx, user.id, now);
      await tx.insert(adminAuditLog).values({ action: "users:delete-restore", targetUserId: user.id });
    });
    return true;
  }

  async finalizeExpiredDeletions(now = new Date()): Promise<number> {
    const expired = await this.database.db.select({ id: users.id }).from(users).where(and(
      eq(users.status, "deletion_pending"),
      lte(users.deleteAfter, now),
    ));
    let deleted = 0;
    for (const user of expired) {
      await this.database.db.transaction(async (tx) => {
        await tx.insert(adminAuditLog).values({ action: "users:delete-finalize", targetUserId: user.id });
        const rows = await tx.delete(users).where(and(
          eq(users.id, user.id),
          eq(users.status, "deletion_pending"),
          lte(users.deleteAfter, now),
        )).returning({ id: users.id });
        if (rows.length) deleted += 1;
      });
    }
    return deleted;
  }
}

type DbTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

async function suppressPendingForUser(tx: DbTransaction, userId: string): Promise<void> {
  await tx.update(reminderDeliveries)
    .set({ status: "suppressed", suppressedReason: "access" })
    .where(and(eq(reminderDeliveries.recipientUserId, userId), inArray(reminderDeliveries.status, ["pending", "processing"])));
  await tx.update(briefingDeliveries)
    .set({ status: "suppressed", suppressedReason: "access" })
    .where(and(eq(briefingDeliveries.recipientUserId, userId), inArray(briefingDeliveries.status, ["pending", "processing"])));
}

async function restoreFutureAccessSuppressed(tx: DbTransaction, userId: string, now: Date): Promise<void> {
  await tx.update(reminderDeliveries)
    .set({ status: "pending", suppressedReason: null })
    .where(and(
      eq(reminderDeliveries.recipientUserId, userId),
      eq(reminderDeliveries.status, "suppressed"),
      eq(reminderDeliveries.suppressedReason, "access"),
      gt(reminderDeliveries.scheduledFor, now),
    ));
  await tx.update(briefingDeliveries)
    .set({ status: "pending", suppressedReason: null })
    .where(and(
      eq(briefingDeliveries.recipientUserId, userId),
      eq(briefingDeliveries.status, "suppressed"),
      eq(briefingDeliveries.suppressedReason, "access"),
      gt(briefingDeliveries.scheduledFor, now),
    ));
}
