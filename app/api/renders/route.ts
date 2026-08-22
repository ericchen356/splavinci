/**
 * /api/renders
 *
 *   GET   every capture on this machine, built-in and generated
 *   POST  start a new Marble build; answers 202 with a job id, never the render
 *
 * The POST does not wait. A generation is minutes long, so the request's whole
 * job is to validate the upload and hand back something to poll — see
 * ./jobs.ts for why, and /api/jobs/[id] for the other half.
 */

import { listRenders } from '@/lib/renders';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_KEYWORDS_CHARS,
  MAX_NAME_CHARS,
  type CandidateFile,
  type FieldError,
  validateUpload,
} from './limits';
import { startRenderJob, type IncomingFile } from './jobs';

/** Reads the filesystem on every call; a cached copy would hide a new render. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const renders = await listRenders();
  return Response.json({ renders });
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { errors: [{ field: 'photos', message: 'Could not read the upload.' }] satisfies FieldError[] },
      { status: 400 },
    );
  }

  const photoFiles = form.getAll('photos').filter(isFile);
  /* One clip, not a list. Frames from two different walks are two different
     moments of a room asserted to be one view set, which is the collage
     multi-image reconstruction is worst at. */
  const videoFile = form.getAll('video').filter(isFile)[0] ?? null;
  const blueprintFile = form.getAll('blueprint').filter(isFile)[0] ?? null;
  const description = readText(form, 'description', MAX_DESCRIPTION_CHARS * 2);
  const keywords = readText(form, 'keywords', MAX_KEYWORDS_CHARS * 2);
  const name = readText(form, 'name', MAX_NAME_CHARS * 2);

  const errors = validateUpload({
    photos: photoFiles.map(toCandidate),
    video: videoFile ? toCandidate(videoFile) : null,
    blueprint: blueprintFile ? toCandidate(blueprintFile) : null,
    description,
    keywords,
    name,
  });
  if (errors.length > 0) return Response.json({ errors }, { status: 400 });

  // Read only after validation: buffering eight rejected photos and a rejected
  // 200 MB clip would be the one expensive thing this handler does, done for
  // nothing.
  const photos = await Promise.all(photoFiles.map(readIncoming));
  const video = videoFile ? await readIncoming(videoFile) : null;
  const blueprint = blueprintFile ? await readIncoming(blueprintFile) : null;

  const job = await startRenderJob({ name, description, keywords, photos, video, blueprint });

  return Response.json({ job }, { status: 202 });
}

function isFile(value: FormDataEntryValue): value is File {
  return typeof value === 'object' && value !== null && 'arrayBuffer' in value;
}

function toCandidate(file: File): CandidateFile {
  return { name: file.name, size: file.size };
}

async function readIncoming(file: File): Promise<IncomingFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Truncated rather than rejected on length; `validateUpload` owns the verdict. */
function readText(form: FormData, key: string, cap: number): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.slice(0, cap) : '';
}
