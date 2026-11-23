import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { HttpError, handle, jsonOk } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/data";
import { enqueueJob } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";

/** POST: queues the AI analysis pipeline for an uploaded project. */
export const POST = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireUser();
  const { id } = await params;
  const project = await getOwnedProject(user.id, id);
  if (!project.rightsConfirmedAt) throw new HttpError(403, "Confirm your content rights before analysis.");
  if (!project.videoPath) throw new HttpError(400, "Upload your own video file before running analysis.");

  const active = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.projectId, project.id), eq(jobs.type, "analyze"), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  if (active.length) throw new HttpError(409, "Analysis is already running for this project.");

  const job = await enqueueJob({ userId: user.id, type: "analyze", projectId: project.id });
  return jsonOk({ job }, 202);
});
