import { Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, isNotNull, lte, or } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { actionEvents, actionGroups, pendingActions } from "../database/schema.js";

@Injectable()
export class ActionsRepository {
  constructor(private readonly database: DatabaseService) {}

  async createImmediateGroup(input: {
    id: string;
    workspaceId: string;
    actorUserId: string;
    sourceMessageId?: string;
  }): Promise<void> {
    await this.database.db.insert(actionGroups).values({
      id: input.id,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      status: "applying",
      requiresConfirmation: false,
    });
  }

  async createPendingGroup(input: {
    id: string;
    workspaceId: string;
    actorUserId: string;
    sourceMessageId?: string;
    expiresAt: Date;
    actions: Array<{ id: string; actionType: string; payload: unknown }>;
  }): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.insert(actionGroups).values({
        id: input.id,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        status: "pending",
        requiresConfirmation: true,
      });
      await tx.insert(pendingActions).values(input.actions.map((action) => ({
        id: action.id,
        workspaceId: input.workspaceId,
        groupId: input.id,
        actorUserId: input.actorUserId,
        actionType: action.actionType,
        payload: action.payload,
        expiresAt: input.expiresAt,
      })));
    });
  }

  async claimPendingGroup(workspaceId: string, actorUserId: string, groupId: string, now: Date) {
    const [claimed] = await this.database.db.update(actionGroups).set({ status: "applying" })
      .where(and(
        eq(actionGroups.workspaceId, workspaceId),
        eq(actionGroups.id, groupId),
        eq(actionGroups.actorUserId, actorUserId),
        eq(actionGroups.status, "pending"),
      )).returning();
    if (!claimed) return null;

    const actions = await this.database.db.select().from(pendingActions).where(and(
      eq(pendingActions.workspaceId, workspaceId),
      eq(pendingActions.groupId, groupId),
    ));
    if (!actions.length || actions.some((action) => action.expiresAt <= now)) {
      await this.database.db.transaction(async (tx) => {
        await tx.update(actionGroups).set({ status: "expired" }).where(and(eq(actionGroups.workspaceId, workspaceId), eq(actionGroups.id, groupId)));
        await tx.delete(pendingActions).where(and(eq(pendingActions.workspaceId, workspaceId), eq(pendingActions.groupId, groupId)));
      });
      return null;
    }
    return { group: claimed, actions };
  }

  async cancelPendingGroup(workspaceId: string, actorUserId: string, groupId: string): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const [cancelled] = await tx.update(actionGroups).set({ status: "cancelled" }).where(and(
        eq(actionGroups.workspaceId, workspaceId),
        eq(actionGroups.id, groupId),
        eq(actionGroups.actorUserId, actorUserId),
        eq(actionGroups.status, "pending"),
      )).returning({ id: actionGroups.id });
      if (!cancelled) return false;
      await tx.delete(pendingActions).where(and(
        eq(pendingActions.workspaceId, workspaceId),
        eq(pendingActions.groupId, groupId),
      ));
      return true;
    });
  }

  async finalizeApplied(input: {
    workspaceId: string;
    groupId: string;
    undoExpiresAt: Date;
    events: Array<{ actionType: string; entityType: string; entityId: string; postVersion?: number; afterState?: unknown }>;
  }): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      if (input.events.length) {
        await tx.insert(actionEvents).values(input.events.map((event) => ({
          workspaceId: input.workspaceId,
          groupId: input.groupId,
          actionType: event.actionType,
          entityType: event.entityType,
          entityId: event.entityId,
          ...(event.postVersion !== undefined ? { postVersion: event.postVersion } : {}),
          ...(event.afterState !== undefined ? { afterState: event.afterState } : {}),
        })));
      }
      await tx.delete(pendingActions).where(and(
        eq(pendingActions.workspaceId, input.workspaceId),
        eq(pendingActions.groupId, input.groupId),
      ));
      const [updated] = await tx.update(actionGroups).set({
        status: "applied",
        appliedAt: new Date(),
        undoExpiresAt: input.undoExpiresAt,
      }).where(and(
        eq(actionGroups.workspaceId, input.workspaceId),
        eq(actionGroups.id, input.groupId),
        eq(actionGroups.status, "applying"),
      )).returning({ id: actionGroups.id });
      if (!updated) throw new Error("action group is not claimable as applied");
    });
  }

  async markFailed(workspaceId: string, groupId: string): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.update(actionGroups).set({ status: "failed" }).where(and(
        eq(actionGroups.workspaceId, workspaceId),
        eq(actionGroups.id, groupId),
        eq(actionGroups.status, "applying"),
      ));
      await tx.delete(pendingActions).where(and(
        eq(pendingActions.workspaceId, workspaceId),
        eq(pendingActions.groupId, groupId),
      ));
    });
  }

  async claimUndo(workspaceId: string, actorUserId: string, groupId: string, now: Date) {
    const [group] = await this.database.db.update(actionGroups).set({ status: "undoing" }).where(and(
      eq(actionGroups.workspaceId, workspaceId),
      eq(actionGroups.id, groupId),
      eq(actionGroups.actorUserId, actorUserId),
      eq(actionGroups.status, "applied"),
      gt(actionGroups.undoExpiresAt, now),
    )).returning();
    if (!group) return null;
    const events = await this.database.db.select().from(actionEvents).where(and(
      eq(actionEvents.workspaceId, workspaceId),
      eq(actionEvents.groupId, groupId),
    ));
    return { group, events };
  }

  async releaseUndoClaim(workspaceId: string, groupId: string): Promise<void> {
    await this.database.db.update(actionGroups).set({ status: "applied" }).where(and(
      eq(actionGroups.workspaceId, workspaceId),
      eq(actionGroups.id, groupId),
      eq(actionGroups.status, "undoing"),
    ));
  }

  async finalizeUndo(workspaceId: string, groupId: string): Promise<void> {
    const [updated] = await this.database.db.update(actionGroups).set({ status: "undone", undoneAt: new Date() }).where(and(
      eq(actionGroups.workspaceId, workspaceId),
      eq(actionGroups.id, groupId),
      eq(actionGroups.status, "undoing"),
    )).returning({ id: actionGroups.id });
    if (!updated) throw new Error("undo group is not in progress");
  }

  async listEventsForGroup(workspaceId: string, groupId: string) {
    return this.database.db.select().from(actionEvents).where(and(
      eq(actionEvents.workspaceId, workspaceId),
      eq(actionEvents.groupId, groupId),
    ));
  }

  async expirePendingGroups(now = new Date()): Promise<number> {
    const expired = await this.database.db.select({ id: pendingActions.id, groupId: pendingActions.groupId })
      .from(pendingActions).where(lte(pendingActions.expiresAt, now));
    if (!expired.length) return 0;
    const groupIds = [...new Set(expired.map((row) => row.groupId))];
    await this.database.db.transaction(async (tx) => {
      await tx.update(actionGroups).set({ status: "expired" }).where(and(
        inArray(actionGroups.id, groupIds),
        eq(actionGroups.status, "pending"),
      ));
      await tx.delete(pendingActions).where(inArray(pendingActions.groupId, groupIds));
    });
    return groupIds.length;
  }

  async listRecoveryGroups() {
    return this.database.db.select().from(actionGroups).where(inArray(actionGroups.status, ["applying", "undoing"]));
  }

  async scrubExpiredActionPayloads(now = new Date()): Promise<number> {
    const groups = await this.database.db.select({ id: actionGroups.id }).from(actionGroups).where(or(
      and(
        eq(actionGroups.status, "applied"),
        isNotNull(actionGroups.undoExpiresAt),
        lte(actionGroups.undoExpiresAt, now),
      ),
      inArray(actionGroups.status, ["undone", "failed", "expired", "cancelled"]),
    ));
    if (!groups.length) return 0;
    const ids = groups.map((group) => group.id);
    const changed = await this.database.db.update(actionEvents).set({ beforeState: null, afterState: null }).where(and(
      inArray(actionEvents.groupId, ids),
      or(isNotNull(actionEvents.beforeState), isNotNull(actionEvents.afterState)),
    )).returning({ id: actionEvents.id });
    return changed.length;
  }

}
