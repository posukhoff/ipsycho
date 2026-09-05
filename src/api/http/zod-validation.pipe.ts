import { Injectable, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { ApiError } from "./api-error.js";

/**
 * Parameter-scoped validation: `@Body(zodBody(CreateTaskRequestSchema))`.
 *
 * Deliberately not a global pipe. A global one would also sit in front of `/health` and `/ready`,
 * and the whole point of `WEBAPP_ENABLED=false` is that nothing outside `src/api/**` changes shape
 * when the flag moves. Attaching the schema at the parameter also means the schema is visible at
 * the call site, which is where a reviewer looks for it.
 *
 * On failure it raises `validation_failed` with the field paths only. zod's messages are helpful
 * and are exactly the thing that must not travel: `"expected string, received <the value>"` is a
 * reflection of the request.
 */
@Injectable()
export class ZodValidationPipe<Schema extends z.ZodTypeAny> implements PipeTransform<unknown, z.infer<Schema>> {
  constructor(private readonly schema: Schema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<Schema> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw ApiError.validationFailed(result.error.issues.map((issue) => issue.path.join(".")));
  }
}

export function zodBody<Schema extends z.ZodTypeAny>(schema: Schema): ZodValidationPipe<Schema> {
  return new ZodValidationPipe(schema);
}

/** Query strings arrive as strings; the query schemas coerce, so the same pipe serves both. */
export function zodQuery<Schema extends z.ZodTypeAny>(schema: Schema): ZodValidationPipe<Schema> {
  return new ZodValidationPipe(schema);
}

export function zodParam<Schema extends z.ZodTypeAny>(schema: Schema): ZodValidationPipe<Schema> {
  return new ZodValidationPipe(schema);
}
