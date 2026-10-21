// Request validation. Everything the client sends is checked here with zod; the
// browser's checks only exist to give quick feedback.

import type { z } from 'zod';

/** An error the client caused; becomes a JSON response with this status (plus `extra` fields). */
export class HttpError extends Error {
  constructor(public status: number, message: string, public field?: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export function badRequest(message: string, field?: string): HttpError {
  return new HttpError(400, message, field);
}

/** Parse with a zod schema; the first issue becomes a 400 naming its field. */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw badRequest(issue?.message ?? 'Invalid request.', issue?.path.join('.') || undefined);
}
