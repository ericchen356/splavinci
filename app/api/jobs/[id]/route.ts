/**
 * /api/jobs/<id>
 *
 *   GET     where a render build has got to
 *   DELETE  stop it
 *
 * The job lives in an in-process map (app/api/renders/jobs.ts), so a 404 here
 * means either "no such job" or "this server restarted since you started it" —
 * the client cannot tell them apart and treats both as "stop polling".
 *
 * DELETE exists because a Marble generation is billed. Starting one by mistake
 * and having no way to stop it is the expensive kind of dead end.
 */

import { cancelJob, getJob } from '../../renders/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = getJob(id);
  if (!job) return Response.json({ error: 'No such job.' }, { status: 404 });
  return Response.json({ job });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = cancelJob(id);
  if (!job) return Response.json({ error: 'No such job.' }, { status: 404 });
  return Response.json({ job });
}
