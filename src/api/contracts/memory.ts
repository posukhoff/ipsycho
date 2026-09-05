import { z } from "zod";
import { IsoInstantSchema, MemoryTypeSchema, PageInfoSchema, PageQuerySchema, TEXT_LIMITS, UuidSchema, VersionSchema } from "./primitives.js";

/**
 * What the bot remembers, and the durable personal profile.
 *
 * A sensitive fact is deliberately kept out of the model's context, which also kept it off every
 * screen — the user could not see, correct or delete what the bot had been told to remember. This
 * contract carries the marking through and requires an explicit confirmation to write one, so a
 * screen cannot quietly change a fact it is not showing in full.
 *
 * `GET /profile` is the same row shape filtered to `type: "context"`: it is the read side of
 * `/context`, not a second store.
 */

export const MemoryRowSchema = z
  .object({
    id: UuidSchema,
    version: VersionSchema,
    type: MemoryTypeSchema,
    content: z.string().max(TEXT_LIMITS.memoryContent),
    /** Hidden from the model, shown to the user, and confirmed on every write. */
    sensitive: z.boolean(),
    /** Where it came from: `ai`, `user`, `onboarding` … A token, rendered by the client. */
    source: z.string().max(32),
    updatedAt: IsoInstantSchema,
    createdAt: IsoInstantSchema,
  })
  .strict();

export const MemoryQuerySchema = PageQuerySchema.extend({
  /** Null lists everything, newest first, sensitive entries included. */
  type: MemoryTypeSchema.optional(),
}).strict();

export const MemoryResponseSchema = z
  .object({
    rows: z.array(MemoryRowSchema),
    page: PageInfoSchema,
    /** How many of the total are sensitive, so the screen can say so without counting a page. */
    sensitiveCount: z.number().int().min(0),
  })
  .strict();

export const MemoryPatchRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    content: z.string().min(1).max(TEXT_LIMITS.memoryContent).nullable(),
    type: MemoryTypeSchema.nullable(),
    sensitive: z.boolean().nullable(),
    /**
     * Required when the entry is sensitive now or becomes sensitive. Without it the write is
     * refused, the same explicit confirmation the chat asks for before touching a sensitive fact.
     */
    confirmSensitive: z.boolean(),
  })
  .strict();

export const MemoryDeleteRequestSchema = z
  .object({
    expectedVersion: VersionSchema,
    confirmSensitive: z.boolean(),
  })
  .strict();

export const MemoryMutationResponseSchema = z.object({ item: MemoryRowSchema.nullable(), undoGroupId: UuidSchema.nullable() }).strict();

/** The durable personal context: `memory_items` of type `context`, newest first. */
export const ProfileResponseSchema = z
  .object({
    rows: z.array(MemoryRowSchema),
    /** Null until the user has been invited to build a profile at least once. */
    invitedAt: IsoInstantSchema.nullable(),
  })
  .strict();

export type MemoryRow = z.infer<typeof MemoryRowSchema>;
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;
export type MemoryPatchRequest = z.infer<typeof MemoryPatchRequestSchema>;
export type MemoryDeleteRequest = z.infer<typeof MemoryDeleteRequestSchema>;
export type MemoryMutationResponse = z.infer<typeof MemoryMutationResponseSchema>;
export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;
