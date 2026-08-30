/**
 * /api/uploads
 *
 *   POST  open a draft capture — reserves the folder, returns an id to upload into
 *
 * The bytes do not come here. This call is metadata only, so the folder exists
 * and has a name before half a gigabyte starts moving; ./[id]/route.ts takes
 * the files one at a time. See ./drafts.ts for why the flow is split.
 */

import { UploadError, createDraft } from './drafts';
import { errorResponse, readJson } from './respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) {
    return errorResponse(
      new UploadError({ field: 'draft', message: 'Could not read the request body.' }),
    );
  }

  try {
    const draft = await createDraft({
      name: typeof body.name === 'string' ? body.name : '',
      description: typeof body.description === 'string' ? body.description : '',
    });
    return Response.json({ draft }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
