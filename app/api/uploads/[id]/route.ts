/**
 * /api/uploads/<id>
 *
 *   GET     where a draft has got to, and what has been measured off it
 *   PUT     stream one file into it — ?slot=splat|collider|thumbnail
 *   POST    finish: write scene.json and turn the folder into a capture
 *   DELETE  abandon it and delete the bytes
 *
 * The PUT body is the file itself, not a multipart part. That is the whole
 * point: `request.body` is a stream, so a 600 MB splat goes to disk a chunk at
 * a time instead of through the heap, and the browser gets real upload progress
 * out of XHR rather than a spinner (see components/home/UploadForm.tsx).
 *
 * A 404 from any of these means either "no such draft" or "this server has
 * restarted since you started" — the client cannot tell them apart, and treats
 * both as "start again".
 */

import { discardDraft, finishDraft, getDraft, stageFile, UploadError } from '../drafts';
import { errorResponse, readJson } from '../respond';
import { isCaptureOrientation, isUploadSlot } from '../limits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* Uploading half a gigabyte and then measuring it is minutes, not seconds. The
   dev server does not enforce this; a deployment platform does. */
export const maxDuration = 600;

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const draft = getDraft(id);
  if (!draft) return errorResponse(missing());
  return Response.json({ draft });
}

export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const slot = url.searchParams.get('slot') ?? '';
  const filename = url.searchParams.get('filename') ?? '';

  if (!isUploadSlot(slot)) {
    return errorResponse(
      new UploadError({ field: 'draft', message: `Unknown upload slot "${slot}".` }),
    );
  }
  if (!filename) {
    return errorResponse(
      new UploadError({ field: slot, message: 'The upload named no file.' }),
    );
  }

  try {
    const draft = await stageFile(id, slot, filename, request.body);
    return Response.json({ draft });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const body = (await readJson(request)) ?? {};

  const orientation = body.orientation;
  if (!isCaptureOrientation(orientation)) {
    return errorResponse(
      new UploadError({
        field: 'splat',
        message: 'Choose which way up the splat was authored before finishing.',
      }),
    );
  }

  try {
    const result = await finishDraft(id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      orientation,
      // Absent means fitted: the alignment is the reason this flow measures
      // anything, and opting out of it is the deliberate choice.
      fit: body.fit !== false,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;
  const removed = await discardDraft(id);
  if (!removed) return errorResponse(missing());
  return Response.json({ ok: true });
}

function missing(): UploadError {
  return new UploadError({
    field: 'draft',
    message: 'This upload is no longer open.',
    hint: 'The server restarted, or it sat unfinished for two hours.',
    status: 404,
  });
}
