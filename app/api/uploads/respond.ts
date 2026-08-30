/**
 * One error shape for the upload routes.
 *
 * The upload form marks the field that caused a failure, exactly as the create
 * form does, so every failure that reaches the browser has to name a field.
 * `UploadError` carries one; anything else that escapes a handler is a bug
 * rather than a rejected upload, and is reported as such against the draft
 * instead of being attributed to a file the user chose.
 *
 * SERVER ONLY.
 */

import { UploadError } from './drafts';

export type UploadErrorBody = {
  field: UploadError['field'];
  message: string;
  hint: string | null;
};

export function errorResponse(error: unknown): Response {
  if (error instanceof UploadError) {
    return Response.json(
      { errors: [{ field: error.field, message: error.message, hint: error.hint }] },
      { status: error.status },
    );
  }
  return Response.json(
    {
      errors: [
        {
          field: 'draft' as const,
          message: error instanceof Error ? error.message : String(error),
          hint: null,
        },
      ],
    },
    { status: 500 },
  );
}

/** Parsed JSON body, or null when the request did not carry one. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
