import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";

/** Persists genuine, measured progress for a running job (polled by the UI). */
export async function reportProgress(jobId: string, stage: string, progress: number, message?: string) {
  await db
    .update(jobs)
    .set({
      stage,
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      message: message ?? null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId));
}
